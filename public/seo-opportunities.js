/** Search Console query filter, applied at Google, not to an already bounded report. */
export const LONG_QUERY_RE2 = String.raw`^(?:\S+\s+){7,}\S+$`;

/** Filter the returned page/query pairs without aggregating or inventing metrics. */
export function selectOpportunities(rows, { minImpressions = 0, maxCtrPercent = 100 } = {}) {
  if (!Number.isFinite(minImpressions) || minImpressions < 0 || !Number.isFinite(maxCtrPercent) || maxCtrPercent < 0 || maxCtrPercent > 100) throw new Error("Enter valid filters.");
  return (Array.isArray(rows) ? rows : []).filter((row) =>
    typeof row.query === "string" && typeof row.page === "string" &&
    Number.isFinite(row.impressions) && row.impressions >= minImpressions &&
    Number.isFinite(row.ctr) && row.ctr >= 0 && row.ctr <= maxCtrPercent / 100
  ).slice().sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query) || a.page.localeCompare(b.page));
}
function cell(value) {
  if (value == null) return '""';
  let text = String(value);
  if (typeof value !== "number" && (/^[\t\r\n]/.test(text) || /^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(text))) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
/** CSV snapshots the exact shortlist, report window and active filters. */
export function opportunitiesCsv(project, report, filters, rows) {
  const header = ["project", "site", "start_date_pt_inclusive", "end_date_pt_inclusive", "min_words", "min_impressions", "max_ctr_percent", "query", "page", "impressions", "clicks", "ctr_percent", "position", "notice"];
  const prefix = [project.name, report.siteUrl, report.startDate, report.endDate, 8, filters.minImpressions, filters.maxCtrPercent];
  const notice = ["Shortlist from rows returned by Google; incomplete data is possible.", ...(Array.isArray(report.warnings) ? report.warnings : [])].join("\n");
  const csvRows = [header, ...rows.map((r) => [...prefix, r.query, r.page, r.impressions, r.clicks, typeof r.ctr === "number" && Number.isFinite(r.ctr) ? Number((r.ctr * 100).toPrecision(12)) : null, r.position, notice])];
  // Keep the context even when the selected shortlist is empty.
  if (!rows.length) csvRows.push([...prefix, null, null, null, null, null, null, `${notice} No rows matched these filters.`]);
  return `\uFEFF${csvRows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}
export function opportunitiesFilename(name, report) {
  const safeName = String(name || "project").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "project";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(report?.startDate || "") ? report.startDate : "report";
  return `seo-opportunities-${safeName}-${day}.csv`;
}
