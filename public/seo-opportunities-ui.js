import { selectOpportunities, opportunitiesCsv, opportunitiesFilename } from "/seo-opportunities.js";

const $ = (id) => document.getElementById(id);
const text = (tag, value) => { const node = document.createElement(tag); node.textContent = value; return node; };
const number = (n) => typeof n === "number" && Number.isFinite(n) ? new Intl.NumberFormat().format(n) : "—";
const percent = (n) => typeof n === "number" && Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : "—";
function validUrl(value) { try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) ? u.href : null; } catch { return null; } }

export function mountOpportunities({ api, project, showError }) {
  const state = { active: false, report: null, error: null, loading: false, request: 0 };
  const filters = () => ({ minImpressions: Number($("op-min-impressions").value), maxCtrPercent: Number($("op-max-ctr").value) });
  function render() {
    const current = project(), connected = current?.gsc?.status === "connected";
    $("op-empty").hidden = !!current;
    $("op-main").hidden = !current;
    $("op-connect-note").hidden = !current || connected;
    $("op-connect-note").textContent = current?.gsc?.status === "unconfigured" ? "Configure Google OAuth on the server, then connect a Search Console property in Analytics." : "Connect a Search Console property in Analytics to find opportunities.";
    const report = state.report;
    $("op-window").textContent = report ? `${report.startDate} – ${report.endDate} · Pacific Time, inclusive · Web search` : "Web search · eight or more words";
    const warnings = $("op-warnings"); warnings.replaceChildren();
    if (state.loading) warnings.append(text("p", "Loading opportunities…"));
    if (state.error) warnings.append(text("p", state.error));
    for (const warning of report?.warnings || []) warnings.append(text("p", warning));
    let rows = [];
    try {
      if (!$("op-min-impressions").validity.valid || !$("op-max-ctr").validity.valid || $("op-min-impressions").value === "" || $("op-max-ctr").value === "") throw new Error("Enter valid filters.");
      rows = selectOpportunities(report?.rows, filters());
      $("op-filter-error").textContent = "";
    } catch { $("op-filter-error").textContent = "Enter a non-negative minimum and a CTR from 0 to 100."; }
    const valid = !$("op-filter-error").textContent;
    $("op-export").disabled = !report || !valid;
    $("op-count").textContent = report && valid ? `${rows.length} matching ${rows.length === 1 ? "row" : "rows"}` : "";
    const body = $("op-table-body"); body.replaceChildren();
    for (const row of rows) {
      const tr = document.createElement("tr"); tr.append(text("td", row.query));
      const page = document.createElement("td"), href = validUrl(row.page);
      if (href) { const link = text("a", row.page); link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; page.append(link); }
      else page.textContent = row.page;
      tr.append(page, text("td", number(row.impressions)), text("td", number(row.clicks)), text("td", percent(row.ctr)), text("td", number(row.position))); body.append(tr);
    }
    $("op-no-results").hidden = !report || !valid || rows.length > 0;
    $("op-table-wrap").hidden = !report || !valid || rows.length === 0;
  }
  async function load() {
    const current = project(), request = ++state.request, id = current?.id;
    state.report = null; state.error = null; state.loading = !!id && current?.gsc?.status === "connected"; render();
    if (!state.loading) return;
    try {
      const days = $("op-days").value;
      const report = await api(`/api/projects/${encodeURIComponent(id)}/gsc/opportunities?days=${encodeURIComponent(days)}`);
      if (request === state.request && project()?.id === id && state.active) state.report = report;
    } catch (error) {
      if (request === state.request && project()?.id === id && state.active) state.error = `Opportunities unavailable: ${error.message}`;
    } finally { if (request === state.request) { state.loading = false; render(); } }
  }
  $("op-days").addEventListener("change", () => { if (state.active) void load(); });
  for (const id of ["op-min-impressions", "op-max-ctr"]) $(id).addEventListener("input", render);
  $("op-export").addEventListener("click", () => {
    if (!state.report || !project()) return;
    try {
      const rows = selectOpportunities(state.report.rows, filters());
      const blob = new Blob([opportunitiesCsv(project(), state.report, filters(), rows)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = opportunitiesFilename(project().name, state.report); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { showError(error); }
  });
  return {
    show() { state.active = true; void load(); },
    hide() { state.active = false; state.request++; state.loading = false; },
    projectChanged() { state.request++; state.report = null; state.error = null; state.loading = false; if (state.active) void load(); else render(); },
  };
}
