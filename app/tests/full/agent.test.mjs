// End to end: the real bridge binary (started by the official MCP client, as Claude Code does) and the real app.
// The test plays the agent and uses every tool. Needs the binary: `npm run build:bridge`, or CAAD_MCP=path;
// skipped without one.
import { after, test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { bridgeBinary, check } from "../common.mjs";
import { openApp, steps } from "../ui/env.mjs";

const BIN = bridgeBinary();
if (!BIN) test("agent end to end", { skip: "no caad-mcp binary (npm run build:bridge, or set CAAD_MCP)" }, () => {});
else await run();

async function run() {
  const client = new Client({ name: "e2e-agent", version: "0" });
  const transport = new StdioClientTransport({ command: BIN, stderr: "pipe" });
  const found = new Promise((resolve) => {
    let log = "";
    transport.stderr.on("data", (d) => { log += d; const m = log.match(/ws:\/\/127\.0\.0\.1:(\d+)/); if (m) resolve(Number(m[1])); });
  });
  await client.connect(transport);
  const app = await openApp("agent", { bridgePort: await found, wait: false });
  after(async () => {
    await client.close().catch(() => {});
    try { if (transport.pid) process.kill(transport.pid); } catch { /* gone already */ }
    await app.close();
  });
  const { page } = app;
  const step = steps(app);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { ...r, text: r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") };
  };
  const image = (r, file) => {
    const img = r.content.find((c) => c.type === "image");
    if (img && process.env.SHOTS) writeFileSync(join(process.env.SHOTS, file), Buffer.from(img.data, "base64"));
    return img;
  };

  step("the page finds the bridge by itself", async () => {
    await page.waitForFunction(() => document.getElementById("agent-button").classList.contains("connected"), { timeout: 20_000 });
    await app.built();
  });

  step("reading: status, guide, API help, parts, a part, its timeline, a snippet", async () => {
    let r = await call("get_status");
    check(r.text.includes("Open part: caad-examples/parts/bracket.py (project caad-examples)") && r.text.includes("ready"), "get_status", r.text);
    r = await call("build123d_guide");
    check(r.text.includes("Sections") && r.text.includes("Selectors"), "build123d_guide lists sections");
    r = await call("build123d_guide", { topic: "selectors" });
    check(r.text.startsWith("## Selectors"), "build123d_guide returns a section");
    r = await call("api_help", { name: "Hole" });
    check(r.text.includes("Hole(radius"), "api_help", r.text);
    r = await call("list_parts");
    check(r.text.includes("Project caad-examples/: parts go in caad-examples/parts/") && r.text.includes("    caad-examples/parts/pump_body.py") && r.text.includes("Shared code") && r.text.includes("caad-examples/params.py"), "list_parts", r.text);
    r = await call("read_part", { path: "caad-examples/parts/bracket.py" });
    check(r.text.includes(" 9 | with BuildPart() as bracket:"), "read_part has line numbers");
    r = await call("get_timeline");
    check(r.text.includes("built OK") && r.text.includes("fillet"), "get_timeline", r.text);
    r = await call("run_snippet", { code: "e = bracket.edges().filter_by(Axis.Z)\nprint(len(e))\ne[0]" });
    check(r.text.includes("Output:") && r.text.includes("LINE"), "run_snippet", r.text);
  });

  step("edit_part: a failing edit, the fix (in the user's code panel), text that isn't there", async () => {
    let r = await call("edit_part", { path: "caad-examples/parts/bracket.py", old_text: "radius=5)", new_text: "radius=50)" });
    check(r.isError !== true && r.text.includes("FAILED at feature 5"), "edit_part with a bad fillet reports the failing feature", r.text);
    r = await call("edit_part", { path: "caad-examples/parts/bracket.py", old_text: "radius=50)", new_text: "radius=8)" });
    check(r.text.includes("built OK"), "edit_part fix", r.text);
    check((await page.evaluate(() => window.caad.editor.text)).includes("radius=8)"), "the user's code panel shows the agent's edit");
    r = await call("edit_part", { path: "caad-examples/parts/bracket.py", old_text: "nonexistent", new_text: "x" });
    check(r.isError && r.text.includes("not found"), "edit_part refuses text that isn't there");
  });

  step("highlight and render", async () => {
    let r = await call("highlight", { selector: "bracket.edges().filter_by(Axis.Z)", note: "these vertical edges?" });
    check(r.text.startsWith("Highlighted"), "highlight", r.text);
    check(await page.$eval("#agent-note", (e) => !e.hidden && e.textContent.includes("vertical edges")), "highlight note is shown to the user");
    r = await call("render", { view: "current" });
    const img = image(r, "agent-render-current.png");
    check(img && img.data.length > 1000, "render current: a PNG");
    r = await call("render", { view: "front", width: 600, height: 400 });
    check(image(r, "agent-render-front.png"), "render front view");
  });

  step("the user clicks a face; the agent asks what it is", async () => {
    const box = await (await page.$("#view canvas")).boundingBox();
    await page.mouse.click(box.x + box.width * 0.33, box.y + box.height * 0.72); // the base plate, clear of the hole
    await page.waitForFunction(() => window.caad.state.selection.length > 0, { timeout: 10_000 });
    const r = await call("get_selection");
    check(r.text.includes("bracket.faces()"), "get_selection", r.text);
  });

  step("write_part, edit_feature, export_part, open_part", async () => {
    let r = await call("write_part", { path: "caad-examples/parts/plate2.py", code: "from build123d import *\n\nwith BuildPart() as plate:\n    Box(60, 40, 5)\n    with GridLocations(44, 24, 2, 2):\n        Hole(2.2)\n    fillet(plate.edges().filter_by(Axis.Z), radius=4)\n" });
    check(r.text.includes("caad-examples/parts/plate2.py: built OK") && r.text.includes("60 × 40 × 5"), "write_part new part", r.text);
    check((await page.$$eval("#parts li", (l) => l.map((x) => x.textContent))).includes("plate2.py"), "the new part appears in the parts list and is shown");
    image(await call("render", { view: "iso" }), "agent-render-plate.png");
    await app.shot("agent-page.png");
    r = await call("edit_feature", { feature: 5, changes: { radius: "6" }, path: "caad-examples/parts/bracket.py" });
    check(/^Feature 5 is now:\n    fillet\(bracket\.edges\(\)[^\n]*radius=6\)/.test(r.text) && r.text.includes("built OK"), "edit_feature", r.text);
    r = await call("edit_feature", { feature: 0, changes: { amount: "3" } });
    check(r.isError && /plain code|no argument|isn't there/.test(r.text), "edit_feature refuses what isn't a feature with arguments", r.text);
    r = await call("export_part", { format: "step", path: "caad-examples/parts/bracket.py" });
    check(/^Exported caad-examples\/exports\/bracket\.step: STEP, \d+ kB; the whole part/.test(r.text), "export_part", r.text);
    r = await call("open_part", { path: "caad-examples/parts/bracket.py", rollback: 1 });
    check(r.text.includes("rolled-back"), "open_part with rollback", r.text);
  });
}
