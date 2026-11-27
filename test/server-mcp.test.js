import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { openStore } from "../src/store.js";
import { createApp } from "../src/server.js";

const password = "test-only-long-password";
async function fixture(t, overrides = {}) {
  const config = loadConfig({ SOCIAL_DESK_PASSWORD: password, SOCIAL_DESK_ENCRYPTION_KEY: "42".repeat(32), MCP_REPORT_PORT: "32001" });
  const store = openStore({ filename: ":memory:", key: config.key });
  const a = store.createProject({ name: "Synthetic A", organizationId: "123" }), b = store.createProject({ name: "Synthetic B", organizationId: "456" });
  store.connect(a.id, { id: "123", accessToken: "synthetic-li", expiresAt: new Date(Date.now() + 3600000).toISOString() });
  store.setGa4Connection(a.id, { propertyId: "12345", refreshToken: "synthetic-refresh" });
  const ga4 = { async refresh() { return { accessToken: "synthetic-ga", expiresAt: new Date(Date.now() + 3600000).toISOString() }; }, async aggregateReport() { return { days: 7, startDate: "2026-01-01", endDate: "2026-01-07", timezone: "UTC", totals: { sessions: 0, keyEvents: null, activeUsers: 10, screenPageViews: 12, secret: "leak" }, warnings: ["Totals: results are sampled.", "sensitive provider text"], posts: [{ body: "private draft" }] }; }, ...overrides.ga4 };
  const linkedin = { async aggregateReport() { return { from: "2026-01-01T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z", totals: { impressions: 2, clicks: 0 }, warnings: [], posts: [{ body: "secret" }] }; }, ...overrides.linkedin };
  let clock = Date.now(); const app = createApp({ config, store, ga4, linkedin, now: () => clock });
  const listener = app.createMcpListener(); app.listen(0, "127.0.0.1"); listener.listen(0, "127.0.0.1"); await Promise.all([once(app, "listening"), once(listener, "listening")]);
  config.origin.port = app.address().port; const base = config.origin.origin, mcp = `http://127.0.0.1:${listener.address().port}`;
  let cookie;
  async function api(path, method = "GET", body, origin = base) {
    const headers = {}; if (method !== "GET") headers.origin = origin; if (body !== undefined) headers["content-type"] = "application/json"; if (cookie) headers.cookie = cookie;
    const res = await fetch(base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return res;
  }
  async function login() { const r = await api("/api/login", "POST", { password }); assert.equal(r.status, 200); cookie = r.headers.get("set-cookie").split(";")[0]; }
  async function create() { const r = await api(`/api/projects/${a.id}/mcp/grants`, "POST", { days: 7 }); assert.equal(r.status, 201); return r.json(); }
  const request = (path, token, headers = {}, method = "GET") => fetch(mcp + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  t.after(async () => { await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => listener.close(resolve))]); store.close(); });
  return { config, store, app, listener, a, b, api, login, create, request, advance: n => { clock += n; } };
}

test("grants are dashboard-protected, project-scoped, expiring and only their digest is persisted", async t => {
  const f = await fixture(t);
  assert.equal((await f.api(`/api/projects/${f.a.id}/mcp/grants`)).status, 401);
  await f.login();
  assert.equal((await f.api(`/api/projects/${f.a.id}/mcp/grants`, "POST", { days: 7 }, "https://evil.example")).status, 403);
  const grant = await f.create(); assert.match(grant.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(f.store.findMcpGrant(createHash("sha256").update(grant.token).digest("hex"), Date.now()).projectId, f.a.id);
  const listed = await (await f.api(`/api/projects/${f.a.id}/mcp/grants`)).text(); assert.doesNotMatch(listed, new RegExp(grant.token)); assert.doesNotMatch(listed, /token_hash|tokenHash/);
  assert.equal((await f.request(`/projects/${f.b.id}/ga4?days=7`, grant.token)).status, 404);
  assert.equal((await f.api(`/api/projects/${f.b.id}/mcp/grants/${grant.id}`, "DELETE")).status, 404);
  assert.equal((await f.request("/projects", "bad")).status, 401);
  f.advance(7 * 86400000); assert.equal((await f.request("/projects", grant.token)).status, 401);
});

test("listener rejects browsers, forwarded traffic, foreign hosts, methods and invalid query; only aggregate fields escape", async t => {
  const f = await fixture(t); await f.login(); const { token } = await f.create();
  for (const headers of [{ origin: "https://evil.example" }, { forwarded: "for=192.0.2.1" }, { "x-forwarded-for": "192.0.2.1" }, { cookie: "x=y" }]) assert.equal((await f.request("/projects", token, headers)).status, 403, JSON.stringify(headers));
  const invalidHost = await new Promise((resolve, reject) => { const req = httpRequest({ hostname: "127.0.0.1", port: f.listener.address().port, path: "/projects", headers: { host: "evil.example", authorization: `Bearer ${token}` } }, res => { res.resume(); resolve(res.statusCode); }); req.on("error", reject); req.end(); });
  assert.equal(invalidHost, 403);
  assert.equal((await f.request("/projects", token, {}, "POST")).status, 403);
  assert.equal((await f.request(`/projects/${f.a.id}/ga4?days=7&x=1`, token)).status, 400);
  assert.equal((await f.request(`/projects/${f.a.id}/ga4?days=7&days=28`, token)).status, 400);
  const ga = await (await f.request(`/projects/${f.a.id}/ga4?days=7`, token)).json();
  assert.equal(ga.totals.sessions, 0); assert.equal(ga.totals.keyEvents, null); assert.deepEqual(ga.warnings, ["Totals: results are sampled."]);
  assert.doesNotMatch(JSON.stringify(ga), /leak|private|sensitive|synthetic-ga/);
  const li = await (await f.request(`/projects/${f.a.id}/linkedin?days=7`, token)).json(); assert.equal(li.totals.clicks, 0); assert.equal(li.totals.shares, null); assert.doesNotMatch(JSON.stringify(li), /secret|synthetic-li/);
});

test("revocation and disconnect suppress in-flight aggregate responses", async t => {
  let release, started; let seen = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { linkedin: { async aggregateReport() { started(); return new Promise(resolve => { release = resolve; }); } } });
  await f.login(); const grant = await f.create();
  const pending = f.request(`/projects/${f.a.id}/linkedin?days=7`, grant.token); await seen;
  assert.equal((await f.api(`/api/projects/${f.a.id}/mcp/grants/${grant.id}`, "DELETE")).status, 200);
  release({ totals: { impressions: 7 }, warnings: [] }); assert.equal((await pending).status, 401);
  const again = await f.create(); seen = new Promise(resolve => { started = resolve; });
  const pending2 = f.request(`/projects/${f.a.id}/linkedin?days=7`, again.token); await seen;
  f.store.disconnect(f.a.id); release({ totals: { impressions: 7 }, warnings: [] }); assert.equal((await pending2).status, 409);
});

test("per-grant report concurrency is bounded", async t => {
  const release = []; let ready; const bothStarted = new Promise(resolve => { ready = resolve; });
  const f = await fixture(t, { linkedin: { async aggregateReport() { return new Promise(resolve => { release.push(resolve); if (release.length === 2) ready(); }); } } });
  await f.login(); const grant = await f.create(); const path = `/projects/${f.a.id}/linkedin?days=7`;
  const first = f.request(path, grant.token), second = f.request(path, grant.token); await bothStarted;
  assert.equal((await f.request(path, grant.token)).status, 429);
  release.forEach(resolve => resolve({ totals: { impressions: 1 }, warnings: [] }));
  assert.equal((await first).status, 200); assert.equal((await second).status, 200);
});
