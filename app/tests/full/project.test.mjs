// Workspaces and projects end to end (docs/07-project-structure.md, docs/10 Files tab): the tree by project and kind,
// shared code a part imports (and edits to it), export, New project, new parts named in the tree, rename (imports
// follow), duplicate, delete with Undo, Make a project, the workspace switcher.
import { after } from "node:test";
import { check } from "../common.mjs";
import { openApp, sleep, steps } from "../ui/env.mjs";

const app = await openApp("project");
after(() => app.close());
const { page } = app;
const step = steps(app);

// The Files tree as "kind[ active]:name" per row (projects, groups, files).
const tree = () => page.$$eval("#parts li:not(.loose-li)", (l) => l.map((x) =>
  `${[...x.classList].filter((c) => !["file", "open", "dim"].includes(c)).join(" ")}:${x.querySelector(".tn")?.textContent ?? ""}`));
const menuItem = async (cls, label) => { await page.waitForSelector(`.menu${cls} button.it`, { timeout: 10_000 }); return menuItemNow(cls, label); };
const menuItemNow = (cls, label) => page.evaluate(([c, l]) => [...document.querySelectorAll(`.menu${c} button.it`)].find((b) => b.querySelector(".l").textContent === l).click(), [cls, label]);
/** Type a name into the tree's name field (it starts selected) and press Enter. */
const typeName = async (name) => {
  await page.waitForSelector("#parts .edit input", { timeout: 10_000 });
  await page.evaluate(() => document.querySelector("#parts .edit input").select());
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
};
const exists = (p) => page.evaluate((x) => window.caad.state.workspace.exists(x), p);
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
await page.click("#tab-files");

step("the examples are a workspace with one project: files grouped by kind", async () => {
  const t = await tree();
  check(JSON.stringify(t) === JSON.stringify(["project:caad-examples", "group:Parts", "part active:bracket.py", "part:plate.py", "part:pump_body.py", "group:Shared code", "shared:params.py", "config:pyproject.toml"]),
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
    await page.click('#commands [data-command="export"]');
    await menuItem("", fmt.toUpperCase());
    await page.waitForFunction((f) => window.caad.state.files.some((x) => x.path === `caad-examples/exports/bracket.${f}`), { timeout: 60_000 }, fmt);
  }
  const exp = await page.evaluate(async () => {
    const ws = window.caad.state.workspace;
    const head = async (p) => new TextDecoder().decode((await (await ws.blob(p)).arrayBuffer()).slice(0, 24));
    return { step: await head("caad-examples/exports/bracket.step"), stl: await head("caad-examples/exports/bracket.stl"),
      size: (await ws.blob("caad-examples/exports/bracket.step")).size, status: window.caad.lastMessage() };
  });
  check(exp.step.startsWith("ISO-10303-21;") && exp.size > 10_000 && /^STL Exported/.test(exp.stl), "exported bracket.step and bracket.stl", exp);
  check(/Exported caad-examples\/exports\/bracket\.stl \(\d+ kB\)Download/.test(exp.status), "the message says where, with Download", exp.status);
  check((await tree()).join().includes("group:Exports,export:bracket.step,export:bracket.stl"), "listed under Exports", await tree());
});

step("New project: a docked dialog; a folder with a pyproject.toml, params.py and parts/part.py; a new part goes into it", async () => {
  await page.click("#new-menu");
  await menuItem(".new-menu", "New project…");
  await page.waitForSelector("#project-panel:not([hidden]) #np-name", { timeout: 10_000 });
  await page.evaluate(() => document.getElementById("np-name").select());
  await page.keyboard.type("bad name");
  check(await page.$eval("#project-panel .primary", (b) => b.disabled) && /Letters, digits/.test(await page.$eval("#np-name-msg", (m) => m.textContent)), "a name with a space is refused in the dialog");
  await page.evaluate(() => document.getElementById("np-name").select());
  await page.keyboard.type("fermenter");
  check(/fermenter\/[\s\S]*pyproject\.toml[\s\S]*params\.py[\s\S]*part\.py/.test(await page.$eval("#np-preview", (p) => p.textContent)), "the dialog lists what it will write");
  await builds("fermenter/parts/part.py", () => page.click("#project-panel .primary"));
  const files = await page.evaluate(() => window.caad.state.files.map((f) => f.path));
  check(files.includes("fermenter/pyproject.toml") && files.includes("fermenter/parts/part.py"), "New project wrote fermenter/pyproject.toml and fermenter/parts/part.py", files);
  check((await page.evaluate(() => window.caad.state.workspace.read("fermenter/pyproject.toml"))).includes('[tool.caad]\nformat = 1'), "its project file has [tool.caad]");
  check((await tree()).includes("project:fermenter"), "and the browser lists it");
  await page.click("#new-menu");
  await menuItem(".new-menu", "New part");
  await page.waitForSelector("#parts .edit input", { timeout: 10_000 });
  await page.evaluate(() => document.querySelector("#parts .edit input").select());
  await page.keyboard.type("2lid");
  check(/Python names/.test(await page.$eval("#parts .hint", (h) => h.textContent)), "a name starting with a digit is refused, saying why");
  await builds("fermenter/parts/lid.py", () => typeName("lid"));
  check((await tree()).join().includes("project:fermenter,group:Parts,part active:lid.py,part:part.py"), "the new part goes into the open project's parts/", await tree());
});

step("rename a part in the tree (F2): the file and the imports of it follow; Undo renames it back", async () => {
  await page.evaluate(() => window.caad.state.workspace.write("fermenter/parts/assembly_check.py", "from build123d import *\nfrom parts.lid import lid\n\nwith BuildPart() as check:\n    add(lid.part)\n"));
  await page.evaluate(() => window.caad.refresh());
  await page.focus('#parts li[data-path="fermenter/parts/lid.py"]');
  await page.keyboard.press("F2");
  await builds("fermenter/parts/cap.py", () => typeName("cap"));
  const after = await page.evaluate(() => window.caad.state.workspace.read("fermenter/parts/assembly_check.py"));
  check(!(await exists("fermenter/parts/lid.py")) && (await exists("fermenter/parts/cap.py")) && after.includes("from parts.cap import lid"),
    "lid.py is cap.py now, and the import of it follows", after);
  check(/Renamed to cap\.py · 1 import updated/.test(await app.message()), "the message says so", await app.message());
  await page.evaluate(() => [...document.querySelectorAll("#messages button")].find((b) => b.textContent === "Undo").click());
  // Undo moves the open file back, redraws the tree twice and rebuilds: wait for all of it, or the next step's
  // click can hit a tree row that is about to be replaced ("Node is detached from document", seen in CI on #13).
  await page.waitForFunction(() => window.caad.state.path === "fermenter/parts/lid.py" && /Renamed back to lid\.py/.test(window.caad.lastMessage()), { timeout: 10_000 });
  await app.built();
  check(await exists("fermenter/parts/lid.py") && (await page.evaluate(() => window.caad.state.workspace.read("fermenter/parts/assembly_check.py"))).includes("from parts.lid import lid"),
    "Undo: lid.py again, and its import");
});

step("duplicate and delete: at once, with Undo; a whole project too", async () => {
  await page.click('#parts li[data-path="fermenter/parts/part.py"]', { button: "right" });
  await menuItem("", "Duplicate");
  await typeName("part_copy");
  await page.waitForFunction(() => window.caad.state.files.some((f) => f.path === "fermenter/parts/part_copy.py"), { timeout: 10_000 });
  check((await page.evaluate(() => window.caad.state.workspace.read("fermenter/parts/part_copy.py"))) === (await page.evaluate(() => window.caad.state.workspace.read("fermenter/parts/part.py"))), "a copy, named in the tree");
  await page.focus('#parts li[data-path="fermenter/parts/part_copy.py"]');
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => !window.caad.state.files.some((f) => f.path === "fermenter/parts/part_copy.py"), { timeout: 10_000 });
  check(/part_copy\.py deleted/.test(await app.message()), "deleted at once, the message offers Undo", await app.message());
  await page.evaluate(() => [...document.querySelectorAll("#messages button")].find((b) => b.textContent === "Undo").click());
  await page.waitForFunction(() => window.caad.state.files.some((f) => f.path === "fermenter/parts/part_copy.py"), { timeout: 10_000 });
  // A whole project: everything in it goes, and comes back.
  await page.evaluate(() => window.caad.state.workspace.write("scrap/pyproject.toml", "[tool.caad]\nformat = 1\n").then(() => window.caad.state.workspace.write("scrap/notes.md", "keep me")));
  await page.evaluate(() => window.caad.refresh());
  await page.evaluate(() => window.caad.files.remove("scrap"));
  await page.waitForFunction(() => !window.caad.state.index.projects.some((p) => p.root === "scrap"), { timeout: 10_000 });
  check(!(await exists("scrap/notes.md")) && /scrap \(2 files\) deleted/.test(await app.message()), "the project and every file in it are gone", await app.message());
  await page.evaluate(() => [...document.querySelectorAll("#messages button")].find((b) => b.textContent === "Undo").click());
  await page.waitForFunction(() => window.caad.state.index.projects.some((p) => p.root === "scrap"), { timeout: 10_000 });
  check((await page.evaluate(() => window.caad.state.workspace.read("scrap/notes.md"))) === "keep me", "Undo brings them all back");
  check(app.nativeDialogs.length === 0, "no native popups", app.nativeDialogs);
});

step("a build123d file in no project: listed under its folder; Make a project", async () => {
  await builds("loose/widget.py", () => page.evaluate(() => window.caad.applyCode("loose/widget.py", "from build123d import *\n\nwith BuildPart() as widget:\n    Box(5, 5, 5)\n")));
  check((await tree()).join().includes("project loose:loose/,part active:widget.py") && /Make loose a project/.test(await page.$eval("#parts [data-make]", (b) => b.textContent)),
    "a loose part is listed under its folder, with Make a project", await tree());
  await page.click("#parts [data-make]");
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
  await page.click("#workspace");
  await page.waitForSelector(".switcher", { timeout: 10_000 }); // after the recent folders are read
  check(/Examples[\s\S]*Open folder/.test(await page.$eval(".switcher", (m) => m.textContent)), "the workspace switcher offers the examples and Open folder");
  await builds("box.py", () => page.click(".switcher [data-pick]"));
  check((await page.evaluate(() => window.caad.editor.text)) === crlf.replace(/\r\n/g, "\n"), "the code panel has the text with \\n");
  // The agent's edit_part with text over two lines: found only if the file's \r\n became \n.
  const r = await page.evaluate(() => window.caad.agents.handlers.edit_part({ path: "box.py",
    old_text: "    Box(10, 10, 10)\n    fillet(box.edges(), radius=1)", new_text: "    Box(10, 10, 20)\n    fillet(box.edges(), radius=1)" }));
  check(r.content[0].text.includes("built OK"), "edit_part across lines works", r.content[0].text);
  const disk = await page.evaluate(async () => (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle("crlf")).getFileHandle("box.py")).getFile()).text());
  check(disk === crlf.replace("Box(10, 10, 10)", "Box(10, 10, 20)"), "written back with \\r\\n only", JSON.stringify(disk));
});
