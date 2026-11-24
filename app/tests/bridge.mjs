// Bridge test: start caad-mcp the way an agent does (official MCP client over stdio), connect a fake
// CAAD page over WebSocket, and check tool calls go through, origins are enforced and tools update.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";

const BIN = process.env.CAAD_MCP ?? "../bridge/caad-mcp";
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}`); if (!ok) process.exitCode = 1; };

const client = new Client({ name: "bridge-test", version: "0" }, { capabilities: {} });
let toolsChanged = false;
client.setNotificationHandler(ToolListChangedNotificationSchema, () => { toolsChanged = true; });
await client.connect(new StdioClientTransport({ command: BIN, args: ["--allow-origin", "https://caad.example.com"], stderr: "ignore" }));
check(client.getInstructions()?.includes("CAAD"), "instructions sent on connect");
const tools = (await client.listTools()).tools.map((t) => t.name);
check(tools.includes("get_selection") && tools.includes("write_part"), `embedded tools listed (${tools.length})`);

let r = await client.callTool({ name: "get_status", arguments: {} });
check(!r.isError && r.content[0].text.includes("no CAAD page"), "get_status without a page explains what to do");
r = await client.callTool({ name: "get_selection", arguments: {} });
check(r.isError, "other tools fail clearly without a page");

const connect = (origin) => new Promise((resolve) => {
  const ws = new WebSocket("ws://127.0.0.1:7337", { headers: { origin } });
  ws.on("open", () => resolve(ws));
  ws.on("error", () => resolve(null));
  ws.on("unexpected-response", () => resolve(null));
});
check((await connect("https://evil.example.org")) === null, "page from another origin is rejected");

const page = await connect("https://caad.example.com");
check(page !== null, "page from the allowed origin connects");
const hello = await new Promise((res) => page.once("message", (m) => res(JSON.parse(m))));
check(hello.type === "hello" && hello.agent === "bridge-test", `bridge says hello (agent: ${hello.agent})`);
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

r = await client.callTool({ name: "get_selection", arguments: {} });
check(r.content[0].text === "bracket.edges().filter_by(Axis.Z)", "tool call reaches the page and back");
r = await client.callTool({ name: "render", arguments: { view: "iso" } });
check(r.content[0].type === "image", "images pass through");
r = await client.callTool({ name: "nope", arguments: {} });
check(r.isError && r.content[0].text.includes("unknown tool"), "page errors come back as tool errors");
check(toolsChanged, "agent is told when the page brings a different tool list");
check((await client.listTools()).tools.some((t) => t.name === "new_tool"), "the page's tool list is used");

page.close();
await client.close();
