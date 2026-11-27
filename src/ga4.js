const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const READ_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_DAYS = 90;
const TOP_ROWS = 20;
const TOTAL_METRICS = [
	"activeUsers",
	"sessions",
	"screenPageViews",
	"keyEvents",
];

/** Provider errors deliberately exclude response bodies, credentials, and request URLs. */
export class GA4Error extends Error {
	constructor(status = 502) {
		super("Google Analytics request failed");
		this.name = "GA4Error";
		this.status =
			Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
	}
}

function nonempty(value, max = 4096) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= max &&
		!/[\x00-\x1f\x7f]/.test(value)
	);
}
function validRedirect(uri) {
	try {
		const url = new URL(uri);
		const local =
			url.hostname === "localhost" ||
			url.hostname === "127.0.0.1" ||
			url.hostname === "[::1]";
		return (
			(url.protocol === "https:" || (url.protocol === "http:" && local)) &&
			!url.username &&
			!url.password &&
			!url.hash
		);
	} catch {
		return false;
	}
}
function numberValue(value) {
	if (typeof value !== "string" && typeof value !== "number") return null;
	if (typeof value === "string" && !/^(?:\d+)(?:\.\d+)?$/.test(value))
		return null;
	const result = Number(value);
	return Number.isFinite(result) &&
		result >= 0 &&
		result <= Number.MAX_SAFE_INTEGER
		? result
		: null;
}
function namedColumns(report, key, names) {
	const headers = report[key];
	if (!Array.isArray(headers)) throw new GA4Error();
	const values = headers.map((header) => header?.name);
	if (
		new Set(values).size !== values.length ||
		names.some((name) => !values.includes(name))
	)
		throw new GA4Error();
	return Object.fromEntries(names.map((name) => [name, values.indexOf(name)]));
}
function restrictions(report) {
	const active =
		report.metadata?.schemaRestrictionResponse?.activeMetricRestrictions;
	return new Set(
		Array.isArray(active)
			? active.map((x) => x?.metricName).filter((x) => typeof x === "string")
			: [],
	);
}
function metric(row, indices, name, restricted) {
	if (restricted.has(name)) return null;
	return numberValue(row?.metricValues?.[indices[name]]?.value);
}
function dimension(row, indices, name) {
	const value = row?.dimensionValues?.[indices[name]]?.value;
	return nonempty(value, 2048) ? value : null;
}
function isoDate(value) {
	if (typeof value !== "string" || !/^\d{8}$/.test(value)) return null;
	const formatted = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
	const time = Date.parse(`${formatted}T00:00:00Z`);
	return Number.isFinite(time) &&
		new Date(time).toISOString().slice(0, 10) === formatted
		? formatted
		: null;
}
function reportDates(zone, days, timestamp) {
	try {
		if (!Number.isFinite(timestamp)) return null;
		const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(new Date(timestamp));
		const get = (name) =>
			Number(parts.find((part) => part.type === name)?.value);
		const today = Date.UTC(get("year"), get("month") - 1, get("day"));
		if (!Number.isFinite(today)) return null;
		return Array.from({ length: days }, (_, index) =>
			new Date(today - (days - index) * 86_400_000).toISOString().slice(0, 10),
		);
	} catch {
		return null;
	}
}
function sourceWarnings(report, name, warnings) {
	const m = report.metadata ?? {};
	if (m.subjectToThresholding === true)
		warnings.add(`${name}: results may be subject to data thresholds.`);
	if (Array.isArray(m.samplingMetadatas) && m.samplingMetadatas.length)
		warnings.add(`${name}: results are sampled.`);
	if (m.dataLossFromOtherRow === true)
		warnings.add(`${name}: some data may be grouped into an other row.`);
	if (Array.isArray(m.dataTruncationReasons) && m.dataTruncationReasons.length)
		warnings.add(`${name}: Google reports data truncation.`);
	if (restrictions(report).size)
		warnings.add(`${name}: some metrics are restricted.`);
	if (typeof m.emptyReason === "string" && m.emptyReason)
		warnings.add(`${name}: Google returned an empty report.`);
	const reported = numberValue(report.rowCount);
	if (reported !== null && reported > (report.rows?.length ?? 0))
		warnings.add(`${name}: report rows were limited.`);
}

export function createGa4({
	clientId,
	clientSecret,
	redirectUri,
	fetchImpl = fetch,
	now = Date.now,
}) {
	if (
		!nonempty(clientId, 1024) ||
		!nonempty(clientSecret, 4096) ||
		!nonempty(redirectUri, 2048) ||
		!validRedirect(redirectUri) ||
		typeof fetchImpl !== "function" ||
		typeof now !== "function"
	)
		throw new GA4Error(503);

	async function request(url, init) {
		const controller = new AbortController();
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new GA4Error(504));
			}, REQUEST_TIMEOUT_MS);
		});
		try {
			const work = (async () => {
				const response = await fetchImpl(url, {
					...init,
					signal: controller.signal,
					redirect: "error",
				});
				if (!response || response.redirected || !response.ok)
					throw new GA4Error(response?.status);
				return response.json();
			})();
			return await Promise.race([work, timeout]);
		} catch (error) {
			if (error instanceof GA4Error) throw error;
			throw new GA4Error();
		} finally {
			clearTimeout(timer);
		}
	}
	async function tokens(params, requireRefresh) {
		const data = await request(TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				...params,
				client_id: clientId,
				client_secret: clientSecret,
			}).toString(),
		});
		if (
			!data ||
			!nonempty(data.access_token) ||
			(requireRefresh && !nonempty(data.refresh_token)) ||
			(data.token_type && String(data.token_type).toLowerCase() !== "bearer") ||
			(requireRefresh && typeof data.scope !== "string") ||
			(data.scope != null && typeof data.scope !== "string") ||
			(typeof data.scope === "string" &&
				!data.scope.split(/\s+/).includes(READ_SCOPE))
		)
			throw new GA4Error();
		const expires = numberValue(data.expires_in);
		const timestamp = now();
		if (
			expires === null ||
			expires <= 0 ||
			!Number.isFinite(timestamp) ||
			!Number.isFinite(timestamp + expires * 1000)
		)
			throw new GA4Error();
		let expiresAt;
		try {
			expiresAt = new Date(timestamp + expires * 1000).toISOString();
		} catch {
			throw new GA4Error();
		}
		return {
			accessToken: data.access_token,
			...(requireRefresh ? { refreshToken: data.refresh_token } : {}),
			expiresAt,
		};
	}

	return {
		authorizeUrl({ state, challenge } = {}) {
			if (
				!nonempty(state, 256) ||
				!/^[A-Za-z0-9_-]{16,256}$/.test(state) ||
				typeof challenge !== "string" ||
				!/^[A-Za-z0-9_-]{43}$/.test(challenge)
			)
				throw new GA4Error(400);
			const url = new URL(AUTH_URL);
			for (const [key, value] of Object.entries({
				client_id: clientId,
				redirect_uri: redirectUri,
				response_type: "code",
				scope: READ_SCOPE,
				state,
				access_type: "offline",
				prompt: "consent",
				code_challenge: challenge,
				code_challenge_method: "S256",
			}))
				url.searchParams.set(key, value);
			return url.toString();
		},
		async exchangeCode({ code, verifier } = {}) {
			if (
				!nonempty(code, 4096) ||
				typeof verifier !== "string" ||
				!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
			)
				throw new GA4Error(400);
			return tokens(
				{
					grant_type: "authorization_code",
					code,
					code_verifier: verifier,
					redirect_uri: redirectUri,
				},
				true,
			);
		},
		async refresh(refreshToken) {
			if (!nonempty(refreshToken)) throw new GA4Error(400);
			return tokens(
				{ grant_type: "refresh_token", refresh_token: refreshToken },
				false,
			);
		},
		async aggregateReport(accessToken, propertyId, days) {
      if (!nonempty(accessToken) || !/^[1-9]\d{0,19}$/.test(String(propertyId ?? "")) || ![7, 28, 90].includes(days)) throw new GA4Error(400);
      const startedAt = now();
      const report = await request(`${DATA_API}/properties/${String(propertyId)}:runReport`, {
        method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ dateRanges: [{ startDate: `${days}daysAgo`, endDate: "yesterday" }], metrics: TOTAL_METRICS.map(name => ({ name })), limit: "1" }),
      });
      if (!report || typeof report !== "object" || (report.rows != null && !Array.isArray(report.rows))) throw new GA4Error();
      const indices = namedColumns(report, "metricHeaders", TOTAL_METRICS), restricted = restrictions(report);
      const warnings = new Set(); sourceWarnings(report, "Totals", warnings);
      if (!report.rows?.length) warnings.add("Totals: no data was returned.");
      const zone = nonempty(report.metadata?.timeZone, 128) ? report.metadata.timeZone : null;
      const before = zone ? reportDates(zone, days, startedAt) : null;
      const after = zone ? reportDates(zone, days, now()) : null;
      const dates = before && after && before[0] === after[0] && before.at(-1) === after.at(-1) ? after : null;
      if (!dates) warnings.add("Property timezone or exact dates are unavailable.");
      return { days, timezone: dates ? zone : null, startDate: dates?.[0] ?? null, endDate: dates?.at(-1) ?? null,
        totals: Object.fromEntries(TOTAL_METRICS.map(name => [name, metric(report.rows?.[0], indices, name, restricted)])), warnings: [...warnings] };
    },
		async report(accessToken, propertyId, days) {
			if (
				!nonempty(accessToken) ||
				!/^\d{1,20}$/.test(String(propertyId ?? "")) ||
				!Number.isInteger(days) ||
				days < 1 ||
				days > MAX_DAYS
			)
				throw new GA4Error(400);
			const dateRanges = [
				{ startDate: `${days}daysAgo`, endDate: "yesterday" },
			];
			const requested = [
				{ metrics: TOTAL_METRICS, limit: "1" },
				{
					dimensions: ["date"],
					metrics: ["sessions"],
					limit: String(MAX_DAYS),
					orderBys: [{ dimension: { dimensionName: "date" } }],
				},
				{
					dimensions: ["sessionDefaultChannelGroup"],
					metrics: ["sessions", "keyEvents"],
					limit: String(TOP_ROWS),
					orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
				},
				{
					dimensions: ["pagePath"],
					metrics: ["screenPageViews"],
					limit: String(TOP_ROWS),
					orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
				},
			];
			const requests = requested.map(({ dimensions, metrics, ...rest }) => ({
				dateRanges,
				...(dimensions
					? { dimensions: dimensions.map((name) => ({ name })) }
					: {}),
				metrics: metrics.map((name) => ({ name })),
				...rest,
			}));
			const body = await request(
				`${DATA_API}/properties/${String(propertyId)}:batchRunReports`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${accessToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ requests }),
				},
			);
			if (
				!body ||
				!Array.isArray(body.reports) ||
				body.reports.length !== requested.length
			)
				throw new GA4Error();
			const reports = body.reports;
			const warnings = new Set();
			const names = ["Totals", "Daily", "Channels", "Pages"];
			const cols = reports.map((item, index) => {
				if (
					!item ||
					typeof item !== "object" ||
					(item.rows != null && !Array.isArray(item.rows))
				)
					throw new GA4Error();
				sourceWarnings(item, names[index], warnings);
				return {
					metrics: namedColumns(
						item,
						"metricHeaders",
						requested[index].metrics,
					),
					dimensions: requested[index].dimensions
						? namedColumns(
								item,
								"dimensionHeaders",
								requested[index].dimensions,
							)
						: {},
					restricted: restrictions(item),
				};
			});
			const totalsRow = reports[0].rows?.[0];
			if (!totalsRow) warnings.add("Totals: no data was returned.");
			const totals = Object.fromEntries(
				TOTAL_METRICS.map((name) => [
					name,
					metric(totalsRow, cols[0].metrics, name, cols[0].restricted),
				]),
			);
			const daily = [];
			for (const row of (reports[1].rows ?? []).slice(0, MAX_DAYS)) {
				const date = isoDate(dimension(row, cols[1].dimensions, "date"));
				if (!date) {
					warnings.add("Daily: an invalid date row was omitted.");
					continue;
				}
				daily.push({
					date,
					sessions: metric(
						row,
						cols[1].metrics,
						"sessions",
						cols[1].restricted,
					),
				});
			}
			const channels = [];
			for (const row of (reports[2].rows ?? []).slice(0, TOP_ROWS)) {
				const channel = dimension(
					row,
					cols[2].dimensions,
					"sessionDefaultChannelGroup",
				);
				if (!channel) {
					warnings.add("Channels: an invalid row was omitted.");
					continue;
				}
				channels.push({
					channel,
					sessions: metric(
						row,
						cols[2].metrics,
						"sessions",
						cols[2].restricted,
					),
					keyEvents: metric(
						row,
						cols[2].metrics,
						"keyEvents",
						cols[2].restricted,
					),
				});
			}
			const pages = [];
			for (const row of (reports[3].rows ?? []).slice(0, TOP_ROWS)) {
				const raw = dimension(row, cols[3].dimensions, "pagePath");
				const path = raw?.split(/[?#]/, 1)[0];
				if (!path?.startsWith("/")) {
					warnings.add("Pages: an invalid path row was omitted.");
					continue;
				}
				pages.push({
					path,
					screenPageViews: metric(
						row,
						cols[3].metrics,
						"screenPageViews",
						cols[3].restricted,
					),
				});
			}
			const zones = [
				...new Set(
					reports
						.map((item) => item.metadata?.timeZone)
						.filter((zone) => nonempty(zone, 128)),
				),
			];
			if (zones.length > 1)
				warnings.add("Reports returned inconsistent property time zones.");
			let timezone = zones.length === 1 ? zones[0] : null;
			const dates = timezone ? reportDates(timezone, days, now()) : null;
			if (timezone && !dates) {
				timezone = null;
				warnings.add("Daily: the property time zone could not be used.");
			}
			if (!timezone)
				warnings.add(
					"Daily: missing dates could not be filled without a valid property time zone.",
				);
			let completedDaily = daily.sort((a, b) => a.date.localeCompare(b.date));
			if (dates) {
				const byDate = new Map();
				const inWindow = new Set(dates);
				for (const entry of daily) {
					if (!inWindow.has(entry.date)) {
						warnings.add(
							"Daily: a date outside the requested period was omitted.",
						);
						continue;
					}
					if (byDate.has(entry.date)) {
						warnings.add("Daily: a duplicate date row was omitted.");
						continue;
					}
					byDate.set(entry.date, entry.sessions);
				}
				completedDaily = dates.map((date) => ({
					date,
					sessions: byDate.has(date) ? byDate.get(date) : null,
				}));
			}
			return {
				days,
				totals,
				daily: completedDaily,
				channels,
				pages,
				timezone,
				warnings: [...warnings],
			};
		},
	};
}
