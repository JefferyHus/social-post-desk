import { LONG_QUERY_RE2 } from "../public/seo-opportunities.js";

export const OPPORTUNITY_ROW_LIMIT = 1000;

/** Google applies the long-query filter before its bounded top-row selection. */
export function opportunityQuery(startDate, endDate) {
  return {
    startDate, endDate, type: "web", dataState: "final", aggregationType: "auto",
    dimensions: ["query", "page"], rowLimit: OPPORTUNITY_ROW_LIMIT,
    dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "query", operator: "includingRegex", expression: LONG_QUERY_RE2 }] }],
  };
}
export function normalizeOpportunityRows(data) {
  if (data?.rows === undefined) return [];
  if (!Array.isArray(data.rows) || data.rows.length > OPPORTUNITY_ROW_LIMIT) throw new Error("Invalid Search Console response");
  const number = (x, max = Number.MAX_SAFE_INTEGER) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= max ? x : null;
  return data.rows.map((r) => {
    if (!Array.isArray(r?.keys) || r.keys.length !== 2 || r.keys.some((key) => typeof key !== "string" || !key || key.length > 8192)) throw new Error("Invalid Search Console response");
    return { query: r.keys[0], page: r.keys[1], impressions: number(r.impressions), clicks: number(r.clicks), ctr: number(r.ctr, 1), position: number(r.position) };
  });
}

/** Reuses the GSC provider's bounded authenticated request function. */
export async function queryOpportunities(request, accessToken, siteUrl, days, timestamp) {
  if (typeof request !== "function" || typeof accessToken !== "string" || !accessToken || typeof siteUrl !== "string" || !siteUrl || ![7, 28, 90].includes(days) || !Number.isFinite(timestamp)) throw new Error("Invalid opportunity request");
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
  const end = new Date(`${date}T00:00:00Z`); end.setUTCDate(end.getUTCDate() - 3);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - days + 1);
  const startDate = start.toISOString().slice(0, 10), endDate = end.toISOString().slice(0, 10);
  const data = await request(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(opportunityQuery(startDate, endDate)),
  });
  return { days, siteUrl, startDate, endDate, rows: normalizeOpportunityRows(data), warnings: ["Shortlist from rows returned by Google; results may be incomplete and are limited to 1,000 rows."] };
}
