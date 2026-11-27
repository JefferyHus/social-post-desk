const METRICS = ["impressions", "clicks", "reactions", "comments", "shares"];
const HEADERS = [
  "project", "scope", "window_start_utc_inclusive", "window_end_utc_exclusive",
  "post_urn", "post_url", "post_published_at", "post_body", "metrics_availability",
  ...METRICS, "warnings",
];

// Spreadsheet applications may evaluate text after whitespace or control characters.
function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (typeof value !== "number" && (/^[\t\r\n]/.test(text) || /^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(text))) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}
function metricValues(metrics) {
  const values = METRICS.map((key) => {
    const value = metrics?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  });
  const present = values.filter((value) => value !== null).length;
  return { values, availability: present === 0 ? "unavailable" : present === METRICS.length ? "available" : "partial" };
}

/** Build a CSV from the report already loaded in the browser; no network access. */
export function reportCsv(project, report) {
  if (!project || !report) throw new Error("A loaded report and project are required.");
  const aggregate = metricValues(report.totals);
  const rows = [HEADERS, [
    project.name, "selected_window_aggregate", report.from, report.to,
    null, null, null, null, aggregate.availability, ...aggregate.values,
    Array.isArray(report.warnings) ? report.warnings.join("\n") : "",
  ]];
  for (const post of report.posts || []) {
    const lifetime = metricValues(post.metrics);
    rows.push([
      project.name, "post_lifetime", null, null, post.urn, post.url,
      post.publishedAt, post.body, lifetime.availability, ...lifetime.values, null,
    ]);
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function reportFilename(projectName, report) {
  const name = String(projectName || "project").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "project";
  const day = typeof report?.from === "string" && /^\d{4}-\d{2}-\d{2}/.test(report.from) ? report.from.slice(0, 10) : "report";
  return `social-report-${name}-${day}.csv`;
}

/** GA4 values are copied as returned; nulls remain empty rather than becoming zero. */
export function ga4ReportCsv(project, report) {
  if (!project || !report) throw new Error("A loaded report and project are required.");
  const columns = ["project", "scope", "days", "timezone", "dimension", "active_users", "sessions", "screen_page_views", "key_events", "warnings"];
  const value = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
  const totals = report.totals || {};
  const row = (scope, dimension, active, sessions, views, events, warnings = null) => [project.name, scope, report.days, report.timezone, dimension, value(active), value(sessions), value(views), value(events), warnings];
  const rows = [columns, row("selected_period_totals", null, totals.activeUsers, totals.sessions, totals.screenPageViews, totals.keyEvents, Array.isArray(report.warnings) ? report.warnings.join("\n") : null)];
  for (const d of report.daily || []) rows.push(row("daily_sessions", d.date, null, d.sessions, null, null));
  for (const c of report.channels || []) rows.push(row("channel", c.channel, null, c.sessions, null, c.keyEvents));
  for (const p of report.pages || []) rows.push(row("page", p.path, null, null, p.screenPageViews, null));
  return `\uFEFF${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
export function ga4ReportFilename(name, days) {
  const safeName = reportFilename(name, {}).replace(/^social-report-/, "").replace(/-report\.csv$/, "");
  return `ga4-report-${safeName}-${[7, 28, 90].includes(days) ? days : "unknown"}-days.csv`;
}

/** Search Console rows are limited by Google and exported without inventing zeros. */
export function gscReportCsv(project, report) {
  if (!project || !report) throw new Error("A loaded report and project are required.");
  const rows = [["project","site","start_date_pacific","end_date_pacific","scope","dimension","clicks","impressions","ctr","position","warnings"]];
  const add = (scope, dimension, m) => rows.push([project.name,project.gsc?.siteUrl,report.startDate,report.endDate,scope,dimension,m?.clicks,m?.impressions,m?.ctr,m?.position,scope === "totals" ? (report.warnings || []).join("\n") : ""]);
  add("totals",null,report.totals);
  for (const d of report.daily || []) add("daily",d.date,d);
  for (const q of report.queries || []) add("query",q.query,q);
  for (const p of report.pages || []) add("page",p.page,p);
  return `\uFEFF${rows.map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
export function gscReportFilename(name, days) {
  return `search-${reportFilename(name, {}).replace(/^social-report-/, "").replace(/-report\.csv$/, "")}-${[7,28,90].includes(days) ? days : "unknown"}-days.csv`;
}
