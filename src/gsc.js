const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const OAUTH = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/webmasters/v3";
export class GscError extends Error {
  constructor(status = 502) {
    super("Search Console request failed");
    this.status = status;
  }
}
export function validSite(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  if (/^sc-domain:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value)) return true;
  try {
    const u = new URL(value);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.search &&
      u.href === value
    );
  } catch {
    return false;
  }
}
export function createGsc({
  clientId,
  clientSecret,
  redirectUri,
  fetchImpl = fetch,
  now = Date.now,
}) {
  if (!clientId || !clientSecret || !redirectUri) throw new GscError(400);
  let active = 0;
  async function request(url, options = {}) {
    if (active >= 12) throw new GscError(503);
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok || response.redirected)
        throw new GscError(response.status);
      const data = await response.json();
      if (!data || typeof data !== "object") throw new GscError();
      return data;
    } catch (e) {
      if (e instanceof GscError) throw e;
      throw new GscError();
    } finally {
      clearTimeout(timer);
      active--;
    }
  }
  async function token(params, initial) {
    const data = await request(OAUTH, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...params,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    if (
      typeof data.access_token !== "string" ||
      !data.access_token ||
      (initial &&
        (typeof data.refresh_token !== "string" ||
          !data.refresh_token ||
          typeof data.scope !== "string")) ||
      (data.scope && !data.scope.split(/\s+/).includes(SCOPE)) ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      throw new GscError();
    return {
      accessToken: data.access_token,
      ...(initial ? { refreshToken: data.refresh_token } : {}),
      expiresAt: new Date(now() + data.expires_in * 1000).toISOString(),
    };
  }
  return {
    authorizeUrl({ state, challenge }) {
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        state,
        access_type: "offline",
        prompt: "consent",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      return u.href;
    },
    exchangeCode({ code, verifier }) {
      return token(
        {
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        },
        true,
      );
    },
    refresh(refreshToken) {
      return token(
        { grant_type: "refresh_token", refresh_token: refreshToken },
        false,
      );
    },
    async listSites(accessToken) {
      const data = await request(`${API}/sites`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!Array.isArray(data.siteEntry)) {
        if (data.siteEntry === undefined) return [];
        throw new GscError();
      }
      if (data.siteEntry.length > 1000) throw new GscError();
      const sites = new Map();
      for (const x of data.siteEntry)
        if (
          x &&
          validSite(x.siteUrl) &&
          ["siteOwner", "siteFullUser", "siteRestrictedUser"].includes(
            x.permissionLevel,
          )
        )
          sites.set(x.siteUrl, {
            siteUrl: x.siteUrl,
            permissionLevel: x.permissionLevel,
          });
      return [...sites.values()];
    },
    async report(accessToken, siteUrl, days) {
      if (!validSite(siteUrl) || ![7, 28, 90].includes(days))
        throw new GscError(400);
      const date = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(now()));
      const end = new Date(`${date}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() - 3);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - days + 1);
      const startDate = start.toISOString().slice(0, 10),
        endDate = end.toISOString().slice(0, 10);
      const dims = [[], ["date"], ["query"], ["page"]];
      const outputs = await Promise.all(
        dims.map(async (dimensions) => {
          const data = await request(
            `${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${accessToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                startDate,
                endDate,
                dimensions,
                type: "web",
                dataState: "final",
                rowLimit: dimensions[0] === "date" ? 90 : 100,
              }),
            },
          );
          if (data.rows === undefined) return [];
          if (!Array.isArray(data.rows) || data.rows.length > 100)
            throw new GscError();
          return data.rows;
        }),
      );
      const metric = (row) => {
        const n = (x) =>
          typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
        return {
          clicks: n(row.clicks),
          impressions: n(row.impressions),
          ctr: n(row.ctr),
          position: n(row.position),
        };
      };
      const rows = (i, names) =>
        outputs[i].map((row) => {
          if (
            !Array.isArray(row.keys) ||
            row.keys.length !== names.length ||
            row.keys.some((k) => typeof k !== "string")
          )
            throw new GscError();
          return {
            ...Object.fromEntries(names.map((n, j) => [n, row.keys[j]])),
            ...metric(row),
          };
        });
      return {
        days,
        startDate,
        endDate,
        timezone: "America/Los_Angeles",
        totals: outputs[0][0] ? metric(outputs[0][0]) : null,
        daily: rows(1, ["date"]).sort((a, b) => a.date.localeCompare(b.date)),
        queries: rows(2, ["query"]),
        pages: rows(3, ["page"]),
        warnings: [
          "Search Console may omit data; query and page results are limited to 100 rows.",
        ],
      };
    },
  };
}
