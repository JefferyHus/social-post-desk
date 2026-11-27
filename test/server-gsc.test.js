import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { openStore } from "../src/store.js";
async function fixture(t, overrides = {}) {
  const config = loadConfig({
      SOCIAL_DESK_PASSWORD: "synthetic-password-long",
      SOCIAL_DESK_ENCRYPTION_KEY: "4a".repeat(32),
    }),
    store = openStore({ filename: ":memory:", key: config.key });
  const gsc = {
    authorizeUrl: ({ state }) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    async exchangeCode() {
      return {
        accessToken: "fake-access",
        refreshToken: "fake-refresh",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
    },
    async listSites() {
      return [
        { siteUrl: "sc-domain:example.org", permissionLevel: "siteOwner" },
        { siteUrl: "https://example.org/", permissionLevel: "siteFullUser" },
      ];
    },
    async refresh() {
      return {
        accessToken: "fake-access",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
    },
    async report(_t, siteUrl, days) {
      return {
        siteUrl,
        days,
        totals: null,
        daily: [],
        queries: [],
        pages: [],
        warnings: [],
      };
    },
  };
  Object.assign(gsc, overrides);
  const server = createApp({ config, store, linkedin: null, ga4: null, gsc });
  server.listen(0, config.host);
  await once(server, "listening");
  config.origin.port = server.address().port;
  const base = config.origin.origin;
  let cookie;
  const req = async (path, method = "GET", body) =>
    fetch(base + path, {
      method,
      redirect: "manual",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method !== "GET" ? { origin: base } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.close();
  });
  const login = await req("/api/login", "POST", {
    password: "synthetic-password-long",
  });
  cookie = login.headers.get("set-cookie").split(";")[0];
  const project = async (name) =>
    (await req("/api/projects", "POST", { name, organizationId: null })).json();
  return { req, project, store };
}
test("authorized property selection is project bound; disconnect preserves GA4", async (t) => {
  const f = await fixture(t),
    a = await f.project("A"),
    b = await f.project("B");
  f.store.setGa4Connection(a.id, {
    propertyId: "123",
    refreshToken: "ga4-secret",
  });
  const open = await f.req(`/api/projects/${a.id}/gsc/connect`, "POST", {}),
    u = new URL((await open.json()).authorizeUrl),
    state = u.searchParams.get("state");
  const cb = await f.req(
    `/oauth/google/search-console/callback?state=${state}&code=demo`,
  );
  assert.match(cb.headers.get("location"), /gsc=select/);
  assert.equal((await f.req(`/api/projects/${b.id}/gsc/sites`)).status, 409);
  assert.equal(
    (
      await f.req(`/api/projects/${a.id}/gsc/select`, "POST", {
        siteUrl: "sc-domain:untrusted.example",
      })
    ).status,
    409,
  );
  const sites = await (await f.req(`/api/projects/${a.id}/gsc/sites`)).json();
  assert.equal(sites.sites.length, 2);
  assert.equal(
    (
      await f.req(`/api/projects/${a.id}/gsc/select`, "POST", {
        siteUrl: "sc-domain:example.org",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.req(`/api/projects/${a.id}/gsc/select`, "POST", {
        siteUrl: "sc-domain:example.org",
      })
    ).status,
    409,
  );
  const r = await f.req(`/api/projects/${a.id}/gsc/report?days=7`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).siteUrl, "sc-domain:example.org");
  await f.req(`/api/projects/${a.id}/gsc/connection`, "DELETE");
  assert.equal(f.store.getGscRefreshToken(a.id), null);
  assert.equal(f.store.getGa4RefreshToken(a.id), "ga4-secret");
});

test("URL-prefix selection is accepted and callback replay rejected", async (t) => {
  const f = await fixture(t),
    p = await f.project("Prefix");
  const result = await (
      await f.req(`/api/projects/${p.id}/gsc/connect`, "POST", {})
    ).json(),
    state = new URL(result.authorizeUrl).searchParams.get("state");
  assert.equal(
    (
      await f.req(
        `/oauth/google/search-console/callback?state=${state}&code=demo`,
      )
    ).status,
    303,
  );
  assert.equal(
    (
      await f.req(
        `/oauth/google/search-console/callback?state=${state}&code=demo`,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.req(`/api/projects/${p.id}/gsc/select`, "POST", {
        siteUrl: "https://example.org/",
      })
    ).status,
    200,
  );
  assert.equal(f.store.getGscConnection(p.id).siteUrl, "https://example.org/");
  await f.req(`/api/projects/${p.id}/gsc/connection`, "DELETE");
  const failed = await f.req(`/api/projects/${p.id}/gsc/report?days=28`);
  assert.equal(failed.status, 409);
  assert.equal((await failed.text()).includes("fake-refresh"), false);
});

test("revoked access returns a sanitized error and does not invent data", async (t) => {
  const f = await fixture(t, {
      async refresh() {
        throw new Error("secret token from provider");
      },
    }),
    p = await f.project("Revoked");
  f.store.setGscConnection(p.id, {
    siteUrl: "https://example.org/",
    refreshToken: "synthetic-secret",
  });
  const response = await f.req(`/api/projects/${p.id}/gsc/report?days=28`);
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /permissions/);
  assert.equal(text.includes("secret"), false);
});

test("disconnect cancels in-flight OAuth without affecting an existing GA4 connection", async (t) => {
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    async exchangeCode() {
      entered();
      await wait;
      return {
        accessToken: "temporary",
        refreshToken: "secret",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
    },
  });
  const p = await f.project("Race");
  f.store.setGa4Connection(p.id, {
    propertyId: "123",
    refreshToken: "synthetic-ga4",
  });
  const start = await (
    await f.req(`/api/projects/${p.id}/gsc/connect`, "POST", {})
  ).json();
  const state = new URL(start.authorizeUrl).searchParams.get("state");
  const callback = f.req(
    `/oauth/google/search-console/callback?state=${state}&code=demo`,
  );
  await started;
  assert.equal(
    (await f.req(`/api/projects/${p.id}/gsc/connection`, "DELETE")).status,
    200,
  );
  release();
  const result = await callback;
  assert.match(result.headers.get("location"), /gsc=error/);
  assert.equal(f.store.getGscConnection(p.id), null);
  assert.equal(f.store.getGa4RefreshToken(p.id), "synthetic-ga4");
});
