import test from "node:test";
import assert from "node:assert/strict";
import { createLinkedIn, LinkedInError } from "../src/linkedin.js";

const org = "12345",
  orgUrn = "urn:li:organization:12345",
  urn = "urn:li:share:111111";
const stats = { impressionCount: 10, clickCount: 2, likeCount: 3, commentCount: 4, shareCount: 5 };
const post = {
  id: urn,
  author: orgUrn,
  commentary: "Hello",
  lifecycleState: "PUBLISHED",
  publishedAt: 1700000000000,
};
const reply = (data, status = 200, headers = {}) =>
  new Response(data === null ? null : JSON.stringify(data), { status, headers });
function setup(handler) {
  const calls = [];
  const api = createLinkedIn({
    clientId: "client",
    clientSecret: "not-a-secret",
    redirectUri: "http://localhost:3000/callback",
    version: "202611",
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return handler(new URL(url), init);
    },
  });
  return { api, calls };
}

test("authorization uses provider origin and exact scopes, code exchange stays server-side", async () => {
  const { api, calls } = setup(() => reply({ access_token: "token", expires_in: 3600 }));
  const url = new URL(api.authorizeUrl("random-state"));
  assert.equal(url.origin, "https://www.linkedin.com");
  assert.equal(url.searchParams.get("state"), "random-state");
  assert.equal(
    url.searchParams.get("scope"),
    "r_organization_social w_organization_social rw_organization_admin",
  );
  const result = await api.exchangeCode("code");
  assert.equal(result.accessToken, "token");
  assert.ok(Date.parse(result.expiresAt) > Date.now());
  assert.equal(calls[0].url.origin, "https://www.linkedin.com");
  assert.equal(calls[0].url.pathname, "/oauth/v2/accessToken");
  assert.equal(new URLSearchParams(calls[0].init.body).get("code"), "code");
  assert.equal(calls[0].init.redirect, "manual");
});

test("verifies exact approved administrator and provider organization identity", async () => {
  const { api, calls } = setup((url) =>
    url.pathname.endsWith("organizationAcls")
      ? reply({
          elements: [{ organizationTarget: orgUrn, state: "APPROVED", role: "ADMINISTRATOR" }],
        })
      : reply({ id: 12345, localizedName: "Acme" }),
  );
  assert.deepEqual(await api.verifyOrganization("token", org), {
    id: org,
    name: "Acme",
    pageUrl: "https://www.linkedin.com/company/12345/",
  });
  assert.equal(calls[0].url.searchParams.get("q"), "roleAssignee");
  assert.equal(calls[0].init.headers["Linkedin-Version"], "202611");
  const denied = setup(() =>
    reply({
      elements: [
        { organization: "urn:li:organization:999", state: "APPROVED", role: "ADMINISTRATOR" },
      ],
    }),
  );
  await assert.rejects(denied.api.verifyOrganization("token", org), (e) => e.status === 403);
  assert.equal(denied.calls.length, 1);
});

test("publishes valid post and returns exact LinkedIn URN", async () => {
  const { api, calls } = setup(() => reply(null, 201, { "x-restli-id": urn }));
  const out = await api.publish("token", org, {
    body: "Hello",
    linkUrl: "https://example.org/a",
    linkTitle: "Read",
  });
  assert.equal(out.urn, urn);
  assert.equal(out.url, `https://www.linkedin.com/feed/update/${urn}/`);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.author, orgUrn);
  assert.equal(body.content.article.source, "https://example.org/a");
  assert.equal(calls[0].init.redirect, "manual");
  await assert.rejects(
    api.publish("token", org, { body: "Hello", linkUrl: "javascript:alert(1)", linkTitle: "Read" }),
    LinkedInError,
  );
});

test("uncertain outcomes are distinguished from definite rejection", async () => {
  for (const [handler, uncertain, status] of [
    [
      () => {
        throw new Error("network");
      },
      true,
      null,
    ],
    [() => reply({}, 503), true, 503],
    [() => reply(null, 201), true, 201],
    [() => reply({}, 403), false, 403],
    [() => reply(null, 302, { location: "https://evil.example" }), true, 302],
    [() => reply({}, 408), true, 408],
    [() => reply(null, 200, { "x-restli-id": urn }), true, 200],
  ]) {
    const { api } = setup(handler);
    await assert.rejects(
      api.publish("token", org, { body: "Hello" }),
      (e) => e instanceof LinkedInError && e.uncertain === uncertain && e.status === status,
    );
  }
});

test("lists organization-owned posts using provider created order", async () => {
  const { api, calls } = setup(() =>
    reply({
      elements: [post, { ...post, id: "urn:li:share:222", author: "urn:li:organization:999" }],
    }),
  );
  const posts = await api.listPosts("token", org);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body, "Hello");
  assert.equal(calls[0].url.searchParams.get("sortBy"), "CREATED");
  assert.equal(calls[0].url.searchParams.get("count"), "20");
});

test("report combines daily aggregate and per-post lifetime metrics", async () => {
  const { api, calls } = setup((url) =>
    url.pathname === "/rest/posts"
      ? reply({ elements: [post] })
      : url.searchParams.has("shares")
        ? reply({ elements: [{ share: urn, totalShareStatistics: stats }] })
        : reply({ elements: [{ totalShareStatistics: stats }, { totalShareStatistics: stats }] }),
  );
  const r = await api.report("token", org, 28);
  assert.equal(r.totals.impressions, 20);
  assert.equal(r.posts[0].metrics.reactions, 3);
  assert.match(
    calls[1].url.searchParams.get("timeIntervals"),
    /^\(timeRange:\(start:\d+,end:\d+\),timeGranularityType:DAY\)$/,
  );
  assert.equal(calls[2].url.searchParams.get("shares"), `List(${urn})`);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.from.slice(11), "00:00:00.000Z");
});

test("successful omitted post means zero; permission failures remain unknown", async () => {
  const zero = setup((url) =>
    url.pathname === "/rest/posts" ? reply({ elements: [post] }) : reply({ elements: [] }),
  );
  const z = await zero.api.report("token", org, 28);
  assert.equal(z.totals, null);
  assert.equal(z.posts[0].metrics.impressions, 0);
  const fail = setup((url) =>
    url.pathname === "/rest/posts" ? reply({ elements: [post] }) : reply({}, 403),
  );
  const f = await fail.api.report("token", org, 28);
  assert.equal(f.totals, null);
  assert.equal(f.posts[0].metrics, null);
  assert.equal(f.warnings.length, 2);
});

test("rejects unsafe configuration and malformed identifiers before fetching", async () => {
  assert.throws(
    () =>
      createLinkedIn({
        clientId: "x",
        clientSecret: "x",
        redirectUri: "http://evil.test/",
        version: "202611",
      }),
    LinkedInError,
  );
  const { api, calls } = setup(() => {
    throw new Error("unexpected");
  });
  await assert.rejects(api.listPosts("token", "../organization"));
  assert.equal(calls.length, 0);
});

test("reports UGC lifetime metrics with documented indexed filter and preserves unavailable rows", async () => {
  const ugc = "urn:li:ugcPost:222";
  const { api, calls } = setup((url) =>
    url.pathname === "/rest/posts"
      ? reply({ elements: [{ ...post, id: ugc }] })
      : url.searchParams.has("ugcPosts[0]")
        ? reply({ elements: [{ ugcPost: ugc, totalShareStatistics: stats }] })
        : reply({ elements: [{ totalShareStatistics: stats }] }),
  );
  const result = await api.report("token", org, 7);
  assert.equal(result.posts[0].metrics.clicks, 2);
  assert.equal(calls[2].url.searchParams.get("ugcPosts[0]"), ugc);
  assert.equal(calls[2].url.searchParams.has("timeIntervals.timeRange.start"), false);
});

test("organization verification follows only locally constructed pagination offsets", async () => {
  const { api, calls } = setup((url) => {
    if (url.pathname.endsWith("organizationAcls"))
      return url.searchParams.get("start") === "0"
        ? reply({
            elements: [],
            paging: { links: [{ rel: "next", href: "https://attacker.example/redirect" }] },
          })
        : reply({ elements: [{ organization: orgUrn, state: "APPROVED", role: "ADMINISTRATOR" }] });
    return reply({ id: 12345, localizedName: "Acme" });
  });
  assert.equal((await api.verifyOrganization("token", org)).name, "Acme");
  assert.equal(calls[1].url.origin, "https://api.linkedin.com");
  assert.equal(calls[1].url.searchParams.get("start"), "100");
});
