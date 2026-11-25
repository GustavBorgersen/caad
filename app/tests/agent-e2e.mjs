// End to end: the real bridge binary (started by the official MCP client, like Claude Code does) and the
// real app in headless Chromium. The test plays the agent and uses every tool.
// Usage: node tests/agent-e2e.mjs [screenshot-dir]   (needs `npm run build:bridge` first)
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import puppeteer from "puppeteer-core";

const OUT = process.argv[2] ?? ".";
const PORT = 5197;
const server = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"], defaultViewport: { width: 1400, height: 850 },
});
const client = new Client({ name: "e2e-agent", version: "0" });
const finish = async (code) => { await client.close().catch(() => {}); await browser.close(); server.kill(); process.exit(code); };
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}`); if (!ok) failures++; };
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, text: r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") };
};

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [page exception]", e.message));
  for (let i = 0; i < 30; i++) { try { await page.goto(`http://127.0.0.1:${PORT}/`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  await client.connect(new StdioClientTransport({ command: "public/bridge/caad-mcp-linux-amd64", stderr: "ignore" }));

  // The page finds the bridge by itself (it scans every few seconds).
  await page.waitForFunction(() => document.getElementById("agent-button").classList.contains("connected"), { timeout: 20_000 });
  check(true, "page connected to the bridge on its own");
  await page.waitForFunction(() => /^(Built|Failed)/.test(document.getElementById("status").textContent), { timeout: 300_000 });

  let r = await call("get_status");
  check(r.text.includes("Open part: caad-examples/parts/bracket.py (project caad-examples)") && r.text.includes("ready"), "get_status: " + r.text.split("\n").slice(1, 4).join(" | "));
  r = await call("build123d_guide");
  check(r.text.includes("Sections") && r.text.includes("Selectors"), "build123d_guide lists sections");
  r = await call("build123d_guide", { topic: "selectors" });
  check(r.text.startsWith("## Selectors"), "build123d_guide returns a section");
  r = await call("api_help", { name: "Hole" });
  check(r.text.includes("Hole(radius"), "api_help: " + r.text.split("\n")[2]);
  r = await call("list_parts");
  check(r.text.includes("Project caad-examples/: parts go in caad-examples/parts/") && r.text.includes("    caad-examples/parts/pump_body.py") && r.text.includes("Shared code") && r.text.includes("caad-examples/params.py"), "list_parts: " + r.text.replace(/\n/g, ", "));
  r = await call("read_part", { path: "caad-examples/parts/bracket.py" });
  check(r.text.includes(" 9 | with BuildPart() as bracket:"), "read_part has line numbers");
  r = await call("get_timeline");
  check(r.text.includes("built OK") && r.text.includes("fillet"), "get_timeline:\n" + r.text.split("\n").slice(0, 2).join("\n"));
  r = await call("run_snippet", { code: "e = bracket.edges().filter_by(Axis.Z)\nprint(len(e))\ne[0]" });
  check(r.text.includes("Output:") && r.text.includes("LINE"), "run_snippet: " + r.text.replace(/\s+/g, " ").slice(0, 120));

  r = await call("edit_part", { path: "caad-examples/parts/bracket.py", old_text: "radius=5)", new_text: "radius=50)" });
  check(r.isError !== true && r.text.includes("FAILED at feature 5"), "edit_part with a bad fillet reports the failing feature");
  r = await call("edit_part", { path: "caad-examples/parts/bracket.py", old_text: "radius=50)", new_text: "radius=8)" });
  check(r.text.includes("built OK"), "edit_part fix: " + r.text.split("\n")[1]);
  const editorText = await page.evaluate(() => window.caad.editor.text);
  check(editorText.includes("radius=8)"), "the user's code panel shows the agent's edit");
  r = await call("edit_part", { path: "caad-examples/parts/bracket.py", old_text: "nonexistent", new_text: "x" });
  check(r.isError && r.text.includes("not found"), "edit_part refuses text that isn't there");

  r = await call("highlight", { selector: "bracket.edges().filter_by(Axis.Z)", note: "these vertical edges?" });
  check(r.text.startsWith("Highlighted"), "highlight: " + r.text);
  check(await page.$eval("#agent-note", (e) => !e.hidden && e.textContent.includes("vertical edges")), "highlight note is shown to the user");
  r = await call("render", { view: "current" });
  const img = r.content.find((c) => c.type === "image");
  check(img && img.data.length > 1000, `render current: ${img ? Math.round(img.data.length * 0.75 / 1024) : 0} kB PNG`);
  if (img) writeFileSync(`${OUT}/agent-render-current.png`, Buffer.from(img.data, "base64"));
  r = await call("render", { view: "front", width: 600, height: 400 });
  writeFileSync(`${OUT}/agent-render-front.png`, Buffer.from(r.content.find((c) => c.type === "image").data, "base64"));
  check(true, "render front view saved");

  // The user clicks a face; the agent asks what it is.
  const box = await (await page.$("#view canvas")).boundingBox();
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.62);
  await page.waitForFunction(() => window.caad.state.selection.length > 0, { timeout: 10_000 });
  r = await call("get_selection");
  check(r.text.includes("bracket.faces()"), "get_selection:\n" + r.text);

  r = await call("write_part", { path: "caad-examples/parts/plate2.py", code: "from build123d import *\n\nwith BuildPart() as plate:\n    Box(60, 40, 5)\n    with GridLocations(44, 24, 2, 2):\n        Hole(2.2)\n    fillet(plate.edges().filter_by(Axis.Z), radius=4)\n" });
  check(r.text.includes("caad-examples/parts/plate2.py: built OK") && r.text.includes("60 × 40 × 5"), "write_part new part:\n" + r.text.split("\n").slice(0, 2).join("\n"));
  check((await page.$$eval("#parts li", (l) => l.map((x) => x.textContent))).includes("plate2.py"), "the new part appears in the parts list and is shown");
  r = await call("render", { view: "iso" });
  writeFileSync(`${OUT}/agent-render-plate.png`, Buffer.from(r.content.find((c) => c.type === "image").data, "base64"));
  await page.screenshot({ path: `${OUT}/agent-page.png` });
  r = await call("export_part", { format: "step", path: "caad-examples/parts/bracket.py" });
  check(/^Exported caad-examples\/exports\/bracket\.step: STEP, \d+ kB; the whole part/.test(r.text), "export_part: " + r.text);
  r = await call("open_part", { path: "caad-examples/parts/bracket.py", rollback: 1 });
  check(r.text.includes("rolled-back"), "open_part with rollback");
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  await finish(failures ? 1 : 0);
} catch (e) {
  console.log("TEST ERROR:", e.message);
  await finish(1);
}
