import test from "node:test";
import assert from "node:assert/strict";
import { createGa4, GA4Error } from "../src/ga4.js";

const scope = "https://www.googleapis.com/auth/analytics.readonly";
const reply = (data, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
const now = () => Date.parse("2026-11-28T12:00:00Z");
const header = (...names) => names.map((name) => ({ name }));
const vals = (...values) => values.map((value) => ({ value }));
const row = (dimensions, metrics) => ({
	dimensionValues: vals(...dimensions),
	metricValues: vals(...metrics),
});
const sample = () => ({
	reports: [
		{
			metricHeaders: header(
				"activeUsers",
				"sessions",
				"screenPageViews",
				"keyEvents",
			),
			rows: [row([], ["100", "120", "300", "4"])],
			metadata: { timeZone: "Africa/Casablanca" },
			rowCount: 1,
		},
		{
			dimensionHeaders: header("date"),
			metricHeaders: header("sessions"),
			rows: [row(["20261126"], ["3"]), row(["20261127"], ["0"])],
			metadata: { timeZone: "Africa/Casablanca" },
			rowCount: 2,
		},
		{
			dimensionHeaders: header("sessionDefaultChannelGroup"),
			metricHeaders: header("sessions", "keyEvents"),
			rows: [row(["Organic Search"], ["50", "2"])],
			metadata: { timeZone: "Africa/Casablanca" },
			rowCount: 1,
		},
		{
			dimensionHeaders: header("pagePath"),
			metricHeaders: header("screenPageViews"),
			rows: [row(["/pricing"], ["40"])],
			metadata: { timeZone: "Africa/Casablanca" },
			rowCount: 1,
		},
	],
});
function setup(handler) {
	const calls = [];
	const provider = createGa4({
		clientId: "client",
		clientSecret: "client-secret",
		redirectUri: "http://localhost:3000/ga4/callback",
		now,
		fetchImpl: async (url, init) => {
			calls.push({ url, init });
			return handler(url, init);
		},
	});
	return { provider, calls };
}
const state = "a".repeat(32),
	challenge = "b".repeat(43),
	verifier = "c".repeat(64);

test("authorize URL requests only the read-only scope and offline PKCE consent", () => {
	const { provider } = setup(() => {
		throw Error("no network");
	});
	const url = new URL(provider.authorizeUrl({ state, challenge }));
	assert.equal(url.origin, "https://accounts.google.com");
	assert.equal(url.pathname, "/o/oauth2/v2/auth");
	assert.equal(url.searchParams.get("scope"), scope);
	assert.equal(url.searchParams.get("access_type"), "offline");
	assert.equal(url.searchParams.get("prompt"), "consent");
	assert.equal(url.searchParams.get("state"), state);
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("code_challenge"), challenge);
	assert.equal(url.searchParams.has("client_secret"), false);
	assert.throws(
		() => provider.authorizeUrl({ state: "short", challenge }),
		GA4Error,
	);
	assert.throws(
		() => provider.authorizeUrl({ state, challenge: "invalid" }),
		GA4Error,
	);
});

test("code exchange and refresh use fixed endpoint, bounded expiry and redirection disabled", async () => {
	const { provider, calls } = setup((_url, init) => {
		const params = new URLSearchParams(init.body);
		return reply({
			access_token: "access-1",
			...(params.get("grant_type") === "authorization_code"
				? { refresh_token: "refresh-1", scope }
				: {}),
			expires_in: 3600,
			token_type: "Bearer",
		});
	});
	assert.deepEqual(await provider.exchangeCode({ code: "code", verifier }), {
		accessToken: "access-1",
		refreshToken: "refresh-1",
		expiresAt: new Date(now() + 3_600_000).toISOString(),
	});
	assert.deepEqual(await provider.refresh("refresh-1"), {
		accessToken: "access-1",
		expiresAt: new Date(now() + 3_600_000).toISOString(),
	});
	for (const call of calls) {
		assert.equal(call.url, "https://oauth2.googleapis.com/token");
		assert.equal(call.init.redirect, "error");
		assert.ok(call.init.signal instanceof AbortSignal);
	}
	const first = new URLSearchParams(calls[0].init.body);
	assert.equal(first.get("code_verifier"), verifier);
	assert.equal(first.get("redirect_uri"), "http://localhost:3000/ga4/callback");
	assert.equal(
		new URLSearchParams(calls[1].init.body).get("refresh_token"),
		"refresh-1",
	);
});

test("rejects missing refresh token, denied or missing scope, invalid expiry and unsafe redirect configuration", async () => {
	for (const payload of [
		{ access_token: "a", expires_in: 100, scope },
		{ access_token: "a", refresh_token: "r", expires_in: 100 },
		{
			access_token: "a",
			refresh_token: "r",
			expires_in: 100,
			scope: "https://www.googleapis.com/auth/other",
		},
		{ access_token: "a", refresh_token: "r", expires_in: 0, scope },
	]) {
		const { provider } = setup(() => reply(payload));
		await assert.rejects(
			provider.exchangeCode({ code: "code", verifier }),
			(e) => e instanceof GA4Error && e.status === 502,
		);
	}
	assert.throws(
		() =>
			createGa4({
				clientId: "c",
				clientSecret: "s",
				redirectUri: "http://example.com/cb",
			}),
		GA4Error,
	);
});

test("uses one bounded batch with property-timezone dates and maps all reports", async () => {
	const { provider, calls } = setup(() => reply(sample()));
	const result = await provider.report("token", "123456789", 7);
	assert.deepEqual(result, {
		days: 7,
		totals: {
			activeUsers: 100,
			sessions: 120,
			screenPageViews: 300,
			keyEvents: 4,
		},
		daily: [
			{ date: "2026-11-21", sessions: null },
			{ date: "2026-11-22", sessions: null },
			{ date: "2026-11-23", sessions: null },
			{ date: "2026-11-24", sessions: null },
			{ date: "2026-11-25", sessions: null },
			{ date: "2026-11-26", sessions: 3 },
			{ date: "2026-11-27", sessions: 0 },
		],
		channels: [{ channel: "Organic Search", sessions: 50, keyEvents: 2 }],
		pages: [{ path: "/pricing", screenPageViews: 40 }],
		timezone: "Africa/Casablanca",
		warnings: [],
	});
	assert.equal(calls.length, 1);
	assert.equal(
		calls[0].url,
		"https://analyticsdata.googleapis.com/v1beta/properties/123456789:batchRunReports",
	);
	assert.equal(calls[0].init.redirect, "error");
	assert.equal(calls[0].init.headers.authorization, "Bearer token");
	const requests = JSON.parse(calls[0].init.body).requests;
	assert.equal(requests.length, 4);
	for (const request of requests)
		assert.deepEqual(request.dateRanges, [
			{ startDate: "7daysAgo", endDate: "yesterday" },
		]);
	assert.equal(requests[3].dimensions[0].name, "pagePath");
	assert.equal(requests[2].dimensions[0].name, "sessionDefaultChannelGroup");
	assert.equal(requests[3].limit, "20");
});

test("preserves null versus zero and discloses thresholding, sampling, restricted and truncated data", async () => {
	const data = sample();
	data.reports[0].rows[0].metricValues = vals("0", "", "7", "not-a-number");
	data.reports[0].metadata = {
		timeZone: "UTC",
		subjectToThresholding: true,
		samplingMetadatas: [{}],
		dataLossFromOtherRow: true,
		dataTruncationReasons: [{}],
		schemaRestrictionResponse: {
			activeMetricRestrictions: [{ metricName: "screenPageViews" }],
		},
	};
	data.reports[2].rowCount = 50;
	data.reports[3].rows = [row(["/orders?token=secret#fragment"], ["0"])];
	const { provider } = setup(() => reply(data));
	const result = await provider.report("token", "123", 7);
	assert.deepEqual(result.totals, {
		activeUsers: 0,
		sessions: null,
		screenPageViews: null,
		keyEvents: null,
	});
	assert.deepEqual(result.pages, [{ path: "/orders", screenPageViews: 0 }]);
	assert.equal(result.timezone, null);
	for (const phrase of [
		"threshold",
		"sampled",
		"other row",
		"truncation",
		"restricted",
		"limited",
		"inconsistent",
	])
		assert.ok(
			result.warnings.some((warning) => warning.includes(phrase)),
			phrase,
		);
});

test("empty totals stay unknown and missing calendar days are null", async () => {
	const data = sample();
	delete data.reports[0].rows;
	data.reports[0].rowCount = 0;
	const { provider } = setup(() => reply(data));
	const result = await provider.report("token", "123", 7);
	assert.deepEqual(result.totals, {
		activeUsers: null,
		sessions: null,
		screenPageViews: null,
		keyEvents: null,
	});
	assert.equal(result.daily.length, 7);
	assert.deepEqual(result.daily[0], { date: "2026-11-21", sessions: null });
	assert.deepEqual(result.daily.at(-1), { date: "2026-11-27", sessions: 0 });
	assert.ok(result.warnings.includes("Totals: no data was returned."));
});

test("maps provider metric values by header name, not by assumed column order", async () => {
	const data = sample();
	data.reports[0].metricHeaders = header(
		"keyEvents",
		"sessions",
		"activeUsers",
		"screenPageViews",
	);
	data.reports[0].rows[0].metricValues = vals("4", "120", "100", "300");
	const { provider } = setup(() => reply(data));
	const result = await provider.report("token", "123", 7);
	assert.deepEqual(result.totals, {
		activeUsers: 100,
		sessions: 120,
		screenPageViews: 300,
		keyEvents: 4,
	});
});

test("uses the property calendar across a UTC date boundary and DST change", async () => {
	const data = sample();
	for (const report of data.reports)
		report.metadata = { timeZone: "America/Los_Angeles" };
	data.reports[1].rows = [];
	const provider = createGa4({
		clientId: "client",
		clientSecret: "secret",
		redirectUri: "http://localhost:3000/callback",
		now: () => Date.parse("2026-11-02T07:30:00Z"),
		fetchImpl: async () => reply(data),
	});
	const result = await provider.report("token", "123", 3);
	assert.deepEqual(result.daily, [
		{ date: "2026-10-29", sessions: null },
		{ date: "2026-10-30", sessions: null },
		{ date: "2026-10-31", sessions: null },
	]);
});

test("does not fabricate calendar dates when the property timezone is unavailable", async () => {
	const data = sample();
	for (const report of data.reports) delete report.metadata.timeZone;
	const { provider } = setup(() => reply(data));
	const result = await provider.report("token", "123", 7);
	assert.equal(result.timezone, null);
	assert.equal(result.daily.length, 2);
	assert.ok(
		result.warnings.some((warning) =>
			warning.includes("without a valid property time zone"),
		),
	);
});

test("rejects property URL injection and bad periods without network access", async () => {
	const { provider, calls } = setup(() => reply(sample()));
	for (const [id, days] of [
		["123/../../x", 7],
		["https://example.com", 7],
		["123", 0],
		["123", 91],
		["123", 1.5],
	]) {
		await assert.rejects(
			provider.report("token", id, days),
			(e) => e instanceof GA4Error && e.status === 400,
		);
	}
	assert.equal(calls.length, 0);
});

test("fails closed on malformed, redirected, remote and transport errors without exposing secrets", async () => {
	for (const [handler, status] of [
		[() => reply({ reports: [] }), 502],
		[() => reply({ error: { message: "private-token" } }, 403), 403],
		[
			() => {
				throw Error("private-token");
			},
			502,
		],
		[() => ({ ok: true, redirected: true, status: 200 }), 502],
	]) {
		const { provider } = setup(handler);
		await assert.rejects(
			provider.report("private-token", "123", 7),
			(error) =>
				error instanceof GA4Error &&
				error.status === status &&
				!String(error).includes("private-token"),
		);
	}
});

test("request timeout aborts and returns a sanitized 504", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let signal;
	const { provider } = setup((_url, init) => {
		signal = init.signal;
		return new Promise(() => {});
	});
	const result = provider.report("token", "123", 7);
	t.mock.timers.tick(12_000);
	await assert.rejects(
		result,
		(error) => error instanceof GA4Error && error.status === 504,
	);
	assert.equal(signal.aborted, true);
});

test("aggregate-only report requests just totals and retains unknown and warnings", async () => {
  const { provider, calls } = setup(() => reply({ metricHeaders: header("activeUsers", "sessions", "screenPageViews", "keyEvents"), rows: [row([], ["4", "0", "7", "bad"])], metadata: { timeZone: "Africa/Casablanca", subjectToThresholding: true }, rowCount: 1 }));
  const report = await provider.aggregateReport("synthetic", "123", 7);
  assert.equal(calls.length, 1); assert.match(calls[0].url, /:runReport$/);
  const body = JSON.parse(calls[0].init.body); assert.equal(body.dimensions, undefined); assert.equal(body.metrics.length, 4);
  assert.equal(report.totals.sessions, 0); assert.equal(report.totals.keyEvents, null); assert.equal(report.startDate, "2026-11-21"); assert.equal(report.endDate, "2026-11-27"); assert.match(report.warnings.join(" "), /threshold/);
  await assert.rejects(provider.aggregateReport("synthetic", "123", 14), GA4Error); assert.equal(calls.length, 1);
});
