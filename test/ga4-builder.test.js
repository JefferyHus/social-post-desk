import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSpec, resolveDates } from "../src/ga4-builder.js";
import { createGa4 } from "../src/ga4.js";
import { openStore } from "../src/store.js";
import { ga4BuilderCsv } from "../public/report-csv.js";

const spec = { breakdown: "channel", metrics: ["sessions", "keyEvents"], dateRule: { kind: "preset", days: 7 } };
const stamp = Date.parse("2026-01-01T00:30:00Z");
test("validates fields and exact completed dates using the property calendar", () => {
  assert.deepEqual(resolveDates(spec, "America/Los_Angeles", stamp), { startDate: "2025-12-24", endDate: "2025-12-30" });
  assert.deepEqual(resolveDates({ ...spec, dateRule: { kind: "preset", days: 90 } }, "UTC", stamp), { startDate: "2025-10-03", endDate: "2025-12-31" });
  const custom = (startDate, endDate) => ({ ...spec, dateRule: { kind: "custom", startDate, endDate } });
  assert.deepEqual(resolveDates(custom("2025-10-03", "2025-12-31"), "UTC", stamp), { startDate: "2025-10-03", endDate: "2025-12-31" });
  assert.throws(() => resolveDates(custom("2025-10-02", "2025-12-31"), "UTC", stamp), /90 completed/);
  assert.throws(() => resolveDates(custom("2025-12-31", "2026-01-01"), "UTC", stamp), /90 completed/);
  assert.throws(() => validateSpec(custom("2025-02-29", "2025-03-01")), /valid/);
  assert.throws(() => validateSpec({ ...spec, metrics: ["screenPageViews"] }), /compatible/);
  assert.throws(() => validateSpec({ ...spec, breakdown: "__proto__" }), /compatible/);
  assert.throws(() => resolveDates(spec, "fake/timezone", stamp), /timezone/);
});
test("provider resolves dates, propagates warnings and unknown metrics without real Google calls", async () => {
  const calls = [];
  const provider = createGa4({ clientId: "test", clientSecret: "test", redirectUri: "http://localhost/callback", now: () => stamp, fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), redirect: init.redirect });
    const body = calls.length === 1 ? { metadata: { timeZone: "UTC" } } : {
      dimensionHeaders: [{ name: "sessionDefaultChannelGroup" }], metricHeaders: [{ name: "sessions" }, { name: "keyEvents" }],
      rows: [{ dimensionValues: [{ value: "Organic" }], metricValues: [{ value: "0" }, { value: "bad" }] }],
      rowCount: 2, metadata: { timeZone: "UTC", subjectToThresholding: true },
    };
    return { ok: true, async json() { return body; } };
  }});
  const result = await provider.customReport("token", "123", spec);
  assert.deepEqual(result.rows, [{ dimension: "Organic", metrics: { sessions: 0, keyEvents: null } }]);
  assert.equal(result.startDate, "2025-12-25"); assert.equal(result.endDate, "2025-12-31");
  assert.match(result.warnings.join(" "), /threshold/); assert.match(result.warnings.join(" "), /limited/);
  assert.equal(calls.length, 2); assert.equal(calls[1].redirect, "error");
  assert.deepEqual(calls[1].body.dateRanges, [{ startDate: "2025-12-25", endDate: "2025-12-31" }]);
  await assert.rejects(provider.customReport("token", "123", { ...spec, metrics: ["screenPageViews"] }), /compatible/);
  assert.equal(calls.length, 2);
});
test("templates remain scoped to their project", () => {
  const store = openStore({ filename: ":memory:", key: Buffer.alloc(32, 2) });
  try {
    const a = store.createProject({ name: "A" }), b = store.createProject({ name: "B" });
    const template = store.createGa4Template(a.id, "Weekly", validateSpec(spec));
    assert.deepEqual(store.listGa4Templates(b.id), []);
    assert.throws(() => store.renameGa4Template(b.id, template.id, "Stolen"), { status: 404 });
    assert.throws(() => store.deleteGa4Template(b.id, template.id), { status: 404 });
    assert.equal(store.renameGa4Template(a.id, template.id, "Renamed").name, "Renamed");
    store.deleteGa4Template(a.id, template.id); assert.deepEqual(store.listGa4Templates(a.id), []);
  } finally { store.close(); }
});
test("builder CSV includes preview data, property dates and warnings and neutralizes formulas", () => {
  const csv = ga4BuilderCsv({ name: "=project" }, { startDate: "2025-12-25", endDate: "2025-12-31", timezone: "UTC", breakdown: "channel", metrics: ["sessions", "keyEvents"], rows: [{ dimension: "\t=command", metrics: { sessions: 0, keyEvents: null } }], warnings: ["thresholded"] });
  assert.match(csv, /"'=project"/); assert.match(csv, /"'\t=command"/); assert.match(csv, /"0","","thresholded"/); assert.match(csv, /2025-12-25/);
  assert.equal(csv.split("\r\n").length, 3);
});

test("late preview responses never replace a newer project or changed form", async () => {
  const { createPreviewGuard } = await import("../public/ga4-builder-state.js");
  const guard = createPreviewGuard(); let project = "a", shown = null;
  let finishOld; const old = new Promise(resolve => { finishOld = resolve; });
  const oldTicket = guard.begin(project);
  const pending = old.then(value => { if (guard.current(oldTicket, project)) shown = value; });
  guard.invalidate(); project = "b";
  const nextTicket = guard.begin(project);
  if (guard.current(nextTicket, project)) shown = "new project";
  finishOld("old project"); await pending;
  assert.equal(shown, "new project");
  const sameProjectTicket = guard.begin(project); guard.invalidate();
  assert.equal(guard.current(sameProjectTicket, project), false);
  const aAgain = guard.begin("a"); assert.equal(guard.current(aAgain, "b"), false);
});
