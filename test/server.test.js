import { once } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { LinkedInError } from "../src/linkedin.js";
import { createApp } from "../src/server.js";
import { openStore } from "../src/store.js";

const password = "test-only operator passphrase";
const encryptionKey = "4a".repeat(32);

async function fixture(t, overrides = {}) {
  const config = loadConfig({
    SOCIAL_DESK_PASSWORD: password,
    SOCIAL_DESK_ENCRYPTION_KEY: encryptionKey,
  });
  const store = openStore({ filename: ":memory:", key: config.key });
  const defaultProvider = {
    authorizeUrl: (state) => `https://www.linkedin.com/oauth/v2/authorization?state=${state}`,
    async exchangeCode(code) {
      assert.equal(code, "test-code");
      return {
        accessToken: "test-provider-token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
    },
    async verifyOrganization(_token, id) {
      return { id, name: "Example Company", pageUrl: `https://www.linkedin.com/company/${id}/` };
    },
    async publish() {
      return { urn: "urn:li:share:1", url: "https://www.linkedin.com/feed/update/urn:li:share:1/" };
    },
    async report() {
      return { from: "2026-01-01", to: "2026-01-08", totals: null, posts: [], warnings: [] };
    },
    async listPosts() {
      return [];
    },
  };
  const server = createApp({ config, store, linkedin: { ...defaultProvider, ...overrides } });
  server.listen(0, config.host);
  await once(server, "listening");
  config.origin.port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  const base = config.origin.origin;
  let cookie;
  function req(path, { method = "GET", body, origin = base, authenticated = true } = {}) {
    const headers = {};
    if (method !== "GET") headers.origin = origin;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (authenticated && cookie) headers.cookie = cookie;
    return fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
  }
  async function json(path, body, method = "POST") {
    const response = await req(path, { method, body });
    assert.ok(response.ok, `${path} returned ${response.status}: ${await response.clone().text()}`);
    return response.json();
  }
  async function login() {
    const response = await req("/api/login", { method: "POST", body: { password } });
    assert.equal(response.status, 200);
    const header = response.headers.get("set-cookie");
    assert.match(header, /HttpOnly; SameSite=Lax/);
    cookie = header.split(";")[0];
  }
  async function newProject(name = "Example project", organizationId = "10001") {
    return json("/api/projects", { name, organizationId });
  }
  async function connect(project) {
    const result = await json(`/api/projects/${project.id}/connect`, {});
    const { searchParams } = new URL(result.authorizeUrl);
    const state = searchParams.get("state");
    const callback = `/oauth/linkedin/callback?state=${state}&code=test-code`;
    const response = await req(callback);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `/?project=${project.id}&linkedin=connected`);
    return callback;
  }
  return { req, json, login, newProject, connect, store };
}

test("configuration rejects a public HTTP listener and requires an independent encryption key", () => {
  const secrets = { SOCIAL_DESK_PASSWORD: password, SOCIAL_DESK_ENCRYPTION_KEY: encryptionKey };
  assert.throws(() => loadConfig({ ...secrets, HOST: "0.0.0.0" }), /loopback/);
  assert.throws(() => loadConfig({ ...secrets, APP_ORIGIN: "http://app.example.com" }), /HTTPS/);
  assert.throws(
    () => loadConfig({ ...secrets, SOCIAL_DESK_ENCRYPTION_KEY: "" }),
    /32 random bytes/,
  );
  assert.throws(() => loadConfig({ ...secrets, LINKEDIN_CLIENT_ID: "example" }), /both LinkedIn/);
  const remote = loadConfig({ ...secrets, APP_ORIGIN: "https://desk.example.com" });
  assert.equal(remote.secureCookie, true);
  assert.equal(remote.host, "127.0.0.1");
});

test("sign-in is required for operational data and writes are same-origin only", async (t) => {
  const app = await fixture(t);
  const index = await app.req("/");
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal((await app.req("/api/projects")).status, 401);
  assert.equal(
    (
      await app.req("/api/login", {
        method: "POST",
        origin: "https://example.com",
        body: { password },
      })
    ).status,
    403,
  );
  await app.login();
  const result = await app.req("/api/projects", {
    method: "POST",
    origin: "https://example.com",
    body: { name: "Example" },
  });
  assert.equal(result.status, 403);
  assert.deepEqual(await (await app.req("/api/projects")).json(), []);
  assert.equal((await app.req("/api/logout", { method: "POST" })).status, 200);
  assert.equal((await app.req("/api/projects")).status, 401);
});

test("OAuth binds the exact project Page and consumes state only once", async (t) => {
  let verified = [];
  const app = await fixture(t, {
    async verifyOrganization(token, id) {
      verified.push([token, id]);
      return { id, name: "Example Page", pageUrl: `https://www.linkedin.com/company/${id}/` };
    },
  });
  await app.login();
  const project = await app.newProject();
  const falseState = "/oauth/linkedin/callback?state=unrecognized&code=test-code";
  assert.equal((await app.req(falseState)).status, 400);
  const callback = await app.connect(project);
  assert.equal((await app.req(callback)).status, 400);
  assert.deepEqual(verified, [["test-provider-token", project.organizationId]]);
  const projects = await (await app.req("/api/projects")).text();
  assert.match(projects, /"connection":"connected"/);
  assert.doesNotMatch(projects, /test-provider-token/);
  assert.equal(
    (await app.req(`/api/projects/${project.id}/connection`, { method: "DELETE" })).status,
    200,
  );
  assert.equal(app.store.getCredentials(project.id), null);
});

test("drafts stay in their project and concurrent publish requests send only once", async (t) => {
  let creates = 0;
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const app = await fixture(t, {
    async publish(_token, id, draft) {
      assert.equal(id, "10001");
      assert.equal(draft.body, "Our fictional update.");
      creates++;
      enter();
      await pending;
      return { url: "https://www.linkedin.com/feed/update/urn:li:share:1/" };
    },
  });
  await app.login();
  const first = await app.newProject();
  const second = await app.newProject("Other project", "10002");
  await app.connect(first);
  const base = `/api/projects/${first.id}/drafts`;
  const draft = await app.json(base, { body: "Our fictional update." });
  const otherResult = await app.req(`/api/projects/${second.id}/drafts/${draft.id}`, {
    method: "PATCH",
    body: { revision: draft.revision, body: "Editing the wrong project" },
  });
  assert.equal(otherResult.status, 404);
  const uri = `${base}/${draft.id}/publish`;
  const options = { method: "POST", body: { revision: draft.revision } };
  const firstPost = app.req(uri, options);
  await entered;
  try {
    assert.equal((await app.req(uri, options)).status, 409);
  } finally {
    finish();
  }
  const uploaded = await (await firstPost).json();
  assert.equal(uploaded.status, "published");
  assert.equal(creates, 1);
  assert.match(uploaded.postUrl, /urn:li:share:1/);
});

test("ambiguous publication is held and reconciled against the correct page and text", async (t) => {
  let creates = 0;
  const app = await fixture(t, {
    async publish() {
      creates++;
      throw new LinkedInError("The response was lost", { uncertain: true });
    },
    async listPosts(_token, id) {
      assert.equal(id, "10001");
      return [
        {
          body: "Fictional reconciliation test",
          linkUrl: null,
          publishedAt: new Date().toISOString(),
          url: "https://www.linkedin.com/feed/update/urn:li:share:2/",
        },
      ];
    },
  });
  await app.login();
  const project = await app.newProject();
  await app.connect(project);
  const base = `/api/projects/${project.id}/drafts`;
  const draft = await app.json(base, { body: "Fictional reconciliation test" });
  const path = `${base}/${draft.id}`;
  const result = await app.json(path + "/publish", { revision: draft.revision });
  assert.equal(result.status, "needs_review");
  assert.equal(
    (await app.req(path + "/publish", { method: "POST", body: { revision: result.revision } }))
      .status,
    409,
  );
  const reconciled = await app.json(path + "/reconcile", {});
  assert.equal(reconciled.status, "published");
  assert.equal(creates, 1);
});

test("disconnect invalidates a LinkedIn authorization already in flight", async (t) => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const verifying = new Promise((resolve) => {
    entered = resolve;
  });
  const app = await fixture(t, {
    async verifyOrganization(_token, id) {
      entered();
      await wait;
      return { id, name: "Example Company", pageUrl: `https://www.linkedin.com/company/${id}/` };
    },
  });
  await app.login();
  const project = await app.newProject();
  const result = await app.json(`/api/projects/${project.id}/connect`, {});
  const state = new URL(result.authorizeUrl).searchParams.get("state");
  const callback = app.req(`/oauth/linkedin/callback?state=${state}&code=test-code`);
  await verifying;
  try {
    assert.equal(
      (await app.req(`/api/projects/${project.id}/connection`, { method: "DELETE" })).status,
      200,
    );
  } finally {
    release();
  }
  assert.match((await callback).headers.get("location"), /linkedin=error$/);
  assert.equal(app.store.getCredentials(project.id), null);
});
