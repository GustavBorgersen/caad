// Bridge test: start caad-mcp the way an agent does (official MCP client over stdio), connect a fake CAAD page
// over WebSocket, and check tool calls go through, origins are enforced and tools update.
// Needs the binary: `npm run build:bridge`, or CAAD_MCP=path; skipped without one.
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { bridgeBinary, check } from "../common.mjs";

const BIN = bridgeBinary();
const skip = !BIN && "no caad-mcp binary (npm run build:bridge, or set CAAD_MCP)";
const it = (name, fn) => test(name, { skip, timeout: 30_000 }, fn); // a hang (the bridge not answering) fails instead of blocking

let client, transport, port, page;
let toolsChanged = false;
before(async () => {
  if (skip) return;
  client = new Client({ name: "bridge-test", version: "0" }, { capabilities: {} });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { toolsChanged = true; });
  transport = new StdioClientTransport({ command: BIN, args: ["--allow-origin", "https://caad.example.com"], stderr: "pipe" });
  // The bridge takes the first free port from 7337 up (another agent session, or test, may have 7337).
  const found = new Promise((resolve) => {
    let log = "";
    transport.stderr.on("data", (d) => { log += d; const m = log.match(/ws:\/\/127\.0\.0\.1:(\d+)/); if (m) resolve(Number(m[1])); });
  });
  await client.connect(transport);
  port = await found;
});
after(async () => {
  page?.close();
  await client?.close().catch(() => {});
  try { if (transport?.pid) process.kill(transport.pid); } catch { /* gone already */ }
});

const connect = (origin) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin } });
  // The bridge greets as soon as it accepts: listen before "open", or the hello can come before the test listens.
  ws.hello = new Promise((res) => ws.once("message", (m) => res(JSON.parse(m))));
  ws.on("open", () => resolve(ws));
  ws.on("error", () => resolve(null));
  ws.on("unexpected-response", () => resolve(null));
});

it("instructions and the embedded tools on connect", async () => {
  check(client.getInstructions()?.includes("CAAD"), "instructions sent on connect");
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(tools.includes("get_selection") && tools.includes("write_part"), "embedded tools listed", tools);
});

it("without a page: get_status explains, other tools fail clearly", async () => {
  let r = await client.callTool({ name: "get_status", arguments: {} });
  check(!r.isError && r.content[0].text.includes("no CAAD page"), "get_status without a page explains what to do", r.content[0].text);
  r = await client.callTool({ name: "get_selection", arguments: {} });
  check(r.isError, "other tools fail clearly without a page");
});

it("origins: another is rejected, the allowed one connects and is greeted", async () => {
  check((await connect("https://evil.example.org")) === null, "page from another origin is rejected");
  page = await connect("https://caad.example.com");
  check(page !== null, "page from the allowed origin connects");
  const hello = await page.hello;
  check(hello.type === "hello" && hello.agent === "bridge-test", "bridge says hello with the agent's name", hello);
});

it("tool calls reach the page and back; its tool list is used", async () => {
  page.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== "call") return;
    const answers = {
      get_selection: { content: [{ type: "text", text: "bracket.edges().filter_by(Axis.Z)" }] },
      render: { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] },
    };
    page.send(JSON.stringify(answers[m.name] ? { type: "result", id: m.id, result: answers[m.name] } : { type: "result", id: m.id, error: `unknown tool ${m.name}` }));
  });
  page.send(JSON.stringify({ type: "hello", tools: [{ name: "get_selection", description: "x", inputSchema: { type: "object" } }, { name: "render", description: "y", inputSchema: { type: "object" } }, { name: "new_tool", description: "z", inputSchema: { type: "object" } }] }));
  await new Promise((res) => setTimeout(res, 200));
  let r = await client.callTool({ name: "get_selection", arguments: {} });
  check(r.content[0].text === "bracket.edges().filter_by(Axis.Z)", "tool call reaches the page and back");
  r = await client.callTool({ name: "render", arguments: { view: "iso" } });
  check(r.content[0].type === "image", "images pass through");
  r = await client.callTool({ name: "nope", arguments: {} });
  check(r.isError && r.content[0].text.includes("unknown tool"), "page errors come back as tool errors");
  check(toolsChanged, "agent is told when the page brings a different tool list");
  check((await client.listTools()).tools.some((t) => t.name === "new_tool"), "the page's tool list is used");
});
