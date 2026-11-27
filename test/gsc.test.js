import { test } from "node:test";
import assert from "node:assert/strict";
import { createGsc, validSite } from "../src/gsc.js";
const clock = () => Date.parse("2026-11-27T12:00:00Z");
const options = {
  clientId: "demo",
  clientSecret: "secret",
  redirectUri: "http://localhost:3000/callback",
  now: clock,
};
const scope = "https://www.googleapis.com/auth/webmasters.readonly";
test("OAuth scopes, property discovery and both property types", async () => {
  const seen = [];
  const provider = createGsc({
    ...options,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          siteEntry: [
            { siteUrl: "sc-domain:example.org", permissionLevel: "siteOwner" },
            {
              siteUrl: "https://example.org/",
              permissionLevel: "siteFullUser",
            },
            {
              siteUrl: "https://bad.example/",
              permissionLevel: "siteUnverifiedUser",
            },
            null,
            {
              siteUrl: "https://example.org/",
              permissionLevel: "siteFullUser",
            },
          ],
        }),
      };
    },
  });
  const u = new URL(
    provider.authorizeUrl({ state: "state", challenge: "challenge" }),
  );
  assert.equal(u.searchParams.get("scope"), scope);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(
    (await provider.listSites("synthetic")).map((x) => x.siteUrl),
    ["sc-domain:example.org", "https://example.org/"],
  );
  assert.equal(validSite("http://user:pass@example.org/"), false);
  assert.equal(validSite("https://example.org/path?token=x"), false);
});
test("final Pacific dates, aggregate totals and bounded query/page rows", async () => {
  const requests = [];
  const provider = createGsc({
    ...options,
    fetchImpl: async (url, init) => {
      const b = JSON.parse(init.body);
      requests.push({ url, b });
      const dim = b.dimensions;
      return {
        ok: true,
        json: async () => ({
          rows: [
            {
              ...(dim.length
                ? {
                    keys: dim.map(
                      (x) =>
                        ({
                          date: "2026-11-24",
                          query: "test",
                          page: "https://example.org/",
                        })[x],
                    ),
                  }
                : {}),
              clicks: 2,
              impressions: 10,
              ctr: 0.2,
              position: 4,
            },
          ],
        }),
      };
    },
  });
  for (const site of ["sc-domain:example.org", "https://example.org/"]) {
    const report = await provider.report("token", site, 7);
    assert.equal(report.startDate, "2026-11-18");
    assert.equal(report.endDate, "2026-11-24");
    assert.equal(report.timezone, "America/Los_Angeles");
    assert.equal(report.totals.clicks, 2);
    assert.equal(report.queries[0].query, "test");
    assert.equal(report.pages[0].page, "https://example.org/");
  }
  assert.equal(requests.length, 8);
  assert.ok(
    requests.every((x) => x.b.dataState === "final" && x.b.type === "web"),
  );
  assert.ok(
    requests.some((x) =>
      x.url.includes(encodeURIComponent("sc-domain:example.org")),
    ),
  );
});
test("empty responses keep totals unknown and errors remain sanitized", async () => {
  const p = createGsc({
    ...options,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  const r = await p.report("x", "https://example.org/", 28);
  assert.equal(r.totals, null);
  assert.deepEqual(r.queries, []);
  const failure = createGsc({
    ...options,
    fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  await assert.rejects(
    failure.report("x", "https://example.org/", 7),
    (e) => e.status === 403 && !e.message.includes("token"),
  );
});

test("CSV export neutralizes formulas in untrusted search dimensions and preserves unknowns", async () => {
  const { gscReportCsv } = await import("../public/report-csv.js");
  const csv = gscReportCsv(
    { name: "Example", gsc: { siteUrl: "sc-domain:example.org" } },
    {
      days: 7,
      startDate: "2026-11-18",
      endDate: "2026-11-24",
      totals: null,
      queries: [
        {
          query: "=SUM(1,2)",
          clicks: 0,
          impressions: null,
          ctr: null,
          position: null,
        },
      ],
      pages: [],
      daily: [],
      warnings: [],
    },
  );
  assert.match(csv, /'\=SUM/);
  assert.match(csv, /"0","","",""/);
});
