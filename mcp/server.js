// Local-only bridge: this process receives a scoped reporting grant, never provider credentials.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { request, Agent } from "node:http";

function readToken() {
  const path = process.env.SOCIAL_DESK_MCP_TOKEN_FILE;
  if (!path) return process.env.SOCIAL_DESK_MCP_TOKEN ?? "";
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 || (stat.mode & 0o077) || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error();
    return readFileSync(fd, "utf8").trim();
  } catch { return ""; }
  finally { if (fd !== undefined) closeSync(fd); }
}
const token = readToken();
const port = process.env.SOCIAL_DESK_MCP_PORT ?? "";
if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) {
  console.error("Set a valid local MCP reporting port and scoped grant in the bridge environment.");
  process.exit(1);
}
// A dedicated direct agent avoids environment-configured HTTP proxies.
const directAgent = new Agent({ keepAlive: false });
function fetchReport(path) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: Number(port), path, method: "GET", agent: directAgent,
      headers: { authorization: `Bearer ${token}` }, timeout: 30000 }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error("Report unavailable")); return; }
      const chunks = []; let size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > 65536) { response.destroy(new Error("Report too large")); return; } chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => { try { const result = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(); resolve(result); } catch { reject(new Error("Invalid report")); } });
    });
    req.on("timeout", () => req.destroy(new Error("Timeout"))); req.on("error", reject); req.end();
  });
}
const textResult = async operation => {
  try { const result = await operation(); return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }; }
  catch { return { isError: true, content: [{ type: "text", text: "Reporting is unavailable or the grant was revoked." }] }; }
};
const schema = z.object({ projectId: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/), days: z.union([z.literal(7), z.literal(28), z.literal(90)]) }).strict();
const metric = z.number().nonnegative().nullable();
const projectOutput = z.object({ projects: z.array(z.object({ id: z.string(), name: z.string() })) });
const gaOutput = z.object({ days: z.number(), timezone: z.string().nullable(), startDate: z.string().nullable(), endDate: z.string().nullable(), totals: z.object({ activeUsers: metric, sessions: metric, screenPageViews: metric, keyEvents: metric }), warnings: z.array(z.string()) });
const liOutput = z.object({ days: z.number(), from: z.string().nullable(), to: z.string().nullable(), totals: z.object({ impressions: metric, clicks: metric, reactions: metric, comments: metric, shares: metric }), warnings: z.array(z.string()) });
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
function createServer() {
  const server = new McpServer({ name: "social-post-desk-reports", version: "0.1.0" });
  server.registerTool("list_authorized_projects", { description: "List only the project authorized by this read-only local reporting grant.", inputSchema: z.object({}).strict(), outputSchema: projectOutput, annotations },
    async () => textResult(() => fetchReport("/projects")));
  server.registerTool("get_ga4_aggregate", { description: "Read aggregate website analytics for the authorized project. Null means unavailable. Dates use the GA4 property timezone.", inputSchema: schema, outputSchema: gaOutput, annotations },
    async ({ projectId, days }) => textResult(() => fetchReport(`/projects/${projectId}/ga4?days=${days}`)));
  server.registerTool("get_linkedin_aggregate", { description: "Read aggregate LinkedIn company page metrics for the authorized project. Null means unavailable. The returned interval is UTC.", inputSchema: schema, outputSchema: liOutput, annotations },
    async ({ projectId, days }) => textResult(() => fetchReport(`/projects/${projectId}/linkedin?days=${days}`)));
  return server;
}
serveStdio(createServer);
