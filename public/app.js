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
    result = params.get("linkedin");
  if (result) {
    params.delete("project");
    params.delete("linkedin");
    history.replaceState(
      null,
      "",
      location.pathname + (params.toString() ? `?${params}` : "") + location.hash,
    );
  }
  const session = await api("/api/session");
  $("#login").hidden = session.authenticated;
  $("#app").hidden = !session.authenticated;
  if (session.authenticated) {
    await refreshProjects(project);
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
$("#period").addEventListener("change", loadReport);
$("#nav-overview").addEventListener("click", () => scrollToSection("#overview"));
$("#nav-compose").addEventListener("click", () => {
  if (state.project) scrollToSection("#compose");
  else openProject(false);
});
$("#nav-activity").addEventListener("click", () => {
  if (state.project) scrollToSection("#activity");
  else openProject(false);
});
$("#compose-shortcut").addEventListener("click", () => {
  if (state.project) editDraft(null);
  else openProject(false);
});
start().catch(showError);
