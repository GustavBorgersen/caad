// Workspaces and projects end to end (docs/07-project-structure.md): the browser by project and kind, shared
// code a part imports (and edits to it), export, New project, + Part, Make a project.
import { after } from "node:test";
import { check } from "../common.mjs";
import { openApp, steps } from "../ui/env.mjs";

const app = await openApp("project");
after(() => app.close());
const { page } = app;
const step = steps(app);

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

step("the examples are a workspace with one project: files grouped by kind", async () => {
  const t = await tree();
  check(JSON.stringify(t) === JSON.stringify(["project:caad-examples", "group:Parts", "part active:bracket.py", "part:plate.py", "part:pump_body.py", "group:Shared code", "shared:params.py"]),
    "the browser shows the project and its files by kind", t);
  check((await path()) === "caad-examples/parts/bracket.py", "the first part opens");
});

step("a part imports the project's shared parameters; an edit to params.py rebuilds it", async () => {
  await clickFile("caad-examples/parts/plate.py");
  const plate = await page.evaluate(() => ({ ok: window.caad.state.result.ok, error: window.caad.state.result.error }));
  check((await width()) === 50 && plate.ok, "plate.py builds with params.py (50 wide)", { width: await width(), ...plate });
  await page.evaluate(async () => {
    const ws = window.caad.state.workspace;
    await ws.write("caad-examples/params.py", (await ws.read("caad-examples/params.py")).replace("plate_w = 50", "plate_w = 70"));
  });
  await page.waitForFunction(() => { const b = window.caad.state.result?.summary?.bbox; return b && Math.abs(b[3] - b[0] - 70) < 1e-6; }, { timeout: 10_000 });
  check((await path()) === "caad-examples/parts/plate.py", "editing params.py from outside rebuilds the open plate: 70 wide");
  await clickFile("caad-examples/params.py");
  check(await page.evaluate(() => window.caad.editor.text.includes("plate_w = 70")), "shared code opens in the code panel");
  await app.shot("project-1-browser.png");
});

step("export: STEP and STL into the project's exports/, listed under Exports", async () => {
  await clickFile("caad-examples/parts/bracket.py");
  await page.evaluate(() => { window.caad.state.upto = 1; }); // rolled back: the export is still the whole part
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
  check(exp.step.startsWith("ISO-10303-21;") && exp.size > 10_000 && /^STL Exported/.test(exp.stl), "exported bracket.step and bracket.stl", exp);
  check(/Exported caad-examples\/exports\/bracket\.stl \(\d+ kB\): click it under Exports/.test(exp.status), "the status says where", exp.status);
  check((await tree()).join().includes("group:Exports,export:bracket.step,export:bracket.stl"), "listed under Exports", await tree());
});

step("New project: a folder with a pyproject.toml and parts/part.py; + Part goes into it", async () => {
  app.answer = "fermenter";
  await builds("fermenter/parts/part.py", () => page.click("#new-project"));
  const files = await page.evaluate(() => window.caad.state.files.map((f) => f.path));
  check(files.includes("fermenter/pyproject.toml") && files.includes("fermenter/parts/part.py"), "New project wrote fermenter/pyproject.toml and fermenter/parts/part.py", files);
  check((await page.evaluate(() => window.caad.state.workspace.read("fermenter/pyproject.toml"))).includes('[tool.caad]\nformat = 1'), "its project file has [tool.caad]");
  check((await tree()).includes("project:fermenter"), "and the browser lists it");
  app.answer = "lid";
  await builds("fermenter/parts/lid.py", () => page.click("#new-part"));
  check((await tree()).join().includes("project:fermenter,group:Parts,part active:lid.py,part:part.py"), "+ Part goes into the open project's parts/", await tree());
});

step("a build123d file in no project: listed under its folder; Make a project", async () => {
  await builds("loose/widget.py", () => page.evaluate(() => window.caad.applyCode("loose/widget.py", "from build123d import *\n\nwith BuildPart() as widget:\n    Box(5, 5, 5)\n")));
  check((await tree()).join().includes("project loose:loose/,part active:widget.py") && (await page.$eval("#parts li.project.loose button", (b) => b.textContent)) === "Make a project",
    "a loose part is listed under its folder, with Make a project", await tree());
  await page.click("#parts li.project.loose button");
  await page.waitForFunction(() => window.caad.state.index.projects.some((p) => p.root === "loose"), { timeout: 10_000 });
  check((await tree()).includes("project:loose") && (await page.evaluate(() => window.caad.state.files.some((f) => f.path === "loose/pyproject.toml"))), "Make a project added loose/pyproject.toml: it's a project now");
  await app.shot("project-2-projects.png");
});

step("the agent's list_parts shows where parts go", async () => {
  const listing = await page.evaluate(() => window.caad.agents.handlers?.list_parts?.() ?? null);
  check(listing !== null, "list_parts is a page tool");
  check(listing.content[0].text.includes("Project fermenter/: parts go in fermenter/parts/"), "it names each project's parts folder", listing.content[0].text);
});

step("a folder with Windows line endings: CAAD works with \\n, the file keeps its \\r\\n", async () => {
  const crlf = "from build123d import *\r\n\r\nwith BuildPart() as box:\r\n    Box(10, 10, 10)\r\n    fillet(box.edges(), radius=1)\r\n";
  await page.evaluate(async (text) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("crlf", { create: true });
    const w = await (await dir.getFileHandle("box.py", { create: true })).createWritable();
    await w.write(text);
    await w.close();
    window.showDirectoryPicker = async () => dir; // the folder the user would pick
  }, crlf);
  await builds("box.py", () => page.click("#open-folder"));
  check((await page.evaluate(() => window.caad.editor.text)) === crlf.replace(/\r\n/g, "\n"), "the code panel has the text with \\n");
  // The agent's edit_part with text over two lines: found only if the file's \r\n became \n.
  const r = await page.evaluate(() => window.caad.agents.handlers.edit_part({ path: "box.py",
    old_text: "    Box(10, 10, 10)\n    fillet(box.edges(), radius=1)", new_text: "    Box(10, 10, 20)\n    fillet(box.edges(), radius=1)" }));
  check(r.content[0].text.includes("built OK"), "edit_part across lines works", r.content[0].text);
  const disk = await page.evaluate(async () => (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle("crlf")).getFileHandle("box.py")).getFile()).text());
  check(disk === crlf.replace("Box(10, 10, 10)", "Box(10, 10, 20)"), "written back with \\r\\n only", JSON.stringify(disk));
});
