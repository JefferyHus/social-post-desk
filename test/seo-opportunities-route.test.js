import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { openStore } from "../src/store.js";

test("opportunities uses the selected property's connection, is lazy and rejects stale results", async (t) => {
  const password = "test-only operator passphrase";
  const config = loadConfig({ SOCIAL_DESK_PASSWORD: password, SOCIAL_DESK_ENCRYPTION_KEY: "4a".repeat(32) });
  const store = openStore({ filename: ":memory:", key: config.key });
  const project = store.createProject({ name: "Example", organizationId: "10001" });
  store.setGscConnection(project.id, { siteUrl: "sc-domain:example.com", refreshToken: "synthetic-refresh" });
  let ordinaryCalls = 0, opportunityCalls = 0, resolveOpportunity, signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const gsc = {
    refresh: async (refresh) => { assert.equal(refresh, "synthetic-refresh"); return { accessToken: "synthetic-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }; },
    report: async () => { ordinaryCalls++; return { rows: [] }; },
    opportunities: async (token, site, days) => { opportunityCalls++; assert.equal(token, "synthetic-token"); assert.equal(site, "sc-domain:example.com"); assert.equal(days, 28); if (opportunityCalls === 1) return { days: 28, rows: [{ query: "one two three four five six seven eight", page: "https://example.com/", impressions: 12, clicks: 0, ctr: 0, position: 8 }] }; signalStarted(); return new Promise((resolve) => { resolveOpportunity = resolve; }); },
  };
  const server = createApp({ config, store, linkedin: {}, gsc });
  server.listen(0, config.host); await once(server, "listening"); config.origin.port = server.address().port;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.close(); });
  const base = config.origin.origin, path = `/api/projects/${project.id}/gsc`;
  assert.equal((await fetch(base + `${path}/opportunities`)).status, 401);
  const login = await fetch(base + "/api/login", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200); const cookie = login.headers.get("set-cookie").split(";")[0];
  const request = (url, init = {}) => fetch(base + url, { ...init, headers: { cookie, ...(init.method ? { origin: base } : {}) } });
  assert.equal((await request(`${path}/opportunities?days=4`)).status, 400);
  assert.equal((await request(`${path}/report?days=28`)).status, 200);
  assert.equal(ordinaryCalls, 1); assert.equal(opportunityCalls, 0);
  const result = await request(`${path}/opportunities?days=28`);
  assert.equal(result.status, 200); assert.equal((await result.json()).rows[0].clicks, 0);
  const pending = request(`${path}/opportunities?days=28`); await started;
  assert.equal((await request(`${path}/connection`, { method: "DELETE" })).status, 200);
  resolveOpportunity({ days: 28, rows: [] });
  assert.equal((await pending).status, 409);
  assert.equal(opportunityCalls, 2);
});
