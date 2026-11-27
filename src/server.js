import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createLinkedIn, LinkedInError } from "./linkedin.js";
import { openStore, StoreError } from "./store.js";

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const minute = 60_000;
const sessionLifetime = 8 * 60 * minute;
const oauthLifetime = 10 * minute;
const maxBody = 32 * 1024;
const uuidPath = "([a-f0-9-]{36})";
const projectRoute = new RegExp(`^/api/projects/${uuidPath}(?:/(.*))?$`);
const draftRoute = new RegExp(`^drafts/${uuidPath}(?:/(publish|reconcile))?$`);
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/report-csv.js", ["report-csv.js", "text/javascript; charset=utf-8"]],
  ["/brand-mark.png", ["brand-mark.png", "image/png"]],
]);

const hash = (value) => createHash("sha256").update(value).digest();
const keyOf = (value) => hash(value).toString("hex");
const newToken = () => randomBytes(32).toString("base64url");

function send(response, status, data) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(data));
}

function redirect(response, path) {
  response.writeHead(303, { Location: path });
  response.end();
}

function setSecurityHeaders(response, secure) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  if (secure) response.setHeader("Strict-Transport-Security", "max-age=31536000");
}

async function readJson(request) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    throw new RequestError(415, "Send a JSON request.");
  }
  if (Number(request.headers["content-length"] ?? 0) > maxBody) {
    request.resume();
    throw new RequestError(413, "Request is too large.");
  }
  const chunks = [];
  let size = 0;
  // The non-destroying iterator lets the server return a 413 response.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBody) {
      request.resume();
      throw new RequestError(413, "Request is too large.");
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "Invalid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "Send a JSON object.");
  }
  return value;
}

function projectInput(input, prior) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const organizationId = Object.hasOwn(input, "organizationId")
    ? input.organizationId === ""
      ? null
      : input.organizationId
    : (prior?.organizationId ?? null);
  if (!name || name.length > 80)
    throw new RequestError(400, "Use a project name of 1–80 characters.");
  if (
    organizationId !== null &&
    (typeof organizationId !== "string" || !/^[1-9]\d{0,18}$/.test(organizationId))
  ) {
    throw new RequestError(400, "Use the numeric LinkedIn company page ID.");
  }
  return { name, organizationId };
}

function draftInput(input) {
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body || body.length > 3000)
    throw new RequestError(400, "Use 1–3,000 characters for the caption.");
  const linkTitle = input.linkTitle == null || input.linkTitle === "" ? null : input.linkTitle;
  if (
    linkTitle !== null &&
    (typeof linkTitle !== "string" || !linkTitle.trim() || linkTitle.length > 200)
  ) {
    throw new RequestError(400, "Use a link title of 1–200 characters.");
  }
  let linkUrl = null;
  if (input.linkUrl != null && input.linkUrl !== "") {
    try {
      if (typeof input.linkUrl !== "string" || input.linkUrl.length > 2000) throw new Error();
      const url = new URL(input.linkUrl);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
      linkUrl = url.href;
    } catch {
      throw new RequestError(400, "Use a public HTTPS link without embedded credentials.");
    }
  }
  if (Boolean(linkUrl) !== Boolean(linkTitle))
    throw new RequestError(400, "Provide both a link and a title, or leave both empty.");
  return { body, linkUrl, linkTitle: linkTitle?.trim() ?? null };
}

function revisionInput(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RequestError(400, "Invalid draft revision.");
  return value;
}

function providerMessage(error) {
  switch (error.status) {
    case 400:
      return "LinkedIn rejected this request. Check the post fields and your app's API version.";
    case 401:
      return "LinkedIn sign-in expired or was revoked. Reconnect the company page.";
    case 403:
      return "LinkedIn did not grant access to this company page or the required app permissions.";
    case 404:
      return "LinkedIn could not find the requested company page.";
    case 429:
      return "LinkedIn rate-limited this request. Try again later.";
    default:
      return "LinkedIn did not return a usable response. Try again later.";
  }
}

export function createApp({ config, store, linkedin, ga4 = null, now = Date.now }) {
  const sessions = new Map();
  const connectionRequests = new Map();
  const ga4Requests = new Map();
  const ga4States = new Map();
  const loginAttempts = new Map();
  const reports = new Map();
  const password = hash(config.password);
  const cookieName = config.secureCookie ? "__Host-social_desk" : "social_desk";

  function setSessionCookie(response, token, age) {
    response.setHeader(
      "Set-Cookie",
      `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${config.secureCookie ? "; Secure" : ""}`,
    );
  }

  function getSession(request) {
    const cookies = (request.headers.cookie ?? "").split(";").map((cookie) => cookie.trim());
    const candidate = cookies
      .find((cookie) => cookie.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (!candidate || !/^[A-Za-z0-9_-]{43}$/.test(candidate)) return null;
    const key = keyOf(candidate);
    const session = sessions.get(key);
    if (!session || session.expires <= now()) {
      sessions.delete(key);
      return null;
    }
    return { key, session };
  }

  async function login(request, response) {
    const address = request.socket.remoteAddress ?? "unknown";
    const current = now();
    for (const [key, attempt] of loginAttempts) {
      if (attempt.until <= current) loginAttempts.delete(key);
    }
    const attempt = loginAttempts.get(address) ?? { count: 0, until: current + 10 * minute };
    if (attempt.count >= 5 || (loginAttempts.size >= 2048 && !loginAttempts.has(address))) {
      response.setHeader("Retry-After", "600");
      throw new RequestError(429, "Too many sign-in attempts. Try again in ten minutes.");
    }
    attempt.count += 1;
    loginAttempts.set(address, attempt);
    const input = await readJson(request);
    if (typeof input.password !== "string" || !timingSafeEqual(password, hash(input.password))) {
      throw new RequestError(401, "Incorrect password.");
    }
    loginAttempts.delete(address);
    for (const [key, candidate] of sessions) {
      if (candidate.expires <= current) sessions.delete(key);
    }
    const previous = getSession(request);
    if (previous) sessions.delete(previous.key);
    if (sessions.size >= 128) throw new RequestError(429, "Too many active sessions.");
    const token = newToken();
    sessions.set(keyOf(token), { expires: current + sessionLifetime, oauth: null });
    setSessionCookie(response, token, Math.floor(sessionLifetime / 1000));
    return send(response, 200, { authenticated: true });
  }

  function projectView(project) {
    return {
      ...project,
      mcpEnabled: Boolean(config.mcpPort),
      connection: linkedin ? project.connection : "unconfigured",
      ga4: { status: !ga4 ? "unconfigured" : store.getGa4Connection(project.id) ? "connected" : "disconnected",
        propertyId: store.getGa4Connection(project.id)?.propertyId ?? null },
    };
  }

  function requireLinkedIn() {
    if (!linkedin) throw new RequestError(409, "Set up the LinkedIn developer app first.");
    return linkedin;
  }

  function useCredentials(projectId) {
    const provider = requireLinkedIn();
    const creds = store.getCredentials(projectId);
    if (!creds || Date.parse(creds.expiresAt) <= now()) {
      throw new RequestError(409, "Connect an active LinkedIn company page first.");
    }
    return { provider, token: creds.accessToken };
  }

  function clearReports(projectId) {
    for (const days of [7, 28, 90]) reports.delete(`${projectId}:${days}`);
  }

  function loadReport(project, days) {
    const { provider, token } = useCredentials(project.id);
    const key = `${project.id}:${days}`;
    const cached = reports.get(key);
    if (cached && cached.expires > now()) return cached.result;
    const result = provider.report(token, project.organizationId, days).catch((error) => {
      if (reports.get(key)?.result === result) reports.delete(key);
      throw error;
    });
    reports.set(key, { expires: now() + minute, result });
    return result;
  }

  function invalidateGa4(projectId) {
    ga4States.delete(projectId);
    ga4Requests.delete(projectId);
  }

  function ga4State(projectId) {
    let state = ga4States.get(projectId);
    if (!state) {
      if (ga4States.size >= 128) ga4States.delete(ga4States.keys().next().value);
      state = { token: null, tokenExpires: 0, refresh: null, reports: new Map() };
      ga4States.set(projectId, state);
    }
    return state;
  }

  function assertGa4Current(projectId, state, propertyId) {
    if (ga4States.get(projectId) !== state || store.getGa4Connection(projectId)?.propertyId !== propertyId) {
      throw new RequestError(409, "Google Analytics connection changed. Try again.");
    }
  }

  async function ga4Report(projectId, days, aggregate = false) {
    if (!ga4) throw new RequestError(409, "Set up Google Analytics first.");
    const connection = store.getGa4Connection(projectId);
    if (!connection) throw new RequestError(409, "Connect a Google Analytics property first.");
    const state = ga4State(projectId);
    const cached = aggregate ? null : state.reports.get(days);
    if (cached && cached.expires > now()) return cached.promise;
    const promise = (async () => {
      try {
        if (!state.token || state.tokenExpires <= now() + 30_000) {
          if (!state.refresh) {
            const refreshToken = store.getGa4RefreshToken(projectId);
            if (!refreshToken) throw new RequestError(409, "Connect a Google Analytics property first.");
            state.refresh = ga4.refresh(refreshToken).then((token) => {
              assertGa4Current(projectId, state, connection.propertyId);
              if (typeof token.accessToken !== "string" || !token.accessToken || !Number.isFinite(Date.parse(token.expiresAt)) || Date.parse(token.expiresAt) <= now()) throw new Error("Invalid Google credentials");
              state.token = token.accessToken;
              state.tokenExpires = Date.parse(token.expiresAt);
            }).finally(() => { state.refresh = null; });
          }
          await state.refresh;
        }
        assertGa4Current(projectId, state, connection.propertyId);
        const report = aggregate ? await ga4.aggregateReport(state.token, connection.propertyId, days) : await ga4.report(state.token, connection.propertyId, days);
        assertGa4Current(projectId, state, connection.propertyId);
        return report;
      } catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError(502, "Google Analytics report is unavailable. Check the connection and permissions.");
      }
    })();
    if (!aggregate) {
      state.reports.set(days, { promise, expires: now() + minute });
      promise.catch(() => { if (state.reports.get(days)?.promise === promise) state.reports.delete(days); });
    }
    return promise;
  }

  async function googleCallback(url, response, auth) {
    const { key, session } = auth;
    const pending = session.ga4oauth;
    const state = url.searchParams.get("state");
    if (!pending || pending.expires <= now() || typeof state !== "string" || pending.stateKey !== keyOf(state) || ga4Requests.get(pending.projectId) !== pending) {
      throw new RequestError(400, "This Google connection request expired. Start again from your project.");
    }
    session.ga4oauth = null;
    const target = `/?project=${pending.projectId}&ga4=`;
    try {
      const code = url.searchParams.get("code");
      if (!ga4 || url.searchParams.has("error") || !code || code.length > 2048) return redirect(response, `${target}error`);
      const creds = await ga4.exchangeCode({ code, verifier: pending.verifier });
      if (typeof creds.accessToken !== "string" || !creds.accessToken || typeof creds.refreshToken !== "string" || !creds.refreshToken || !Number.isFinite(Date.parse(creds.expiresAt)) || Date.parse(creds.expiresAt) <= now()) throw new Error("Invalid Google credentials");
      await ga4.report(creds.accessToken, pending.propertyId, 7);
      if (sessions.get(key) !== session || session.expires <= now() || pending.expires <= now() || ga4Requests.get(pending.projectId) !== pending) return redirect(response, `${target}error`);
      store.setGa4Connection(pending.projectId, { propertyId: pending.propertyId, refreshToken: creds.refreshToken });
      invalidateGa4(pending.projectId);
      return redirect(response, `${target}connected`);
    } catch { return redirect(response, `${target}error`); }
    finally { if (ga4Requests.get(pending.projectId) === pending) ga4Requests.delete(pending.projectId); }
  }

  async function oauthCallback(url, response, auth) {
    const { key, session } = auth;
    const pending = session.oauth;
    const state = url.searchParams.get("state");
    if (
      !pending ||
      pending.expires <= now() ||
      typeof state !== "string" ||
      pending.stateKey !== keyOf(state) ||
      connectionRequests.get(pending.projectId) !== pending.stateKey
    ) {
      throw new RequestError(
        400,
        "This LinkedIn connection request expired. Start again from your project.",
      );
    }
    session.oauth = null;
    const target = `/?project=${pending.projectId}&linkedin=`;
    const code = url.searchParams.get("code");
    try {
      if (url.searchParams.has("error") || !code || code.length > 2048) {
        return redirect(response, `${target}error`);
      }
      const provider = requireLinkedIn();
      const project = store.getProject(pending.projectId);
      if (project.organizationId !== pending.organizationId)
        return redirect(response, `${target}error`);
      const creds = await provider.exchangeCode(code);
      const page = await provider.verifyOrganization(creds.accessToken, pending.organizationId);
      if (
        sessions.get(key) !== session ||
        session.expires <= now() ||
        pending.expires <= now() ||
        connectionRequests.get(project.id) !== pending.stateKey
      ) {
        return redirect(response, `${target}error`);
      }
      store.connect(project.id, { ...page, ...creds });
      clearReports(project.id);
      return redirect(response, `${target}connected`);
    } catch {
      return redirect(response, `${target}error`);
    } finally {
      if (connectionRequests.get(pending.projectId) === pending.stateKey) {
        connectionRequests.delete(pending.projectId);
      }
    }
  }

  async function publish(project, draftId, revision, response) {
    const { provider, token } = useCredentials(project.id);
    const draft = store.claimPublish(project.id, draftId, revision);
    let published;
    try {
      published = await provider.publish(token, project.organizationId, draft);
    } catch (error) {
      const uncertain = !(error instanceof LinkedInError) || error.uncertain;
      const message = uncertain
        ? "LinkedIn did not confirm whether this went live. Check the page or use Find on LinkedIn before taking any further publishing action."
        : providerMessage(error);
      const current = store.finishPublish(project.id, draftId, draft.revision, {
        status: uncertain ? "needs_review" : "draft",
        error: message,
      });
      return send(response, 200, current);
    }
    const current = store.finishPublish(project.id, draftId, draft.revision, {
      status: "published",
      postUrl: published.url,
      publishedAt: new Date(now()).toISOString(),
    });
    clearReports(project.id);
    return send(response, 200, current);
  }

  async function reconcile(project, draftId, response) {
    const draft = store.getDraft(project.id, draftId);
    const started = Date.parse(draft.publishStartedAt ?? draft.updatedAt);
    const stale = draft.status === "publishing" && started <= now() - minute;
    if (draft.status !== "needs_review" && !stale) {
      throw new RequestError(409, "This draft does not have a publishing attempt to check.");
    }
    const { provider, token } = useCredentials(project.id);
    const posts = await provider.listPosts(token, project.organizationId);
    const matches = posts.filter(
      (post) =>
        post.body === draft.body &&
        post.linkUrl === draft.linkUrl &&
        Date.parse(post.publishedAt) >= started - 30_000 &&
        Date.parse(post.publishedAt) <= started + 5 * minute,
    );
    if (matches.length !== 1) {
      throw new RequestError(
        409,
        "A unique matching post could not be verified. Check your page before publishing anything again.",
      );
    }
    const [post] = matches;
    const current = store.completeReconciliation(project.id, draftId, draft.revision, {
      postUrl: post.url,
      publishedAt: post.publishedAt,
    });
    clearReports(project.id);
    return send(response, 200, current);
  }

  async function projectRequest(request, response, url, session, projectId, tail) {
    const project = store.getProject(projectId);
    const method = request.method;
    if (!tail && method === "PATCH") {
      const input = projectInput(await readJson(request), project);
      const updated = store.updateProject(projectId, input);
      return send(response, 200, projectView(updated));
    }
    if (tail === "mcp/grants" && method === "GET") {
      if (!config.mcpPort) throw new RequestError(404, "Not found.");
      return send(response, 200, store.listMcpGrants(projectId));
    }
    if (tail === "mcp/grants" && method === "POST") {
      if (!config.mcpPort) throw new RequestError(404, "Not found.");
      const body = await readJson(request);
      if (![1, 7, 30].includes(body.days)) throw new RequestError(400, "Choose a 1, 7 or 30 day grant.");
      const token = newToken(), createdAt = now();
      const grant = store.createMcpGrant(projectId, keyOf(token), createdAt, createdAt + body.days * 86400000);
      return send(response, 201, { ...grant, token });
    }
    const mcpGrant = tail?.match(new RegExp(`^mcp/grants/${uuidPath}$`));
    if (mcpGrant && method === "DELETE") {
      if (!config.mcpPort) throw new RequestError(404, "Not found.");
      store.revokeMcpGrant(projectId, mcpGrant[1]); return send(response, 200, { revoked: true });
    }
    if (tail === "ga4/connect" && method === "POST") {
      const body = await readJson(request);
      if (!ga4) throw new RequestError(409, "Set up Google Analytics first.");
      if (typeof body.propertyId !== "string" || !/^[1-9]\d{0,19}$/.test(body.propertyId)) throw new RequestError(400, "Use a numeric Google Analytics property ID.");
      for (const [id, pending] of ga4Requests) if (pending.expires <= now()) ga4Requests.delete(id);
      if (ga4Requests.size >= 128 && !ga4Requests.has(projectId)) throw new RequestError(429, "Too many connection requests.");
      const state = newToken(), verifier = newToken();
      const pending = { projectId, propertyId: body.propertyId, stateKey: keyOf(state), verifier, expires: now() + oauthLifetime };
      session.ga4oauth = pending;
      ga4Requests.set(projectId, pending);
      return send(response, 200, { authorizeUrl: ga4.authorizeUrl({ state, challenge: hash(verifier).toString("base64url") }) });
    }
    if (tail === "ga4/connection" && method === "DELETE") {
      store.disconnectGa4(projectId);
      invalidateGa4(projectId);
      if (session.ga4oauth?.projectId === projectId) session.ga4oauth = null;
      return send(response, 200, projectView(store.getProject(projectId)));
    }
    if (tail === "ga4/report" && method === "GET") {
      const days = Number(url.searchParams.get("days") ?? "28");
      if (![7, 28, 90].includes(days)) throw new RequestError(400, "Choose 7, 28 or 90 days.");
      return send(response, 200, await ga4Report(projectId, days));
    }
    if (tail === "connect" && method === "POST") {
      await readJson(request);
      const provider = requireLinkedIn();
      if (!project.organizationId)
        throw new RequestError(409, "Add your LinkedIn company page ID first.");
      const state = newToken();
      session.oauth = {
        projectId,
        organizationId: project.organizationId,
        stateKey: keyOf(state),
        expires: now() + oauthLifetime,
      };
      connectionRequests.set(projectId, session.oauth.stateKey);
      return send(response, 200, { authorizeUrl: provider.authorizeUrl(state) });
    }
    if (tail === "connection" && method === "DELETE") {
      const updated = store.disconnect(projectId);
      connectionRequests.delete(projectId);
      if (session.oauth?.projectId === projectId) session.oauth = null;
      clearReports(projectId);
      return send(response, 200, projectView(updated));
    }
    if (tail === "drafts" && method === "GET")
      return send(response, 200, store.listDrafts(projectId));
    if (tail === "drafts" && method === "POST") {
      const input = draftInput(await readJson(request));
      return send(response, 201, store.createDraft(projectId, input));
    }
    if (tail === "report" && method === "GET") {
      const days = Number(url.searchParams.get("days") ?? "28");
      if (![7, 28, 90].includes(days)) throw new RequestError(400, "Choose 7, 28 or 90 days.");
      return send(response, 200, await loadReport(project, days));
    }
    const match = tail?.match(draftRoute);
    if (match) {
      const [, draftId, action] = match;
      if (!action && method === "PATCH") {
        const input = await readJson(request);
        return send(
          response,
          200,
          store.updateDraft(projectId, draftId, revisionInput(input.revision), draftInput(input)),
        );
      }
      if (action === "publish" && method === "POST") {
        const { revision } = await readJson(request);
        return publish(project, draftId, revisionInput(revision), response);
      }
      if (action === "reconcile" && method === "POST") {
        await readJson(request);
        return reconcile(project, draftId, response);
      }
    }
    throw new RequestError(404, "Not found.");
  }

  async function handle(request, response) {
    setSecurityHeaders(response, config.secureCookie);
    const method = request.method;
    if (
      request.headers.host !== config.origin.host ||
      !request.url?.startsWith("/") ||
      request.url.startsWith("//")
    ) {
      throw new RequestError(400, "Invalid request host.");
    }
    const url = new URL(request.url, config.origin);
    if (url.origin !== config.origin.origin) throw new RequestError(400, "Invalid request target.");

    const asset = assets.get(url.pathname);
    if (asset && (method === "GET" || method === "HEAD")) {
      const [file, type] = asset;
      const bytes = await readFile(new URL(`../public/${file}`, import.meta.url));
      response.writeHead(200, { "Content-Type": type, "Content-Length": bytes.length });
      return response.end(method === "HEAD" ? undefined : bytes);
    }
    if (method !== "GET" && request.headers.origin !== config.origin.origin) {
      throw new RequestError(403, "This action must originate from Social Post Desk.");
    }
    const auth = getSession(request);
    if (url.pathname === "/api/session" && method === "GET") {
      return send(response, 200, {
        authenticated: Boolean(auth),
        redirectUri: auth ? (config.linkedin?.redirectUri ?? null) : null,
        demo: config.demo === true,
      });
    }
    if (url.pathname === "/api/login" && method === "POST") return login(request, response);
    if (!auth) throw new RequestError(401, "Sign in to continue.");
    if (url.pathname === "/oauth/google/callback" && method === "GET") return googleCallback(url, response, auth);
    if (url.pathname === "/oauth/linkedin/callback" && method === "GET")
      return oauthCallback(url, response, auth);
    if (url.pathname === "/api/logout" && method === "POST") {
      sessions.delete(auth.key);
      setSessionCookie(response, "", 0);
      return send(response, 200, { authenticated: false });
    }
    if (url.pathname === "/api/projects" && method === "GET")
      return send(response, 200, store.listProjects().map(projectView));
    if (url.pathname === "/api/projects" && method === "POST") {
      const input = projectInput(await readJson(request));
      return send(response, 201, projectView(store.createProject(input)));
    }
    const match = url.pathname.match(projectRoute);
    if (match) return projectRequest(request, response, url, auth.session, match[1], match[2]);
    throw new RequestError(404, "Not found.");
  }

  const server = createServer(
    { requestTimeout: 45_000, headersTimeout: 15_000, maxHeaderSize: 8192 },
    (req, res) => {
      void handle(req, res).catch((error) => {
        if (res.headersSent) return res.end();
        if (error instanceof RequestError || error instanceof StoreError)
          return send(res, error.status, { error: error.message });
        if (error instanceof LinkedInError) {
          return send(res, error.status === 401 || error.status === 403 ? 409 : 502, {
            error: providerMessage(error),
          });
        }
        // Never log request bodies, bearer tokens, OAuth query strings or provider payloads.
        return send(res, 500, {
          error: "An unexpected error occurred. The operation was not confirmed.",
        });
      });
    },
  );

  // Limit provider load independently of the dashboard's caches.
  let mcpActive = 0;
  const mcpRates = new Map();
  function beginMcpReport(grantId) {
    const timestamp = now();
    for (const [id, bucket] of mcpRates) if (!bucket.active && bucket.starts.every(start => start <= timestamp - minute)) mcpRates.delete(id);
    let bucket = mcpRates.get(grantId);
    if (!bucket) {
      if (mcpRates.size >= 2048) throw new RequestError(429, "Reporting is busy.");
      bucket = { active: 0, starts: [] }; mcpRates.set(grantId, bucket);
    }
    bucket.starts = bucket.starts.filter(start => start > timestamp - minute);
    if (mcpActive >= 8 || bucket.active >= 2 || bucket.starts.length >= 30) throw new RequestError(429, "Reporting is busy.");
    bucket.active++; mcpActive++; bucket.starts.push(timestamp);
    return () => { bucket.active--; mcpActive--; };
  }
  // This listener is separate from the app and never bound to a public interface.
  server.createMcpListener = () => {
    if (!config.mcpPort) throw new Error("MCP reporting is disabled.");
    return createServer({ requestTimeout: 45_000, headersTimeout: 15_000, maxHeaderSize: 8192 }, (req, res) => {
      void (async () => {
        setSecurityHeaders(res, false);
        const headers = Object.keys(req.headers);
        if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== `127.0.0.1:${req.socket.localPort}` ||
            headers.some(h => h === "origin" || h === "forwarded" || h.startsWith("x-forwarded-") || h === "x-real-ip" || h === "via" || h === "cookie") ||
            req.method !== "GET" || !req.url?.startsWith("/") || req.url.startsWith("//")) throw new RequestError(403, "Request rejected.");
        const authorization = req.headers.authorization ?? "";
        if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw new RequestError(401, "Invalid or expired grant.");
        const tokenHash = keyOf(authorization.slice(7));
        const grant = store.findMcpGrant(tokenHash, now());
        if (!grant) throw new RequestError(401, "Invalid or expired grant.");
        const url = new URL(req.url, `http://127.0.0.1:${req.socket.localPort}`);
        if (url.pathname === "/projects" && !url.search) {
          const p = store.getProject(grant.projectId);
          return send(res, 200, { projects: [{ id: p.id, name: p.name }] });
        }
        const match = url.pathname.match(new RegExp(`^/projects/${uuidPath}/(ga4|linkedin)$`));
        if (!match || match[1] !== grant.projectId) throw new RequestError(404, "Not found.");
        if ([...url.searchParams.keys()].some(k => k !== "days") || url.searchParams.getAll("days").length !== 1 || !["7", "28", "90"].includes(url.searchParams.get("days"))) throw new RequestError(400, "Choose 7, 28 or 90 days.");
        const days = Number(url.searchParams.get("days")), project = store.getProject(grant.projectId);
        let result, linkedInToken = null;
        const finish = beginMcpReport(grant.id);
        try {
          if (match[2] === "ga4") result = await ga4Report(grant.projectId, days, true);
          else { const { provider, token } = useCredentials(project.id); linkedInToken = token; result = await provider.aggregateReport(token, project.organizationId, days); }
        } finally { finish(); }
        // Revocation, expiry or a disconnected/replaced account suppresses in-flight results.
        const current = store.findMcpGrant(tokenHash, now());
        if (!current || current.id !== grant.id) throw new RequestError(401, "Invalid or expired grant.");
        if (linkedInToken !== null) {
          const credentials = store.getCredentials(project.id), latest = store.getProject(project.id);
          if (!credentials || credentials.accessToken !== linkedInToken || Date.parse(credentials.expiresAt) <= now() || latest.organizationId !== project.organizationId) throw new RequestError(409, "LinkedIn connection changed.");
        }
        const safeNumber = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
        const keys = match[2] === "ga4" ? ["activeUsers", "sessions", "screenPageViews", "keyEvents"] : ["impressions", "clicks", "reactions", "comments", "shares"];
        const totals = Object.fromEntries(keys.map(k => [k, safeNumber(result.totals?.[k])]));
        const allowedWarnings = new Set(["Totals: results may be subject to data thresholds.", "Totals: results are sampled.", "Totals: some data may be grouped into an other row.", "Totals: Google reports data truncation.", "Totals: some metrics are restricted.", "Totals: Google returned an empty report.", "Totals: report rows were limited.", "Totals: no data was returned.", "Property timezone or exact dates are unavailable.", "No aggregate statistics were returned.", "Aggregate statistics could not be retrieved."]);
        const warnings = (Array.isArray(result.warnings) ? result.warnings : []).filter(w => allowedWarnings.has(w));
        if (match[2] === "ga4") return send(res, 200, { days, timezone: typeof result.timezone === "string" && /^[A-Za-z0-9_+\/-]{1,100}$/.test(result.timezone) ? result.timezone : null,
          startDate: /^\d{4}-\d{2}-\d{2}$/.test(result.startDate ?? "") ? result.startDate : null, endDate: /^\d{4}-\d{2}-\d{2}$/.test(result.endDate ?? "") ? result.endDate : null, totals, warnings });
        return send(res, 200, { days, from: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(result.from ?? "") ? result.from : null,
          to: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(result.to ?? "") ? result.to : null, totals, warnings });
      })().catch(error => { if (!res.headersSent) send(res, error instanceof RequestError ? error.status : 502, { error: error instanceof RequestError && error.status < 500 ? error.message : "Aggregate report is unavailable." }); else res.end(); });
    });
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const store = openStore({ filename: config.filename, key: config.key });
    const linkedin = config.linkedin ? createLinkedIn(config.linkedin) : null;
    const ga4 = config.ga4 ? (await import("./ga4.js")).createGa4(config.ga4) : null;
    const server = createApp({ config, store, linkedin, ga4 });
    const mcpListener = config.mcpPort ? server.createMcpListener() : null;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const listeners = [server, mcpListener].filter(Boolean);
      let remaining = listeners.length;
      for (const listener of listeners) listener.close(() => { if (--remaining === 0) store.close(); });
    };
    for (const listener of [server, mcpListener].filter(Boolean)) listener.on("error", () => {
      console.error("A server could not listen on its configured address.");
      process.exitCode = 1; stop();
    });
    server.listen(config.port, config.host, () => console.log(`Social Post Desk listening at ${config.origin.origin}`));
    if (mcpListener) mcpListener.listen(config.mcpPort, "127.0.0.1", () => console.log("Local MCP reporting listener enabled."));
    for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not start Social Post Desk.");
    process.exitCode = 1;
  }
}
