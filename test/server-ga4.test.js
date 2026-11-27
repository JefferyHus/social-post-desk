import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { openStore } from "../src/store.js";
const pass = "test-only-long-password",
	refreshSecret = "test-only-google-refresh-secret";
async function fixture(t, providerOverrides = {}) {
	const config = loadConfig({
		SOCIAL_DESK_PASSWORD: pass,
		SOCIAL_DESK_ENCRYPTION_KEY: "4a".repeat(32),
		GOOGLE_CLIENT_ID: "synthetic-client",
		GOOGLE_CLIENT_SECRET: "synthetic-secret",
	});
	const dir = mkdtempSync(join(tmpdir(), "spd-ga4-")),
		filename = join(dir, "db.sqlite");
	const store = openStore({ filename, key: config.key });
	const calls = { exchange: [], refresh: 0, report: [] };
	const ga4 = {
		authorizeUrl: ({ state, challenge }) =>
			`https://accounts.google.com/o/oauth2/v2/auth?state=${state}&code_challenge=${challenge}`,
		async exchangeCode(v) {
			calls.exchange.push(v);
			return {
				accessToken: "test-google-access",
				refreshToken: refreshSecret,
				expiresAt: new Date(Date.now() + 3600000).toISOString(),
			};
		},
		async refresh(token) {
			assert.equal(token, refreshSecret);
			calls.refresh++;
			return {
				accessToken: "test-refreshed-access",
				expiresAt: new Date(Date.now() + 3600000).toISOString(),
			};
		},
		async report(token, propertyId, days) {
			calls.report.push({ token, propertyId, days });
			return { totals: { sessions: 4 }, daily: [] };
		},
		...providerOverrides,
	};
	const server = createApp({ config, store, ga4, linkedin: null });
	server.listen(0, config.host);
	await once(server, "listening");
	config.origin.port = server.address().port;
	const base = config.origin.origin;
	let cookie;
	async function req(path, method = "GET", body, overrideCookie = cookie) {
		const headers = {};
		if (method !== "GET") headers.origin = base;
		if (body !== undefined) headers["content-type"] = "application/json";
		if (overrideCookie) headers.cookie = overrideCookie;
		return fetch(base + path, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "manual",
		});
	}
	async function login() {
		const r = await req("/api/login", "POST", { password: pass }, null);
		assert.equal(r.status, 200);
		cookie = r.headers.get("set-cookie").split(";")[0];
		return cookie;
	}
	async function project(name) {
		const r = await req("/api/projects", "POST", {
			name,
			organizationId: null,
		});
		assert.equal(r.status, 201);
		return r.json();
	}
	async function start(p, propertyId = "123456") {
		const r = await req(`/api/projects/${p.id}/ga4/connect`, "POST", {
			propertyId,
		});
		assert.equal(r.status, 200);
		return new URL((await r.json()).authorizeUrl);
	}
	t.after(async () => {
		await new Promise((resolve) => server.close(resolve));
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { req, login, project, start, calls, store, filename };
}

test("OAuth binds PKCE to the authenticated session and project, saves only encrypted refresh token", async (t) => {
	const f = await fixture(t);
	const cookieA = await f.login();
	const a = await f.project("A"),
		b = await f.project("B");
	const url = await f.start(a);
	const state = url.searchParams.get("state"),
		challenge = url.searchParams.get("code_challenge");
	const cookieB = await f.login();
	assert.equal(
		(
			await f.req(
				`/oauth/google/callback?state=${state}&code=synthetic`,
				"GET",
				undefined,
				cookieB,
			)
		).status,
		400,
	);
	const callback = await f.req(
		`/oauth/google/callback?state=${state}&code=synthetic`,
		"GET",
		undefined,
		cookieA,
	);
	assert.equal(callback.status, 303);
	assert.equal(
		callback.headers.get("location"),
		`/?project=${a.id}&ga4=connected`,
	);
	assert.equal(
		createHash("sha256")
			.update(f.calls.exchange[0].verifier)
			.digest("base64url"),
		challenge,
	);
	assert.equal(
		(
			await f.req(
				`/oauth/google/callback?state=${state}&code=synthetic`,
				"GET",
				undefined,
				cookieA,
			)
		).status,
		400,
	);
	assert.deepEqual(f.store.getGa4Connection(a.id), { propertyId: "123456" });
	assert.equal(f.store.getGa4Connection(b.id), null);
	assert.equal(
		readFileSync(f.filename).includes(Buffer.from(refreshSecret)),
		false,
	);
	const data = await (
		await f.req("/api/projects", "GET", undefined, cookieA)
	).text();
	assert.equal(data.includes(refreshSecret), false);
	assert.equal(data.includes("test-google-access"), false);
	assert.match(data, /connected/);
});

test("report verifies read-only property, refreshes once, caches, and disconnect invalidates", async (t) => {
	const f = await fixture(t);
	await f.login();
	const p = await f.project("A"),
		u = await f.start(p);
	assert.equal(
		(
			await f.req(
				`/oauth/google/callback?state=${u.searchParams.get("state")}&code=synthetic`,
			)
		).status,
		303,
	);
	assert.equal(f.calls.report[0].propertyId, "123456");
	const path = `/api/projects/${p.id}/ga4/report?days=28`;
	const [r1, r2] = await Promise.all([f.req(path), f.req(path)]);
	assert.equal(r1.status, 200);
	assert.equal(r2.status, 200);
	assert.equal(f.calls.refresh, 1);
	assert.equal(f.calls.report.length, 2);
	assert.equal(
		(await f.req(`/api/projects/${p.id}/ga4/report?days=5`)).status,
		400,
	);
	assert.equal(
		(await f.req(`/api/projects/${p.id}/ga4/connection`, "DELETE")).status,
		200,
	);
	assert.equal((await f.req(path)).status, 409);
	assert.equal(f.store.getGa4RefreshToken(p.id), null);
});

test("disconnect invalidates an in-flight authorization callback", async (t) => {
	let release, entered;
	const started = new Promise((r) => {
			entered = r;
		}),
		gate = new Promise((r) => {
			release = r;
		});
	const f = await fixture(t, {
		async exchangeCode() {
			entered();
			await gate;
			return {
				accessToken: "test",
				refreshToken: refreshSecret,
				expiresAt: new Date(Date.now() + 3600000).toISOString(),
			};
		},
	});
	await f.login();
	const p = await f.project("A"),
		u = await f.start(p);
	const pending = f.req(
		`/oauth/google/callback?state=${u.searchParams.get("state")}&code=synthetic`,
	);
	await started;
	assert.equal(
		(await f.req(`/api/projects/${p.id}/ga4/connection`, "DELETE")).status,
		200,
	);
	release();
	const result = await pending;
	assert.match(result.headers.get("location"), /ga4=error/);
	assert.equal(f.store.getGa4Connection(p.id), null);
});

test("failed property verification and malformed IDs do not save credentials or expose provider errors", async (t) => {
	const f = await fixture(t, {
		async report() {
			throw new Error("provider-secret-must-not-leak");
		},
	});
	await f.login();
	const p = await f.project("A");
	assert.equal(
		(
			await f.req(`/api/projects/${p.id}/ga4/connect`, "POST", {
				propertyId: "abc",
			})
		).status,
		400,
	);
	const u = await f.start(p);
	const response = await f.req(
		`/oauth/google/callback?state=${u.searchParams.get("state")}&code=synthetic`,
	);
	assert.match(response.headers.get("location"), /ga4=error/);
	assert.equal(f.store.getGa4Connection(p.id), null);
	assert.equal(
		(await response.text()).includes("provider-secret-must-not-leak"),
		false,
	);
});

test("refresh ciphertext is bound to provider, project and property", async (t) => {
	const f = await fixture(t);
	await f.login();
	const a = await f.project("A"),
		b = await f.project("B");
	f.store.setGa4Connection(a.id, {
		propertyId: "123456",
		refreshToken: refreshSecret,
	});
	f.store.setGa4Connection(b.id, {
		propertyId: "987654",
		refreshToken: "other-synthetic-refresh",
	});
	const db = new DatabaseSync(f.filename);
	db.prepare(
		"UPDATE ga4_connections SET token_nonce=(SELECT token_nonce FROM ga4_connections WHERE project_id=?), token_ciphertext=(SELECT token_ciphertext FROM ga4_connections WHERE project_id=?), token_tag=(SELECT token_tag FROM ga4_connections WHERE project_id=?) WHERE project_id=?",
	).run(a.id, a.id, a.id, b.id);
	assert.throws(() => f.store.getGa4RefreshToken(b.id), /Unable to decrypt/);
	db.prepare("UPDATE ga4_connections SET property_id=? WHERE project_id=?").run(
		"654321",
		a.id,
	);
	db.close();
	assert.throws(() => f.store.getGa4RefreshToken(a.id), /Unable to decrypt/);
});

test("disconnect during report prevents the in-flight response being returned", async (t) => {
	let release, entered;
	const gate = new Promise((r) => {
			release = r;
		}),
		started = new Promise((r) => {
			entered = r;
		});
	let reportCount = 0;
	const f = await fixture(t, {
		async report() {
			reportCount++;
			if (reportCount > 1) {
				entered();
				await gate;
			}
			return { totals: { sessions: 4 }, daily: [] };
		},
	});
	await f.login();
	const p = await f.project("A"),
		u = await f.start(p);
	assert.equal(
		(
			await f.req(
				`/oauth/google/callback?state=${u.searchParams.get("state")}&code=synthetic`,
			)
		).status,
		303,
	);
	const pending = f.req(`/api/projects/${p.id}/ga4/report?days=28`);
	await started;
	assert.equal(
		(await f.req(`/api/projects/${p.id}/ga4/connection`, "DELETE")).status,
		200,
	);
	release();
	const response = await pending;
	assert.equal(response.status, 409);
	assert.equal((await response.text()).includes('"sessions":4'), false);
});

test("custom reports validate on the server and saved templates cannot cross projects", async (t) => {
  let received;
  const f = await fixture(t, { async customReport(token, propertyId, spec) { received = { token, propertyId, spec }; return { rows: [], warnings: [], timezone: "UTC" }; } });
  await f.login();
  const a = await f.project("A"), b = await f.project("B");
  f.store.setGa4Connection(a.id, { propertyId: "123", refreshToken: refreshSecret });
  const spec = { breakdown: "channel", metrics: ["sessions"], dateRule: { kind: "preset", days: 28 } };
  const base = `/api/projects/${a.id}/ga4`;
  let res = await f.req(`${base}/templates`, "POST", { name: "Weekly", spec });
  assert.equal(res.status, 201); const saved = await res.json();
  res = await f.req(`/api/projects/${b.id}/ga4/templates/${saved.id}`, "PATCH", { name: "Other" }); assert.equal(res.status, 404);
  res = await f.req(`/api/projects/${b.id}/ga4/templates/${saved.id}`, "DELETE"); assert.equal(res.status, 404);
  res = await f.req(`${base}/custom-report`, "POST", { spec: { ...spec, metrics: ["screenPageViews"] } }); assert.equal(res.status, 400); assert.equal(received, undefined);
  res = await f.req(`${base}/custom-report`, "POST", { spec }); assert.equal(res.status, 200); assert.equal(received.propertyId, "123"); assert.deepEqual(received.spec, spec);
  res = await f.req(`${base}/templates/${saved.id}`, "PATCH", { name: "Renamed" }); assert.equal(res.status, 200); assert.equal((await res.json()).name, "Renamed");
  res = await f.req(`${base}/templates/${saved.id}`, "DELETE"); assert.equal(res.status, 200);
  res = await f.req(`${base}/templates`); assert.deepEqual(await res.json(), []);
});
