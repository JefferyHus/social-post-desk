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

export function createApp({ config, store, linkedin, now = Date.now }) {
  const sessions = new Map();
  const connectionRequests = new Map();
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
      connection: linkedin ? project.connection : "unconfigured",
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
      });
    }
    if (url.pathname === "/api/login" && method === "POST") return login(request, response);
    if (!auth) throw new RequestError(401, "Sign in to continue.");
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

  return createServer(
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const store = openStore({ filename: config.filename, key: config.key });
    const linkedin = config.linkedin ? createLinkedIn(config.linkedin) : null;
    const server = createApp({ config, store, linkedin });
    server.on("error", () => {
      console.error("The server could not listen on the configured address.");
      store.close();
      process.exitCode = 1;
    });
    server.listen(config.port, config.host, () =>
      console.log(`Social Post Desk listening at ${config.origin.origin}`),
    );
    for (const signal of ["SIGTERM", "SIGINT"]) {
      process.once(signal, () => server.close(() => store.close()));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not start Social Post Desk.");
    process.exitCode = 1;
  }
}
