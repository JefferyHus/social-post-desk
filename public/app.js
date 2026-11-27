import { reportCsv, reportFilename, ga4ReportCsv, ga4ReportFilename, gscReportCsv, gscReportFilename } from "/report-csv.js";

const $ = (selector) => document.querySelector(selector);
const state = {
  projects: [],
  project: null,
  drafts: [],
  selected: null,
  report: null,
  reportError: null,
  editingProject: false,
  request: 0,
  reportRequest: 0,
  demo: false,
  gscRequest: 0, gscReport: null, gscError: null, gscLoading: false,
  ga4Request: 0,
  ga4Report: null,
  ga4Error: null,
  ga4Loading: false,
  ga4FormProject: null,
};
const notice = $("#notice");
let noticeTimer;
function message(text, error = false) {
  notice.textContent = text;
  notice.classList.toggle("error", error);
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.hidden = true;
  }, 6500);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${response.status})`,
    );
  return data;
}
const send = (method, body) => ({ method, body: JSON.stringify(body) });
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
function anchor(text, url) {
  const href = safeUrl(url);
  if (!href) return null;
  const a = el("a", "text-link", text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}
function date(value, timeZone) {
  const d = new Date(value);
  return !value || Number.isNaN(d.getTime())
    ? "Date unavailable"
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone,
      });
}
function endpoint(suffix = "") {
  return `/api/projects/${encodeURIComponent(state.project.id)}${suffix}`;
}
function showError(error) {
  message(error instanceof Error ? error.message : "Something went wrong.", true);
}
function setBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}
function setButton(button, handler) {
  button.addEventListener("click", async () => {
    try {
      setBusy(button, true);
      await handler();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(button, false);
      renderPublishButton();
    }
  });
}
function scrollToSection(selector) {
  document.querySelector(selector).scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderProjects() {
  const select = $("#project-select");
  select.replaceChildren();
  for (const p of state.projects) {
    const option = el("option", "", p.name);
    option.value = p.id;
    select.append(option);
  }
  if (state.project) select.value = state.project.id;
  select.disabled = !state.projects.length;
  $("#settings-open").disabled = !state.project;
  $("#empty-project").hidden = !!state.project;
  $("#project-content").hidden = !state.project;
  const p = state.project;
  renderGa4();
  $("#connection-pill").textContent = p
    ? {
        connected: "Connected",
        expired: "Connection expired",
        disconnected: "Not connected",
        unconfigured: "Setup needed",
      }[p.connection] || "Not connected"
    : "No project";
  $("#connection-pill").classList.toggle("connected", p?.connection === "connected");
  if (!p) return;
  $("#connection-title").textContent = p.organizationName || "LinkedIn page";
  $("#connection-description").textContent =
    p.connection === "connected"
      ? "Your page is connected and ready for publishing."
      : p.connection === "expired"
        ? "Your LinkedIn connection has expired. Reconnect to continue."
        : p.connection === "unconfigured"
          ? "Configure your LinkedIn developer app on the server to connect. You can save drafts now."
          : p.organizationId
            ? "Connect LinkedIn to publish and view organic performance."
            : "Add your LinkedIn organization ID in project settings to connect a page.";
  const link = $("#page-link"),
    href =
      safeUrl(p.pageUrl) ||
      (/^\d+$/.test(p.organizationId || "")
        ? `https://www.linkedin.com/company/${p.organizationId}/`
        : null);
  link.hidden = !href;
  if (href) link.href = href;
  else link.removeAttribute("href");
  $("#connect").textContent =
    p.connection === "expired" ? "Reconnect LinkedIn" : "Connect LinkedIn";
  $("#connect").hidden = ["connected", "unconfigured"].includes(p.connection);
  $("#connect").disabled = !p.organizationId;
  $("#disconnect").hidden = !["connected", "expired"].includes(p.connection);
  renderPublishButton();
}
function currentInput() {
  return {
    body: $("#draft-body").value,
    linkUrl: $("#link-url").value.trim() || null,
    linkTitle: $("#link-title").value.trim() || null,
  };
}
function unchanged() {
  const d = state.selected,
    v = currentInput();
  return (
    !!d &&
    d.body === v.body &&
    (d.linkUrl || null) === v.linkUrl &&
    (d.linkTitle || null) === v.linkTitle
  );
}
function renderPublishButton() {
  const canPublish =
    state.selected?.status === "draft" &&
    unchanged() &&
    state.project?.connection === "connected" &&
    !!state.project.organizationName &&
    !!safeUrl(state.project.pageUrl);
  $("#publish").disabled = !canPublish;
  $("#draft-context").textContent = !state.selected
    ? "New draft"
    : state.selected.status !== "draft"
      ? `Status: ${state.selected.status.replaceAll("_", " ")}`
      : unchanged()
        ? "Saved draft · ready for review"
        : "Unsaved changes · save before publishing";
}
function editDraft(draft, { scroll = true } = {}) {
  state.selected = draft;
  $("#draft-body").value = draft?.body || "";
  $("#link-url").value = draft?.linkUrl || "";
  $("#link-title").value = draft?.linkTitle || "";
  const editable = !draft || draft.status === "draft";
  for (const selector of ["#draft-body", "#link-url", "#link-title", "#save-draft"])
    $(selector).disabled = !editable;
  renderPublishButton();
  if (scroll) scrollToSection("#compose");
}
function upsertDraft(draft) {
  const index = state.drafts.findIndex((d) => d.id === draft.id);
  if (index < 0) state.drafts.unshift(draft);
  else state.drafts[index] = draft;
  state.selected = draft;
  renderDrafts();
  renderPublishButton();
}
function renderDrafts() {
  const list = $("#draft-list");
  list.replaceChildren();
  if (!state.drafts.length) {
    list.append(el("p", "empty-state", "No drafts yet. Your saved posts will appear here."));
    return;
  }
  for (const d of state.drafts) {
    const row = el("article", "draft-row");
    const main = el("div", "draft-main");
    const title = el("p", "draft-text", d.body || "Untitled post");
    main.append(title);
    const meta = el("div", "row-meta");
    meta.append(
      el("span", `status status-${d.status}`, d.status.replaceAll("_", " ")),
      el("span", "", date(d.publishedAt || d.updatedAt || d.createdAt)),
    );
    main.append(meta);
    if (d.error) main.append(el("p", "row-error", d.error));
    const actions = el("div", "row-actions");
    if (d.status === "draft") {
      const edit = el("button", "text-button", "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => editDraft(d));
      actions.append(edit);
    }
    const view = anchor("View post ↗", d.postUrl);
    if (view) actions.append(view);
    if (d.status === "needs_review" || d.status === "publishing") {
      const reconcile = el("button", "text-button", "Check status");
      reconcile.type = "button";
      setButton(reconcile, async () => {
        const projectId = state.project.id;
        const updated = await api(
          endpoint(`/drafts/${encodeURIComponent(d.id)}/reconcile`),
          send("POST", {}),
        );
        if (state.project?.id !== projectId) return;
        upsertDraft(updated);
        message("Publishing status checked.");
      });
      actions.append(reconcile);
    }
    row.append(main, actions);
    list.append(row);
  }
}
function metricText(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat().format(value)
    : "—";
}
function renderReport() {
  $("#export-report").disabled = !state.project || !state.report;
  const metrics = $("#metrics");
  metrics.replaceChildren();
  const totals = state.report?.totals;
  for (const [key, label] of [
    ["impressions", "Impressions"],
    ["clicks", "Clicks"],
    ["reactions", "Reactions"],
    ["comments", "Comments"],
    ["shares", "Shares"],
  ]) {
    const item = el("div", "metric");
    item.append(
      el("span", "metric-value", metricText(totals?.[key])),
      el("span", "metric-label", label),
    );
    metrics.append(item);
  }
  $("#report-period").textContent = state.report
    ? `${date(state.report.from, "UTC")} – ${date(Date.parse(state.report.to) - 1, "UTC")} · UTC organic totals`
    : "Organic page activity";
  const warnings = $("#report-warnings");
  warnings.replaceChildren();
  if (state.reportError) warnings.append(el("p", "warning", state.reportError));
  for (const text of state.report?.warnings || []) warnings.append(el("p", "warning", text));
  const posts = $("#post-list");
  posts.replaceChildren();
  if (!state.report?.posts?.length) {
    posts.append(
      el(
        "p",
        "empty-state",
        state.report
          ? "LinkedIn returned no recent posts."
          : state.reportError
            ? "No post data available."
            : state.project?.connection === "connected"
              ? "Loading recent posts…"
              : "Connect a page to view reporting.",
      ),
    );
    return;
  }
  for (const post of state.report.posts) {
    const row = el("article", "recent-post");
    row.append(
      el("p", "recent-date", date(post.publishedAt)),
      el("p", "recent-text", post.body || "Post text unavailable"),
    );
    const stats = el(
      "p",
      "recent-stats",
      post.metrics
        ? `Lifetime: ${metricText(post.metrics.impressions)} impressions · ${metricText(post.metrics.clicks)} clicks · ${metricText(post.metrics.reactions)} reactions · ${metricText(post.metrics.comments)} comments · ${metricText(post.metrics.shares)} shares`
        : "Lifetime metrics unavailable",
    );
    row.append(stats);
    const link = anchor("View on LinkedIn ↗", post.url);
    if (link) row.append(link);
    posts.append(row);
  }
}
async function loadReport() {
  if (!state.project) return;
  const id = state.project.id,
    request = ++state.reportRequest;
  state.report = null;
  state.reportError = null;
  renderReport();
  if (state.project.connection !== "connected") return;
  try {
    const report = await api(endpoint(`/report?days=${encodeURIComponent($("#period").value)}`));
    if (state.project?.id === id && request === state.reportRequest) {
      state.report = report;
      renderReport();
    }
  } catch (error) {
    if (state.project?.id === id && request === state.reportRequest) {
      state.reportError = `Report unavailable: ${error.message}`;
      renderReport();
    }
  }
}
async function chooseProject(id) {
  const token = ++state.request;
  state.gscRequest++; state.gscReport = null; state.gscError = null; state.gscLoading = false; $("#gsc-selection").hidden = true;
  state.ga4Request++;
  state.reportRequest++;
  state.ga4Report = null;
  state.ga4Error = null;
  state.ga4Loading = false;
  state.project = state.projects.find((p) => p.id === id) || null;
  state.selected = null;
  state.drafts = [];
  state.report = null;
  state.reportError = null;
  renderProjects();
  renderDrafts();
  renderReport();
  editDraft(null, { scroll: false });
  if (!state.project) return;
  const projectId = state.project.id;
  if (!$("#analytics-view").hidden) { void loadGa4Report(); void loadGscReport(); }
  try {
    const drafts = await api(endpoint("/drafts"));
    if (token === state.request && state.project?.id === projectId) {
      state.drafts = drafts;
      renderDrafts();
    }
  } catch (error) {
    if (token === state.request) showError(error);
  }
  if (token === state.request) await loadReport();
}
async function refreshProjects(preferred) {
  state.projects = await api("/api/projects");
  await chooseProject(preferred || state.project?.id || state.projects[0]?.id);
}
async function start() {
  const params = new URLSearchParams(location.search),
    project = params.get("project"),
    result = params.get("linkedin"),
    ga4Result = params.get("ga4"), gscResult = params.get("gsc");
  if (result || ga4Result || gscResult) {
    params.delete("project");
    params.delete("linkedin");
    params.delete("ga4"); params.delete("gsc");
    history.replaceState(
      null,
      "",
      location.pathname + (params.toString() ? `?${params}` : "") + location.hash,
    );
  }
  const session = await api("/api/session");
  state.demo = session.demo === true;
  $("#demo-banner").hidden = !state.demo;
  if (session.demo) {
    $("#publish-confirmation").textContent = "Review the example page and text. This demo simulates publication.";
  }
  $("#login").hidden = session.authenticated;
  $("#app").hidden = !session.authenticated;
  if (session.authenticated) {
    await refreshProjects(project);
    if (gscResult) { showView("analytics"); if (gscResult === "select") await loadGscSites(); else message("Search Console connection could not be completed.", true); }
    if (ga4Result) {
      showView("analytics");
      message(ga4Result === "connected" ? "Google Analytics connection completed." : "Google Analytics connection could not be completed.", ga4Result !== "connected");
    }
    if (result)
      message(
        result === "connected"
          ? "LinkedIn connection completed."
          : "LinkedIn connection could not be completed.",
        result !== "connected",
      );
  }
}
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  try {
    setBusy(button, true);
    await api("/api/login", send("POST", { password: $("#password").value }));
    $("#password").value = "";
    await start();
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
  }
});
async function logout() {
  await api("/api/logout", send("POST", {}));
  state.request++;
  state.reportRequest++;
  state.gscRequest++; state.gscReport = null; state.gscError = null; state.gscLoading = false; $("#gsc-selection").hidden = true;
  state.ga4Request++;
  state.ga4Report = null;
  state.ga4Error = null;
  state.ga4Loading = false;
  state.projects = [];
  state.project = null;
  state.selected = null;
  state.drafts = [];
  state.report = null;
  state.reportError = null;
  renderProjects();
  renderDrafts();
  renderReport();
  editDraft(null, { scroll: false });
  $("#publish-preview").textContent = "";
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#password").focus();
}
setButton($("#logout"), logout);
setButton($("#logout-mobile"), logout);
$("#project-select").addEventListener("change", (e) => chooseProject(e.target.value));
function openProject(editing) {
  state.editingProject = editing;
  $("#project-dialog-title").textContent = editing ? "Project settings" : "New project";
  $("#project-name").value = editing ? state.project.name : "";
  $("#organization-id").value = editing ? state.project.organizationId || "" : "";
  $("#project-dialog").showModal();
}
$("#new-project").addEventListener("click", () => openProject(false));
$("#empty-add").addEventListener("click", () => openProject(false));
$("#settings-open").addEventListener("click", () => openProject(true));
document
  .querySelectorAll("[data-close]")
  .forEach((button) =>
    button.addEventListener("click", () => document.getElementById(button.dataset.close).close()),
  );
$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("[type=submit]");
  try {
    setBusy(button, true);
    const data = {
      name: $("#project-name").value.trim(),
      organizationId: $("#organization-id").value.trim() || null,
    };
    const project = await api(
      state.editingProject ? endpoint() : "/api/projects",
      send(state.editingProject ? "PATCH" : "POST", data),
    );
    $("#project-dialog").close();
    await refreshProjects(project.id);
    message("Project saved.");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
  }
});
setButton($("#connect"), async () => {
  const result = await api(endpoint("/connect"), send("POST", {}));
  const url = safeUrl(result.authorizeUrl);
  if (!url || new URL(url).protocol !== "https:") throw new Error("Invalid authorization URL.");
  location.assign(url);
});
setButton($("#disconnect"), async () => {
  if (!window.confirm("Disconnect this LinkedIn page? Existing drafts and history will remain."))
    return;
  const p = await api(endpoint("/connection"), { method: "DELETE" });
  await refreshProjects(p.id);
  message("LinkedIn disconnected.");
});
$("#draft-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#save-draft");
  try {
    setBusy(button, true);
    const input = currentInput();
    if (!input.body.trim()) throw new Error("Enter post text before saving.");
    const projectId = state.project.id;
    const selected = state.selected;
    const draft = await api(
      selected ? endpoint(`/drafts/${encodeURIComponent(selected.id)}`) : endpoint("/drafts"),
      send(
        selected ? "PATCH" : "POST",
        selected ? { ...input, revision: selected.revision } : input,
      ),
    );
    if (state.project?.id !== projectId) return;
    const sameInput = JSON.stringify(currentInput()) === JSON.stringify(input);
    upsertDraft(draft);
    if (sameInput) editDraft(draft);
    message("Draft saved.");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
    renderPublishButton();
  }
});
for (const selector of ["#draft-body", "#link-url", "#link-title"])
  $(selector).addEventListener("input", renderPublishButton);
$("#new-draft").addEventListener("click", () => editDraft(null));
$("#copy-draft").addEventListener("click", async () => {
  try {
    const { body, linkUrl } = currentInput();
    if (!body.trim()) throw new Error("Write a post to copy first.");
    await navigator.clipboard.writeText(linkUrl ? `${body}\n\n${linkUrl}` : body);
    message("Post copied.");
  } catch (error) {
    showError(error);
  }
});
$("#publish").addEventListener("click", () => {
  if ($("#publish").disabled || !unchanged()) return;
  $("#publish-page").replaceChildren(
    document.createTextNode(`Page: ${state.project.organizationName} `),
  );
  const link = anchor("Verify page ↗", state.project.pageUrl);
  if (link) $("#publish-page").append(link);
  $("#publish-preview").textContent =
    state.selected.body +
    (state.selected.linkUrl
      ? `\n\n${state.selected.linkTitle || ""}\n${state.selected.linkUrl}`
      : "");
  $("#publish-dialog").showModal();
});
setButton($("#confirm-publish"), async () => {
  if (!state.selected || !unchanged()) throw new Error("Save your changes before publishing.");
  const projectId = state.project.id;
  const draft = await api(
    endpoint(`/drafts/${encodeURIComponent(state.selected.id)}/publish`),
    send("POST", { revision: state.selected.revision }),
  );
  $("#publish-dialog").close();
  if (state.project?.id !== projectId) return;
  upsertDraft(draft);
  editDraft(draft);
  message(
    draft.status === "published"
      ? "Post published."
      : "Publishing status updated. Check activity for the result.",
  );
  await loadReport();
});
$("#export-report").addEventListener("click", () => {
  if (!state.project || !state.report) return;
  try {
    const csv = reportCsv(state.project, state.report);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = reportFilename(state.project.name, state.report);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showError(error);
  }
});
$("#period").addEventListener("change", loadReport);
function showView(view) {
  const analytics = view === "analytics";
  $("#publishing-view").hidden = analytics;
  $("#connection-pill").hidden = analytics;
  $("#analytics-view").hidden = !analytics;
  const active = $(analytics ? "#nav-analytics" : "#nav-overview");
  for (const item of document.querySelectorAll(".nav-item")) {
    item.classList.toggle("active", item === active);
    item.removeAttribute("aria-current");
  }
  active.setAttribute("aria-current", "page");
  if (analytics && !state.ga4Loading && !state.ga4Report) void loadGa4Report();
  if (analytics) void loadGscReport();
  if (analytics) window.scrollTo({ top: 0, behavior: "instant" });
}
$("#nav-analytics").addEventListener("click", () => showView("analytics"));
$("#nav-overview").addEventListener("click", () => {
  showView("publishing");
  window.scrollTo({ top: 0, behavior: "instant" });
});
$("#nav-compose").addEventListener("click", () => {
  showView("publishing");
  if (state.project) scrollToSection("#compose");
  else openProject(false);
});
$("#nav-activity").addEventListener("click", () => {
  showView("publishing");
  if (state.project) scrollToSection("#activity");
  else openProject(false);
});
$("#compose-shortcut").addEventListener("click", () => {
  if (state.project) editDraft(null);
  else openProject(false);
});
function renderTable(container, headers, rows) {
  container.replaceChildren();
  if (!rows.length) { container.append(el("p", "empty-state", "No data available.")); return; }
  const table = el("table", "ga-table");
  const head = document.createElement("thead"), headRow = document.createElement("tr");
  for (const label of headers) { const th = el("th", "", label); th.scope = "col"; headRow.append(th); }
  head.append(headRow); table.append(head);
  const body = document.createElement("tbody");
  for (const values of rows) { const tr = document.createElement("tr"); for (const value of values) tr.append(el("td", "", value)); body.append(tr); }
  table.append(body); container.append(table);
}
function renderGa4() {
  const project = state.project, connection = project?.ga4;
  $("#analytics-no-project").hidden = !!project;
  $("#analytics-project").hidden = !project;
  const connected = connection?.status === "connected";
  $("#ga-connect").textContent = state.demo ? "Simulate connection" : "Connect Google Analytics";
  $("#ga-connection-description").textContent = connected ? `Connected to property ${connection.propertyId || "—"}.` : connection?.status === "unconfigured" ? "Configure the Google OAuth app on the server to connect." : "Connect a GA4 property to view website traffic.";
  $("#ga-connect-form").hidden = connected || connection?.status === "unconfigured";
  $("#ga-disconnect").hidden = !connected;
  $("#ga-report-content").hidden = !connected;
  if (state.ga4FormProject !== project?.id) {
    $("#ga-property-id").value = connection?.propertyId || "";
    state.ga4FormProject = project?.id || null;
  }
  $("#ga-export").disabled = !project || !state.ga4Report;
  const report = state.ga4Report;
  $("#ga-period-label").textContent = report ? `Last ${report.days} days · ${report.timezone || "timezone unavailable"}` : "Google Analytics 4";
  const totals = $("#ga-totals"); totals.replaceChildren();
  for (const [key, label] of [["activeUsers", "Active users"], ["sessions", "Sessions"], ["screenPageViews", "Views"], ["keyEvents", "Key events"]]) {
    const item = el("div", "metric"); item.append(el("span", "metric-value", metricText(report?.totals?.[key])), el("span", "metric-label", label)); totals.append(item);
  }
  const warnings = $("#ga-warnings"); warnings.replaceChildren();
  if (state.ga4Error) warnings.append(el("p", "warning", state.ga4Error));
  if (state.ga4Loading) warnings.append(el("p", "empty-state", "Loading analytics…"));
  for (const warning of report?.warnings || []) warnings.append(el("p", "warning", warning));
  $("#ga-timezone").textContent = report?.timezone ? `Property timezone: ${report.timezone}` : "";
  const chart = $("#ga-chart"); chart.replaceChildren();
  const daily = report?.daily || [];
  const chartDates = $("#ga-chart-dates");
  chartDates.replaceChildren();
  if (daily.length > 1) {
    chartDates.append(el("span", "", daily[0].date), el("span", "", daily.at(-1).date));
  }
  const maximum = Math.max(0, ...daily.map(d => typeof d.sessions === "number" && Number.isFinite(d.sessions) ? Math.max(0, d.sessions) : 0));
  for (const item of daily) {
    const bar = el("div", "ga-bar");
    const value = typeof item.sessions === "number" && Number.isFinite(item.sessions) ? Math.max(0, item.sessions) : null;
    bar.title = `${item.date}: ${value === null ? "unavailable" : metricText(value)} sessions`;
    const fill = el("span", value === null ? "ga-bar-fill unavailable" : "ga-bar-fill");
    if (value !== null) fill.style.height = `${maximum > 0 ? Math.max(1, value / maximum * 100) : 1}%`;
    bar.append(fill); chart.append(bar);
  }
  if (!daily.length) chart.append(el("p", "empty-state", connected ? "No daily sessions returned." : "Connect Google Analytics to view traffic."));
  renderTable($("#ga-daily-table"), ["Date", "Sessions"], daily.map(d => [d.date || "—", metricText(d.sessions)]));
  renderTable($("#ga-channels"), ["Channel", "Sessions", "Key events"], (report?.channels || []).map(c => [c.channel || "—", metricText(c.sessions), metricText(c.keyEvents)]));
  renderTable($("#ga-pages"), ["Page path", "Page views"], (report?.pages || []).map(p => [p.path || "—", metricText(p.screenPageViews)]));
}
async function loadGa4Report() {
  const id = state.project?.id, request = ++state.ga4Request;
  state.ga4Report = null; state.ga4Error = null; state.ga4Loading = state.project?.ga4?.status === "connected";
  renderGa4();
  if (!id || !state.ga4Loading) return;
  const days = $("#ga-period").value;
  try {
    const report = await api(`/api/projects/${encodeURIComponent(id)}/ga4/report?days=${encodeURIComponent(days)}`);
    if (state.project?.id === id && request === state.ga4Request) state.ga4Report = report;
  } catch (error) {
    if (state.project?.id === id && request === state.ga4Request) state.ga4Error = `Analytics unavailable: ${error.message}`;
  } finally {
    if (state.project?.id === id && request === state.ga4Request) { state.ga4Loading = false; renderGa4(); }
  }
}
$("#ga-connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#ga-connect"), id = state.project?.id;
  if (!id) return;
  try {
    setBusy(button, true);
    const result = await api(`/api/projects/${encodeURIComponent(id)}/ga4/connect`, send("POST", { propertyId: $("#ga-property-id").value.trim() }));
    if (state.project?.id !== id) return;
    const url = new URL(result.authorizeUrl);
    const valid = state.demo
      ? url.origin === location.origin && url.pathname === "/oauth/google/callback"
      : url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth";
    if (!valid || url.username || url.password) throw new Error("Invalid authorization URL.");
    location.assign(url.href);
  } catch (error) { showError(error); } finally { setBusy(button, false); }
});
setButton($("#ga-disconnect"), async () => {
  const id = state.project?.id;
  if (!id || !window.confirm("Disconnect this Google Analytics property?")) return;
  await api(`/api/projects/${encodeURIComponent(id)}/ga4/connection`, { method: "DELETE" });
  if (state.project?.id === id) { await refreshProjects(id); message("Google Analytics disconnected."); }
});
$("#ga-period").addEventListener("change", loadGa4Report);
$("#analytics-add-project").addEventListener("click", () => openProject(false));
$("#ga-export").addEventListener("click", () => {
  if (!state.project || !state.ga4Report) return;
  try {
    const url = URL.createObjectURL(new Blob([ga4ReportCsv(state.project, state.ga4Report)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = ga4ReportFilename(state.project.name, state.ga4Report.days);
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { showError(error); }
});


function renderGsc() {
  const project = state.project,
    connection = project?.gsc,
    connected = connection?.status === "connected",
    report = state.gscReport;
  $("#gsc-description").textContent = connected
    ? `Connected to ${connection.siteUrl}`
    : connection?.status === "unconfigured"
      ? "Configure Google OAuth to connect."
      : "Connect an authorized Search Console property.";
  $("#gsc-connect").hidden = connected || connection?.status === "unconfigured";
  $("#gsc-disconnect").hidden = !connected;
  $("#gsc-content").hidden = !connected;
  $("#gsc-export").disabled = !report;
  $("#gsc-window").textContent = report
    ? `${report.startDate} – ${report.endDate} · Pacific Time`
    : "Finalized web search data";
  $("#gsc-message").replaceChildren();
  if (state.gscError)
    $("#gsc-message").append(el("p", "warning", state.gscError));
  if (state.gscLoading)
    $("#gsc-message").append(el("p", "empty-state", "Loading Search Console…"));
  for (const warning of report?.warnings || [])
    $("#gsc-message").append(el("p", "warning", warning));
  const fmt = (v) =>
    typeof v === "number" && Number.isFinite(v)
      ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : "—";
  const values = (x) => [
    fmt(x?.clicks),
    fmt(x?.impressions),
    typeof x?.ctr === "number" ? `${fmt(x.ctr * 100)}%` : "—",
    fmt(x?.position),
  ];
  $("#gsc-totals").replaceChildren(
    ...["Clicks", "Impressions", "CTR", "Average position"].map((label, i) => {
      const card = el("div", "metric");
      card.append(
        el("span", "metric-value", values(report?.totals)[i]),
        el("span", "metric-label", label),
      );
      return card;
    }),
  );
  const daily = report?.daily || [],
    chart = $("#gsc-chart"),
    dates = $("#gsc-chart-dates");
  chart.replaceChildren();
  dates.replaceChildren();
  if (daily.length > 1)
    dates.append(
      el("span", "", daily[0].date),
      el("span", "", daily.at(-1).date),
    );
  const max = Math.max(
    0,
    ...daily.map((d) => (typeof d.clicks === "number" ? d.clicks : 0)),
  );
  for (const d of daily) {
    const bar = el("div", "ga-bar"),
      value = typeof d.clicks === "number" ? d.clicks : null,
      fill = el(
        "span",
        value === null ? "ga-bar-fill unavailable" : "ga-bar-fill",
      );
    bar.title = `${d.date}: ${value === null ? "unavailable" : fmt(value)} clicks`;
    if (value !== null)
      fill.style.height = `${max > 0 ? Math.max(1, (value / max) * 100) : 1}%`;
    bar.append(fill);
    chart.append(bar);
  }
  if (!daily.length)
    chart.append(el("p", "empty-state", "No daily data returned."));
  renderTable(
    $("#gsc-daily"),
    ["Date", "Clicks", "Impressions", "CTR", "Position"],
    (report?.daily || []).map((x) => [x.date, ...values(x)]),
  );
  renderTable(
    $("#gsc-queries"),
    ["Query", "Clicks", "Impressions", "CTR", "Position"],
    (report?.queries || []).map((x) => [x.query, ...values(x)]),
  );
  renderTable(
    $("#gsc-pages"),
    ["Page", "Clicks", "Impressions", "CTR", "Position"],
    (report?.pages || []).map((x) => [x.page, ...values(x)]),
  );
}
async function loadGscReport() {
  const id = state.project?.id,
    seq = ++state.gscRequest;
  state.gscReport = null;
  state.gscError = null;
  state.gscLoading = state.project?.gsc?.status === "connected";
  renderGsc();
  if (!id || state.project?.gsc?.status !== "connected") return;
  try {
    const result = await api(
      `/api/projects/${encodeURIComponent(id)}/gsc/report?days=${encodeURIComponent($("#gsc-period").value)}`,
    );
    if (state.project?.id === id && seq === state.gscRequest)
      state.gscReport = result;
  } catch (e) {
    if (state.project?.id === id && seq === state.gscRequest)
      state.gscError = `Search Console unavailable: ${e.message}`;
  } finally {
    if (state.project?.id === id && seq === state.gscRequest) {
      state.gscLoading = false;
      renderGsc();
    }
  }
}
async function loadGscSites() {
  const id = state.project?.id;
  if (!id) return;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(id)}/gsc/sites`);
    if (state.project?.id !== id) return;
    const select = $("#gsc-sites");
    select.replaceChildren();
    for (const site of data.sites) {
      const option = el(
        "option",
        "",
        `${site.siteUrl} (${site.permissionLevel})`,
      );
      option.value = site.siteUrl;
      select.append(option);
    }
    $("#gsc-selection").hidden = false;
    if (!data.sites.length)
      message("No authorized Search Console properties were found.", true);
  } catch (e) {
    showError(e);
  }
}
setButton($("#gsc-connect"), async () => {
  const id = state.project?.id;
  if (!id) return;
  const data = await api(
    `/api/projects/${encodeURIComponent(id)}/gsc/connect`,
    send("POST", {}),
  );
  if (state.project?.id !== id) return;
  const u = new URL(data.authorizeUrl);
  const valid = state.demo
    ? u.origin === location.origin &&
      u.pathname === "/oauth/google/search-console/callback"
    : u.origin === "https://accounts.google.com" &&
      u.pathname === "/o/oauth2/v2/auth";
  if (!valid || u.username || u.password)
    throw new Error("Invalid authorization URL.");
  location.assign(u.href);
});
$("#gsc-select-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = state.project?.id;
  if (!id) return;
  try {
    await api(
      `/api/projects/${encodeURIComponent(id)}/gsc/select`,
      send("POST", { siteUrl: $("#gsc-sites").value }),
    );
    if (state.project?.id === id) {
      $("#gsc-selection").hidden = true;
      await refreshProjects(id);
      await loadGscReport();
      message("Search Console connected.");
    }
  } catch (e) {
    showError(e);
  }
});
setButton($("#gsc-disconnect"), async () => {
  const id = state.project?.id;
  if (!id || !window.confirm("Disconnect Search Console?")) return;
  await api(`/api/projects/${encodeURIComponent(id)}/gsc/connection`, {
    method: "DELETE",
  });
  if (state.project?.id === id) {
    await refreshProjects(id);
    renderGsc();
  }
});
$("#gsc-period").addEventListener("change", loadGscReport);
$("#gsc-export").addEventListener("click", () => {
  if (!state.project || !state.gscReport) return;
  const url = URL.createObjectURL(
    new Blob([gscReportCsv(state.project, state.gscReport)], {
      type: "text/csv;charset=utf-8",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = gscReportFilename(state.project.name, state.gscReport.days);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

start().catch(showError);
