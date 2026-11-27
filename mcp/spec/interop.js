import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadConfig } from "../../src/config.js";
import { openStore } from "../../src/store.js";
import { createApp } from "../../src/server.js";

test("official SDK negotiates stdio, gets only authorized aggregates and honors revocation", async t => {
  const config = loadConfig({ SOCIAL_DESK_PASSWORD: "test-password-long-enough", SOCIAL_DESK_ENCRYPTION_KEY: "42".repeat(32), MCP_REPORT_PORT: "32001" });
  const store = openStore({ filename: ":memory:", key: config.key });
  const project = store.createProject({ name: "Fictional", organizationId: "123" });
  store.connect(project.id, { id: "123", accessToken: "fake-provider-secret", expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const linkedin = { async aggregateReport() { return { from: "2026-01-01T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z", totals: { impressions: 7, clicks: 0 }, warnings: [], posts: [{ body: "private" }] }; } };
  const app = createApp({ config, store, linkedin }), listener = app.createMcpListener(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const token = randomBytes(32).toString("base64url"), hash = createHash("sha256").update(token).digest("hex");
  const grant = store.createMcpGrant(project.id, hash, Date.now(), Date.now() + 3600000);
  const directory = mkdtempSync(join(tmpdir(), "spd-mcp-")), file = join(directory, "grant");
  writeFileSync(file, token, { mode: 0o600 }); chmodSync(file, 0o600);
  const client = new Client({ name: "synthetic-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("server.js")], env: { PATH: process.env.PATH, SOCIAL_DESK_MCP_TOKEN_FILE: file, SOCIAL_DESK_MCP_PORT: String(listener.address().port), HTTP_PROXY: "http://127.0.0.1:1", NODE_USE_ENV_PROXY: "1" }, stderr: "pipe" });
  t.after(async () => { await client.close(); await new Promise(resolve => listener.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(t => t.name).sort(); assert.deepEqual(names, ["get_ga4_aggregate", "get_linkedin_aggregate", "list_authorized_projects"]);
  const list = await client.callTool({ name: "list_authorized_projects", arguments: {} }); assert.equal(list.structuredContent.projects[0].id, project.id);
  const result = await client.callTool({ name: "get_linkedin_aggregate", arguments: { projectId: project.id, days: 7 } });
  assert.equal(result.structuredContent.totals.impressions, 7); assert.equal(result.structuredContent.totals.clicks, 0); assert.equal(result.structuredContent.totals.shares, null);
  assert.doesNotMatch(JSON.stringify(result), /private|fake-provider-secret/);
  const bad = await client.callTool({ name: "get_linkedin_aggregate", arguments: { projectId: project.id, days: 14 } }); assert.equal(bad.isError, true);
  // Also negotiate the current 2026 protocol. The client above uses the 2025 handshake.
  const modern = new Client({ name: "modern-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  const modernTransport = new StdioClientTransport({ command: process.execPath, args: [resolve("server.js")], env: { PATH: process.env.PATH, SOCIAL_DESK_MCP_TOKEN_FILE: file, SOCIAL_DESK_MCP_PORT: String(listener.address().port) }, stderr: "pipe" });
  await modern.connect(modernTransport);
  try { assert.equal((await modern.callTool({ name: "list_authorized_projects", arguments: {} })).structuredContent.projects[0].id, project.id); }
  finally { await modern.close(); }
  store.revokeMcpGrant(project.id, grant.id);
  const revoked = await client.callTool({ name: "list_authorized_projects", arguments: {} }); assert.equal(revoked.isError, true); assert.doesNotMatch(JSON.stringify(revoked), new RegExp(token));
});

test("bridge refuses symlinked or non-private token files without printing the token", () => {
  const directory = mkdtempSync(join(tmpdir(), "spd-mcp-permissions-")), file = join(directory, "grant"), link = join(directory, "link"), secret = "x".repeat(43);
  try {
    writeFileSync(file, secret, { mode: 0o644 }); chmodSync(file, 0o644); symlinkSync(file, link);
    for (const candidate of [file, link]) {
      const child = spawnSync(process.execPath, [resolve("server.js")], { env: { PATH: process.env.PATH, SOCIAL_DESK_MCP_TOKEN_FILE: candidate, SOCIAL_DESK_MCP_PORT: "3011" }, encoding: "utf8", timeout: 5000 });
      assert.equal(child.status, 1); assert.doesNotMatch(child.stdout + child.stderr, new RegExp(secret));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
