// Intentionally conservative combinations already supported by the GA4 report surface.
export const BREAKDOWNS = {
  none: { label: "Totals", dimension: null, metrics: ["activeUsers", "sessions", "screenPageViews", "keyEvents"] },
  channel: { label: "Channel", dimension: "sessionDefaultChannelGroup", metrics: ["sessions", "keyEvents"] },
  sourceMedium: { label: "Source / medium", dimension: "sessionSourceMedium", metrics: ["sessions", "keyEvents"] },
  campaign: { label: "Campaign", dimension: "sessionCampaignName", metrics: ["sessions", "keyEvents"] },
  page: { label: "Page path", dimension: "pagePath", metrics: ["screenPageViews"] },
};
export const METRIC_LABELS = { activeUsers: "Active users", sessions: "Sessions", screenPageViews: "Views", keyEvents: "Key events" };
export class ReportValidationError extends Error {}
const bad = (message) => { throw new ReportValidationError(message); };
const dateValid = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export function validateSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || Object.keys(spec).some(k => !["breakdown", "metrics", "dateRule"].includes(k))) bad("Invalid report fields.");
  const breakdown = Object.hasOwn(BREAKDOWNS, spec.breakdown) && BREAKDOWNS[spec.breakdown];
  if (!breakdown || !Array.isArray(spec.metrics) || !spec.metrics.length || new Set(spec.metrics).size !== spec.metrics.length || spec.metrics.some(m => !breakdown.metrics.includes(m))) bad("Choose compatible metrics for the selected breakdown.");
  const rule = spec.dateRule;
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) bad("Choose a report date range.");
  if (rule.kind === "preset" && Object.keys(rule).every(k => ["kind", "days"].includes(k)) && [7, 28, 90].includes(rule.days)) return { breakdown: spec.breakdown, metrics: [...spec.metrics], dateRule: { kind: "preset", days: rule.days } };
  if (rule.kind === "custom" && Object.keys(rule).every(k => ["kind", "startDate", "endDate"].includes(k)) && dateValid(rule.startDate) && dateValid(rule.endDate) && rule.startDate <= rule.endDate) return { breakdown: spec.breakdown, metrics: [...spec.metrics], dateRule: { kind: "custom", startDate: rule.startDate, endDate: rule.endDate } };
  bad("Choose valid start and end dates, or a 7, 28 or 90 day preset.");
}
export function resolveDates(spec, timezone, now = Date.now()) {
  let today;
  try {
    const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
    const get = n => Number(parts.find(p => p.type === n)?.value);
    today = Date.UTC(get("year"), get("month") - 1, get("day"));
    if (!timezone || !Number.isFinite(today)) throw new Error();
  } catch { bad("The property timezone is unavailable; dates cannot be verified."); }
  const day = n => new Date(today - n * 86400000).toISOString().slice(0, 10);
  const rule = validateSpec(spec).dateRule;
  const startDate = rule.kind === "preset" ? day(rule.days) : rule.startDate;
  const endDate = rule.kind === "preset" ? day(1) : rule.endDate;
  if (startDate < day(90) || endDate > day(1)) bad("Choose dates within the last 90 completed days in the property timezone.");
  return { startDate, endDate };
}
