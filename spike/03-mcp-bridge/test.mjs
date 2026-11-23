// Spike 3 test: start the bridge the way Claude Code would (stdio MCP), connect a fake CAAD page
// over WebSocket, and check selection and highlight travel both ways.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

const client = new Client({ name: "test-agent", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["bridge.mjs"], stderr: "inherit" }));
console.log("tools:", (await client.listTools()).tools.map((t) => t.name));

// Before a page connects, tools should fail clearly.
const early = await client.callTool({ name: "get_selection", arguments: {} });
console.log("without page:", early.isError ? "error ->" : "ok ->", early.content[0].text);

// The fake page: answers like the real UI would.
const highlighted = [];
const page = new WebSocket("ws://127.0.0.1:7337", { headers: { origin: "https://caad.example.app" } });
await new Promise((r) => page.on("open", r));
page.on("message", (raw) => {
  const { id, method, params } = JSON.parse(raw);
  if (method === "get_selection") {
    page.send(JSON.stringify({ id, result: {
      part: "pump_body.py", feature: "Cylinder Ø100 (line 4)", entity: "face", geom_type: "PLANE",
      center: [264, 63, 25], normal: [0, -1, 0], area_mm2: 4004,
      selector: "body.faces().sort_by(Axis.Y)[0]",
    } }));
  } else if (method === "highlight") {
    highlighted.push(params);
    page.send(JSON.stringify({ id, result: { highlighted: 1 } }));
  }
});
await new Promise((r) => setTimeout(r, 100));

const sel = await client.callTool({ name: "get_selection", arguments: {} });
console.log("selection from page:", sel.content[0].text.replace(/\s+/g, " "));
const hl = await client.callTool({ name: "highlight", arguments: { part: "pump_body.py", selector: "edges().filter_by(GeomType.CIRCLE)", note: "these edges?" } });
console.log("highlight result:", hl.content[0].text.replace(/\s+/g, " "), "| page received:", JSON.stringify(highlighted));

page.close();
await client.close();
process.exit(0);
