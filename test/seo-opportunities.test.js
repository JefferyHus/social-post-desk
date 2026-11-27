import test from "node:test";
import assert from "node:assert/strict";
import { LONG_QUERY_RE2, selectOpportunities, opportunitiesCsv, opportunitiesFilename } from "../public/seo-opportunities.js";

test("exact RE2 filter separates seven and eight words and handles whitespace", () => {
  assert.equal(LONG_QUERY_RE2, String.raw`^(?:\S+\s+){7,}\S+$`);
  const pattern = new RegExp(LONG_QUERY_RE2);
  assert.equal(pattern.test("one two three four five six seven"), false);
  assert.equal(pattern.test("one two three four five six seven eight"), true);
  assert.equal(pattern.test("one\ttwo  three\nfour five six seven eight"), true);
  assert.equal(pattern.test(" one two three four five six seven eight"), false);
  assert.equal(pattern.test("one two three four five six seven eight "), false);
});
test("keeps same query on different pages, zero clicks and sorts by impressions", () => {
  const query = "one two three four five six seven eight";
  const list = [
    {query, page: "https://example.com/a", impressions: 20, clicks: 0, ctr: 0, position: 9},
    {query, page: "https://example.com/b", impressions: 40, clicks: 2, ctr: .05, position: 7},
    {query, page: "https://example.com/c", impressions: 100, clicks: 40, ctr: .4, position: 4},
    {query, page: "https://example.com/d", impressions: 200, clicks: null, ctr: null, position: 4},
  ];
  assert.deepEqual(selectOpportunities(list, { minImpressions: 10, maxCtrPercent: 10 }).map(x => x.page), ["https://example.com/b", "https://example.com/a"]);
  assert.throws(() => selectOpportunities(list, { minImpressions: -1, maxCtrPercent: 10 }));
});
test("export includes filters and window, quotes and spreadsheet-safe content", () => {
  const csv = opportunitiesCsv({ name: " =project" }, { siteUrl: "sc-domain:example.com", startDate: "2026-10-01", endDate: "2026-10-28" }, { minImpressions: 20, maxCtrPercent: 5 }, [{ query: '=HYPERLINK("evil")', page: "@page", impressions: 40, clicks: 0, ctr: 0, position: 3 }]);
  assert.match(csv, /"min_words","min_impressions","max_ctr_percent"/);
  assert.ok(csv.includes('"2026-10-01","2026-10-28","8","20","5"'));
  assert.ok(csv.includes('"\' =project"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""evil"")"'));
  assert.ok(csv.includes('"\'@page","40","0","0","3"'));
  assert.match(opportunitiesCsv({name:"test"}, {startDate:"x"}, {minImpressions:0,maxCtrPercent:100}, []), /No rows matched/);
  assert.equal(opportunitiesFilename("../../Café", {startDate:"2026-10-01"}), "seo-opportunities-Cafe-2026-10-01.csv");
});

test("Google request applies the exact long-query filter before the row limit", async () => {
  const { opportunityQuery, normalizeOpportunityRows } = await import("../src/seo-opportunities.js");
  const body = opportunityQuery("2026-10-01", "2026-10-28");
  assert.equal(body.type, "web");
  assert.equal(body.aggregationType, "auto");
  assert.equal(body.dataState, "final");
  assert.deepEqual(body.dimensions, ["query", "page"]);
  assert.deepEqual(body.dimensionFilterGroups[0].filters[0], { dimension: "query", operator: "includingRegex", expression: LONG_QUERY_RE2 });
  assert.equal(JSON.parse(JSON.stringify(body)).dimensionFilterGroups[0].filters[0].expression, String.raw`^(?:\S+\s+){7,}\S+$`);
  const keys = ["one two three four five six seven eight", "https://example.com/a"];
  assert.deepEqual(normalizeOpportunityRows({rows:[{keys, clicks:0, impressions:30, ctr:0, position:5}]}), [{query:keys[0],page:keys[1],clicks:0,impressions:30,ctr:0,position:5}]);
  assert.throws(() => normalizeOpportunityRows({rows:[{keys:["only query"]}]}));
});

test("opportunity provider requests the selected site and date window with exact filter", async () => {
  const { queryOpportunities } = await import("../src/seo-opportunities.js");
  let call;
  const result = await queryOpportunities(async (url, options) => { call = { url, options }; return { rows: [] }; }, "synthetic-token", "sc-domain:example.com", 7, Date.parse("2026-11-28T12:00:00Z"));
  assert.equal(call.url, "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
  assert.equal(call.options.headers.authorization, "Bearer synthetic-token");
  const request = JSON.parse(call.options.body);
  assert.equal(request.dimensionFilterGroups[0].filters[0].expression, LONG_QUERY_RE2);
  assert.equal(result.startDate, "2026-11-19");
  assert.equal(result.endDate, "2026-11-25");
  assert.equal(result.rows.length, 0);
  assert.match(result.warnings[0], /incomplete/);
});

test("GSC adapter sends the regex-filtered request through the fixed Google endpoint", async () => {
  const { createGsc } = await import("../src/gsc.js");
  let call;
  const provider = createGsc({ clientId: "synthetic-client", clientSecret: "synthetic-secret", redirectUri: "http://localhost/callback", now: () => Date.parse("2026-11-28T12:00:00Z"), fetchImpl: async (url, init) => {
    call = { url, init }; return new Response(JSON.stringify({ rows: [{ keys: ["one two three four five six seven eight", "https://example.com/a"], clicks: 0, impressions: 20, ctr: 0, position: 9 }] }), { status: 200 });
  } });
  const result = await provider.opportunities("synthetic-access", "sc-domain:example.com", 28);
  assert.equal(call.url, "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
  assert.equal(call.init.redirect, "error");
  assert.equal(JSON.parse(call.init.body).dimensionFilterGroups[0].filters[0].expression, LONG_QUERY_RE2);
  assert.equal(result.rows[0].clicks, 0);
  await assert.rejects(provider.opportunities("synthetic-access", "https://example.com/?secret=x", 28));
});
