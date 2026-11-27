import { test } from "node:test";
import assert from "node:assert/strict";
import { reportCsv, reportFilename } from "../public/report-csv.js";

function parseCsv(input) {
  const rows = []; let row = []; let cell = ""; let quoted = false;
  for (let i = input.charCodeAt(0) === 0xfeff ? 1 : 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted && ch === '"' && input[i + 1] === '"') { cell += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ',') { row.push(cell); cell = ""; }
    else if (!quoted && ch === '\r' && input[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += ch;
  }
  assert.equal(quoted, false);
  return rows;
}
const metrics = { impressions: 0, clicks: 4, reactions: 0, comments: 1, shares: 0 };
const base = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-08T00:00:00.000Z", totals: metrics, posts: [], warnings: [] };

test("exports selected-window aggregate and per-post lifetime separately, retaining zero and unknown", () => {
  const rows = parseCsv(reportCsv({ name: "Résidence" }, { ...base, posts: [
    { urn: "urn:li:share:123", url: "https://www.linkedin.com/feed/update/123", publishedAt: "2026-10-10T00:00:00Z", body: 'First, "hello"\nthen more', metrics: null },
    { urn: "urn:li:share:456", metrics: { ...metrics, clicks: null } },
  ], warnings: ["Some statistics unavailable."] }));
  const [headers, aggregate, unavailable, partial] = rows;
  const cell = (row, name) => row[headers.indexOf(name)];
  assert.equal(cell(aggregate, "scope"), "selected_window_aggregate");
  assert.equal(cell(aggregate, "window_end_utc_exclusive"), base.to);
  assert.equal(cell(aggregate, "impressions"), "0");
  assert.equal(cell(aggregate, "warnings"), "Some statistics unavailable.");
  assert.equal(cell(unavailable, "scope"), "post_lifetime");
  assert.equal(cell(unavailable, "window_start_utc_inclusive"), "");
  assert.equal(cell(unavailable, "post_body"), 'First, "hello"\nthen more');
  assert.equal(cell(unavailable, "metrics_availability"), "unavailable");
  assert.equal(cell(unavailable, "impressions"), "");
  assert.equal(cell(partial, "metrics_availability"), "partial");
  assert.equal(cell(partial, "impressions"), "0");
  assert.equal(cell(partial, "clicks"), "");
});

test("neutralizes spreadsheet formula prefixes and preserves quoting across all untrusted fields", () => {
  const rows = parseCsv(reportCsv({ name: "  =HYPERLINK(\"x\")" }, { ...base, warnings: ["@warning"], posts: [
    { urn: "+danger", url: "-1", body: "\t=cmd\nwith, comma", publishedAt: "\rattack", metrics },
    { body: "\u00a0=evil", metrics: null },
  ] }));
  const headers = rows[0]; const cell = (row, name) => row[headers.indexOf(name)];
  assert.equal(cell(rows[1], "project"), "'  =HYPERLINK(\"x\")");
  assert.equal(cell(rows[1], "warnings"), "'@warning");
  assert.equal(cell(rows[2], "post_urn"), "'+danger");
  assert.equal(cell(rows[2], "post_url"), "'-1");
  assert.equal(cell(rows[2], "post_body"), "'\t=cmd\nwith, comma");
  assert.equal(cell(rows[2], "post_published_at"), "'\rattack");
  assert.equal(cell(rows[3], "post_body"), "'\u00a0=evil");
});

test("uses safe bounded filenames without a path or untrusted date text", () => {
  assert.equal(reportFilename("../../Café Résidence", base), "social-report-Cafe-Residence-2026-11-01.csv");
  assert.equal(reportFilename("💥", { from: "../../bad" }), "social-report-project-report.csv");
  assert.ok(reportFilename("x".repeat(1000), base).length < 100);
});
