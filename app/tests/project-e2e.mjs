// Workspaces and projects end to end in headless Chromium (docs/07-project-structure.md): the browser by project
// and kind, shared code a part imports (and edits to it), New project, + Part, Make a project.
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const OUT = process.argv[2] ?? ".";
const PORT = 5198;
const server = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"], defaultViewport: { width: 1400, height: 850 },
});
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}`); if (!ok) failures++; };
const finish = async (code) => { await browser.close(); server.kill(); process.exit(code); };
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [page exception]", e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("WebSocket") && console.log("  [console error]", m.text()));
  let answer = "";
  page.on("dialog", (d) => d.accept(answer));
  for (let i = 0; i < 30; i++) { try { await page.goto(`http://127.0.0.1:${PORT}/`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  await page.waitForFunction(() => /^(Built|Failed)/.test(document.getElementById("status").textContent), { timeout: 300_000 });

  const tree = () => page.$$eval("#parts li", (l) => l.map((x) => `${x.className.replace("file ", "")}:${x.firstChild?.textContent ?? ""}`));
  const path = () => page.evaluate(() => window.caad.state.path);
  const width = () => page.evaluate(() => { const b = window.caad.state.result?.summary?.bbox; return b ? +(b[3] - b[0]).toFixed(3) : null; });
  const gen = () => page.evaluate(() => window.caad.state.result?.gen ?? 0);
  /** Do something, then wait for a new build of file `p`. */
  const builds = async (p, action) => {
    const g = await gen();
    await action();
    await page.waitForFunction((x, g0) => window.caad.state.path === x && (window.caad.state.result?.gen ?? 0) > g0 && !window.caad.state.result.preview, { timeout: 60_000 }, p, g);
  };
  const clickFile = (p) => builds(p, () => page.click(`#parts li.file[data-path="${p}"]`));

  // 1. The examples are a workspace with one project: files grouped by kind.
  const t = await tree();
  check(JSON.stringify(t) === JSON.stringify(["project:caad-examples", "group:Parts", "part active:bracket.py", "part:plate.py", "part:pump_body.py", "group:Shared code", "shared:params.py"]),
    `the browser shows the project and its files by kind: ${t.join(", ")}`);
  check((await path()) === "caad-examples/parts/bracket.py", "the first part opens");

  // 2. A part imports the project's shared parameters; an edit to params.py rebuilds it.
  await clickFile("caad-examples/parts/plate.py");
  check((await width()) === 50 && await page.evaluate(() => window.caad.state.result.ok), "plate.py builds with params.py (50 wide)");
  await page.evaluate(async () => {
    const ws = window.caad.state.workspace;
    await ws.write("caad-examples/params.py", (await ws.read("caad-examples/params.py")).replace("plate_w = 50", "plate_w = 70"));
  });
  await page.waitForFunction(() => { const b = window.caad.state.result?.summary?.bbox; return b && Math.abs(b[3] - b[0] - 70) < 1e-6; }, { timeout: 10_000 });
  check((await path()) === "caad-examples/parts/plate.py", "editing params.py from outside rebuilds the open plate: 70 wide");
  await clickFile("caad-examples/params.py");
  check(await page.evaluate(() => window.caad.editor.text.includes("plate_w = 70")), "shared code opens in the code panel");
  await page.screenshot({ path: `${OUT}/project-1-browser.png` });

  // 2b. Export: STEP and STL into the project's exports/, listed under Exports (click downloads).
  await clickFile("caad-examples/parts/bracket.py");
  await page.evaluate(() => window.caad.state.upto = 1); // rolled back: the export is still the whole part
  for (const fmt of ["step", "stl"]) {
    await page.click("#export-button");
    await page.click(`#export-choice [data-format="${fmt}"]`);
    await page.waitForFunction((f) => window.caad.state.files.some((x) => x.path === `caad-examples/exports/bracket.${f}`), { timeout: 60_000 }, fmt);
  }
  const exp = await page.evaluate(async () => {
    const ws = window.caad.state.workspace;
    const head = async (p) => new TextDecoder().decode((await (await ws.blob(p)).arrayBuffer()).slice(0, 24));
    return { step: await head("caad-examples/exports/bracket.step"), stl: await head("caad-examples/exports/bracket.stl"),
      size: (await ws.blob("caad-examples/exports/bracket.step")).size, status: document.getElementById("status").textContent };
  });
  check(exp.step.startsWith("ISO-10303-21;") && exp.size > 10_000 && /^STL Exported/.test(exp.stl), `exported bracket.step (${exp.size} bytes) and bracket.stl`);
  check(/Exported caad-examples\/exports\/bracket\.stl \(\d+ kB\): click it under Exports/.test(exp.status), `status: ${exp.status}`);
  check((await tree()).join().includes("group:Exports,export:bracket.step,export:bracket.stl"), "listed under Exports");

  // 3. New project: a folder with a pyproject.toml and parts/part.py, opened.
  answer = "fermenter";
  await builds("fermenter/parts/part.py", () => page.click("#new-project"));
  const files = await page.evaluate(() => window.caad.state.files.map((f) => f.path));
  check(files.includes("fermenter/pyproject.toml") && files.includes("fermenter/parts/part.py"), "New project wrote fermenter/pyproject.toml and fermenter/parts/part.py");
  check((await page.evaluate(() => window.caad.state.workspace.read("fermenter/pyproject.toml"))).includes('[tool.caad]\nformat = 1'), "its project file has [tool.caad]");
  check((await tree()).includes("project:fermenter"), "and the browser lists it");
  answer = "lid";
  await builds("fermenter/parts/lid.py", () => page.click("#new-part"));
  check((await tree()).join().includes("project:fermenter,group:Parts,part active:lid.py,part:part.py"), "+ Part goes into the open project's parts/");

  // 4. A build123d file in no project: listed on its own, and Make a project turns its folder into one.
  await builds("loose/widget.py", () => page.evaluate(() => window.caad.applyCode("loose/widget.py", "from build123d import *\n\nwith BuildPart() as widget:\n    Box(5, 5, 5)\n")));
  check((await tree()).join().includes("project loose:loose/,part active:widget.py") && (await page.$eval("#parts li.project.loose button", (b) => b.textContent)) === "Make a project",
    "a loose part is listed under its folder, with Make a project");
  await page.click("#parts li.project.loose button");
  await page.waitForFunction(() => window.caad.state.index.projects.some((p) => p.root === "loose"), { timeout: 10_000 });
  check((await tree()).includes("project:loose") && (await page.evaluate(() => window.caad.state.files.some((f) => f.path === "loose/pyproject.toml"))), "Make a project added loose/pyproject.toml: it's a project now");
  await page.screenshot({ path: `${OUT}/project-2-projects.png` });

  // 5. The agent's view of it.
  const listing = await page.evaluate(() => window.caad.agents.handlers?.list_parts?.() ?? null);
  if (listing) check(listing.content[0].text.includes("Project fermenter/: parts go in fermenter/parts/"), "list_parts shows where parts go");

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  await finish(failures ? 1 : 0);
} catch (e) {
  console.log("TEST ERROR:", e.message);
  await (await browser.pages()).at(-1).screenshot({ path: `${OUT}/project-error.png` }).catch(() => {});
  await finish(1);
}
