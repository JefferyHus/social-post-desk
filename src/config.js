import { resolve } from "node:path";

const isLoopback = (host) => ["127.0.0.1", "::1", "[::1]", "localhost"].includes(host);

export function loadConfig(env = process.env) {
  const password = env.SOCIAL_DESK_PASSWORD ?? "";
  if (password.length < 16 || password.length > 256) {
    throw new Error("Set SOCIAL_DESK_PASSWORD to a long, unique password (16–256 characters).");
  }
  const rawKey = env.SOCIAL_DESK_ENCRYPTION_KEY ?? "";
  if (!/^[a-fA-F0-9]{64}$/.test(rawKey)) {
    throw new Error(
      "Set SOCIAL_DESK_ENCRYPTION_KEY to 32 random bytes encoded as 64 hex characters.",
    );
  }

  const origin = new URL(env.APP_ORIGIN || "http://127.0.0.1:3000");
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (origin.protocol !== "https:" && !(origin.protocol === "http:" && isLoopback(origin.hostname)))
  ) {
    throw new Error("APP_ORIGIN must be a bare HTTPS origin or a local HTTP loopback origin.");
  }
  const host = env.HOST || "127.0.0.1";
  if (!isLoopback(host) || host === "[::1]") {
    throw new Error(
      "Bind to a loopback host. Use a same-host TLS reverse proxy for remote access.",
    );
  }
  const port = Number(env.PORT || (origin.protocol === "http:" ? origin.port || "80" : "3000"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");

  let mcpPort = null;
  if (env.MCP_REPORT_PORT) {
    if (!/^[1-9]\d{0,4}$/.test(env.MCP_REPORT_PORT)) throw new Error("MCP_REPORT_PORT must be a valid numeric port.");
    mcpPort = Number(env.MCP_REPORT_PORT);
    if (mcpPort > 65535 || mcpPort === port) throw new Error("MCP_REPORT_PORT must be a different valid port.");
  }
  const clientId = env.LINKEDIN_CLIENT_ID?.trim();
  const clientSecret = env.LINKEDIN_CLIENT_SECRET?.trim();
  if (Boolean(clientId) !== Boolean(clientSecret))
    throw new Error("Configure both LinkedIn app credentials together.");
  const version = env.LINKEDIN_API_VERSION || "202611";
  if (!/^20\d{2}(0[1-9]|1[0-2])$/.test(version))
    throw new Error("LINKEDIN_API_VERSION must use YYYYMM.");
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) throw new Error("Configure both Google app credentials together.");
  const redirectUri = new URL("/oauth/linkedin/callback", origin).href;
  const googleRedirectUri = new URL("/oauth/google/callback", origin).href;
  return {
    password,
    key: Buffer.from(rawKey, "hex"),
    origin,
    host,
    port,
    mcpPort,
    secureCookie: origin.protocol === "https:",
    filename: resolve(env.DATA_DIR || "data", "social-post-desk.sqlite"),
    linkedin: clientId && clientSecret ? { clientId, clientSecret, version, redirectUri } : null,
    ga4: googleClientId && googleClientSecret ? { clientId: googleClientId, clientSecret: googleClientSecret, redirectUri: googleRedirectUri } : null,
  };
}
