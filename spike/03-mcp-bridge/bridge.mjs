// Spike 3: caad-mcp bridge. Claude Code starts this as a stdio MCP server; the CAAD web page
// connects to it over a localhost WebSocket. Tool calls are forwarded to the page and answered.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";

const PORT = Number(process.env.CAAD_PORT || 7337);
const log = (...a) => console.error("[caad-mcp]", ...a); // stdout belongs to MCP

// --- WebSocket side: one connected CAAD page at a time
let page = null;
let nextId = 1;
const pending = new Map();
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("connection", (ws, req) => {
  log("page connected from", req.headers.origin || "unknown origin");
  page = ws;
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result); }
  });
  ws.on("close", () => { if (page === ws) page = null; log("page disconnected"); });
});
log(`listening for the CAAD page on ws://127.0.0.1:${PORT}`);

function askPage(method, params = {}, timeoutMs = 5000) {
  if (!page) return Promise.reject(new Error("No CAAD page is connected. Open CAAD in the browser."));
  const id = nextId++;
  page.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => pending.delete(id) && reject(new Error(`CAAD page did not answer ${method}`)), timeoutMs);
  });
}

// --- MCP side
const server = new McpServer({ name: "caad", version: "0.0.1" });
const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

server.registerTool("get_selection", {
  description: "What the user has selected in the CAAD view: part, feature, entity type, geometry and a suggested build123d selector.",
  inputSchema: {},
}, async () => text(await askPage("get_selection")));

server.registerTool("highlight", {
  description: "Highlight geometry in the user's CAAD view, e.g. to ask 'do you mean this edge?'.",
  inputSchema: { part: z.string(), selector: z.string().describe("build123d selector, e.g. faces().sort_by(Axis.Z)[-1]"), note: z.string().optional() },
}, async (args) => text(await askPage("highlight", args)));

await server.connect(new StdioServerTransport());
log("MCP server ready on stdio");
