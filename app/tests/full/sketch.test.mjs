// Sketch editor end to end (docs/06-sketches.md): converting a plain sketch, draw, dimension, Done, extrude;
// reopen and change a dimension; line chains with snapping and inferred constraints; delete; sketches on faces;
// Cancel; a new part; Use (a part edge in the sketch, constrained to); trim, fillet and a pattern.
import { after } from "node:test";
import { check } from "../common.mjs";
import { openApp, sleep, steps } from "../ui/env.mjs";

const app = await openApp("sketch");
after(() => app.close());
app.answer = "widget"; // the new part's name
const { page } = app;
const step = steps(app);

const volume = () => page.evaluate(() => window.caad.state.result?.summary?.volume ?? null);
const code = () => page.evaluate(() => window.caad.editor.text);
const gen = () => page.evaluate(() => window.caad.state.result?.gen ?? 0);
// A build after `gen` of the saved code (the feature dialog's previews don't count).
const waitBuild = (g) => page.waitForFunction((x) => (window.caad.state.result?.gen ?? 0) > x && !window.caad.state.result.preview, { timeout: 60_000 }, g);
const sketchSrc = () => page.evaluate(() => window.caad.sketcher.src);
const model = () => page.evaluate(() => window.caad.sketcher.model);
const idle = () => page.waitForFunction(() => window.caad.sketcher.idle, { timeout: 30_000 });
const opened = () => page.waitForFunction(() => window.caad.sketcher.active && !document.getElementById("sketch-panel").hidden, { timeout: 60_000 });
const closed = () => page.waitForFunction(() => !window.caad.sketcher.active);
const screen = (x, y) => page.evaluate(([a, b]) => window.caad.sketcher.screen([a, b]), [x, y]);
const clickAt = async (x, y) => { const s = await screen(x, y); await page.mouse.move(s.x, s.y); await page.mouse.click(s.x, s.y); await idle(); };
const shiftClickAt = async (x, y) => { await page.keyboard.down("Shift"); await clickAt(x, y); await page.keyboard.up("Shift"); };
const dragFrom = async ([x0, y0], [x1, y1]) => {
  const a = await screen(x0, y0), b = await screen(x1, y1);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8);
  await page.mouse.up();
  await idle();
};
const tool = (t) => page.click(`#sketch-panel [data-tool="${t}"]`);
const option = (kind) => page.click(`#sketch-panel button.option[data-option="${kind}"]`);
const state = () => page.$eval("#sketch-panel .state", (s) => s.textContent);
const labels = () => page.$$eval(".sketch-labels .dim", (d) => d.map((x) => x.textContent).sort().join(" | "));
const typeDim = async (text) => {
  await page.waitForSelector(".sketch-labels .dim-input", { timeout: 10_000 });
  await page.$eval(".sketch-labels .dim-input", (i) => { i.value = ""; });
  await page.type(".sketch-labels .dim-input", text);
  await page.keyboard.press("Enter");
  await idle();
};
const done = async () => { const g = await gen(); await page.click("#sketch-panel .primary"); await waitBuild(g); };
const leave = async () => { await page.click("#sketch-panel button[title^='Leave']"); await closed(); };
const newSketchOnTop = async () => { await page.click("#sketch-button"); await page.click('#plane-choice [data-plane="Plane.XY"]'); await opened(); };
const startOn = async (selector, name) => { await page.evaluate((s, n) => window.caad.startSketch(s, n), selector, name); await opened(); };
const extrude = async ({ end, result } = {}) => {
  await page.evaluate(() => [...document.querySelectorAll(".rollback-bar button")].find((b) => b.textContent === "+ Extrude").click());
  await page.waitForSelector("#feature-panel:not([hidden]) .row", { timeout: 30_000 });
  if (end) await page.select('#feature-panel [data-field="until"] select', end);
  if (result) await page.select('#feature-panel [data-field="mode"] select', result);
  const g = await gen();
  await page.click("#feature-panel .primary");
  await page.waitForSelector("#feature-panel[hidden]", { timeout: 30_000 });
  await waitBuild(g);
};
const dblclickFeature = async (index) => {
  for (let i = 0; ; i++) { // the timeline re-renders after every build: retry with a fresh row
    try { await (await page.$$("#timeline .feature"))[index].click({ count: 2 }); return; }
    catch (e) { if (i > 5 || !/detached|not clickable/.test(e.message)) throw e; await sleep(200); }
  }
};
const v0 = await volume();
const saved0 = await code();
let savedConverted, v1, v2;

step("a plain build123d sketch converts on double-click; Cancel keeps it plain, Done saves it", async () => {
  await dblclickFeature(0);
  await opened();
  check((await labels()) === "depth = 40 | width = 60" && /Fully constrained/.test(await state()) && /Converted/.test(await page.$eval("#status", (x) => x.textContent)),
    "converted: its sizes are dimensions with their expressions", await labels());
  check((await sketchSrc()).includes("c.length(rect1.bottom, width)") && (await code()) === saved0, "the converted sketch isn't saved yet");
  await leave();
  check((await code()) === saved0, "Cancel leaves the plain sketch as it was");
  await dblclickFeature(0);
  await opened();
  await done();
  check((await code()).includes("    with BuildSketch() as base:\n        with Constrained() as c:\n            rect1 = c.rectangle((-30, -20), (30, 20))") && Math.abs((await volume()) - v0) < 1e-6,
    "Done saves the converted sketch; the part is unchanged");
  savedConverted = await code();
});

step("a new sketch on Top: two clicks draw a rectangle; nothing is saved before Done", async () => {
  await newSketchOnTop();
  check(await page.$eval('#sketch-panel [data-tool="rect"]', (b) => b.classList.contains("on")), "an empty sketch opens with the rectangle tool");
  await clickAt(-10, -6);
  await clickAt(4, 6);
  const m = await model();
  check(m.entities.filter((e) => e.kind === "line").length === 4 && /rect2 = c\.rectangle\(\(-10, -6\), \(4, 6\)\)/.test(await sketchSrc()), "two clicks drew a rectangle: rect2 = c.rectangle((-10, -6), (4, 6))");
  check((await code()) === savedConverted, "nothing is saved yet");
  check(/4 degrees of freedom/.test(await state()), "under-constrained", await state());
  await app.shot("sketch-1-rect.png");
});

step("dimensions: lengths and distances from the origin, a conflict, Done and a cut", async () => {
  await tool("select");
  await clickAt(-3, -6); // the bottom side
  check((await page.$$eval("#sketch-panel button.option:not(.op)", (b) => b.map((x) => x.dataset.option))).join() === "horizontal,vertical,length",
    "a line offers horizontal, vertical, length", await page.$$eval("#sketch-panel button.option", (b) => b.map((x) => x.title).join(", ")));
  await option("length");
  check(await page.$$eval("#sketch-params option", (o) => o.map((x) => x.value).join()) === "width,depth,thickness,hole_d", "the part's parameters are offered");
  await typeDim("width / 4");
  await clickAt(-10, 0); // the left side
  await option("length");
  await typeDim("12");
  await clickAt(0, 0); // the origin, then the centre: distances go from the first to the second
  await shiftClickAt(-3, 0);
  await option("hdistance");
  await typeDim("-5");
  await clickAt(0, 0);
  await shiftClickAt(-5, 0);
  await option("vdistance");
  await typeDim("0");
  let src = await sketchSrc();
  check(["c.length(rect2.bottom, width / 4)", "c.length(rect2.left, 12)", "c.hdistance(c.origin, rect2.center, -5)", "c.vdistance(c.origin, rect2.center, 0)"].every((l) => src.includes(l)),
    "dimensions written: width / 4, 12, and the centre from the origin", src.split("\n").filter((l) => /c\.(length|hdistance|vdistance)/.test(l)).join(" | "));
  check(/Fully constrained/.test(await state()) && (await page.$$eval(".sketch-labels .dim", (d) => d.map((x) => x.textContent))).includes("width / 4 = 15"), `fully constrained; labels show "width / 4 = 15"`);
  const corner0 = (await model()).entities.find((e) => e.ref === "rect2.corners[0]");
  check(Math.abs(corner0.x + 12.5) < 1e-6 && Math.abs(corner0.y + 6) < 1e-6, "solved: 15 x 12 centred at (-5, 0)", corner0);
  // A conflicting dimension shows red; select its label and delete it.
  await clickAt(-5, 6);
  await option("length");
  await typeDim("99");
  check(/Conflicting/.test(await state()) && (await page.$$(".sketch-labels .dim.conflict")).length === 2, "a second length on a side conflicts", await state());
  await page.evaluate(() => [...document.querySelectorAll(".sketch-labels .dim")].find((d) => d.textContent === "99").click());
  await page.keyboard.press("Delete");
  await idle();
  check(/Fully constrained/.test(await state()) && !(await sketchSrc()).includes("99"), "deleted: fully constrained again");
  await app.shot("sketch-1b-dimensions.png");
  await done();
  src = await code();
  check(src.includes("from caad import Constrained") && /with BuildSketch\(Plane\.XY, mode=Mode\.PRIVATE\) as sk1:\n\s+with Constrained\(\) as c:\n\s+rect2 = c\.rectangle\(/.test(src) && src.includes("c.length(rect2.bottom, width / 4)"), "Done saves the sketch");
  await extrude({ end: "Until.LAST", result: "Mode.SUBTRACT" });
  v1 = await volume();
  check(v1 < v0, "cut through all", `volume ${v0} -> ${v1}`);
});

step("reopen the sketch and change a dimension", async () => {
  const sketchIndex = await page.evaluate(() => window.caad.state.result.timeline.features.findIndex((f) => f.name === "sk1"));
  await dblclickFeature(sketchIndex);
  await opened();
  check(await page.evaluate((i) => window.caad.state.upto === i - 1, sketchIndex), "double-clicking the sketch opens it, rolled back to just before it");
  await page.evaluate(() => { const d = [...document.querySelectorAll(".sketch-labels .dim")].find((x) => x.textContent.startsWith("width / 4")); d.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  await typeDim("width / 3");
  check((await sketchSrc()).includes("c.length(rect2.bottom, width / 3)"), "the dimension's expression changed");
  await done();
  v2 = await volume();
  check((await code()).includes("width / 3") && v2 < v1, "saved; the wider cut removes more", `${v1} -> ${v2}`);
  await app.shot("sketch-2-dimension.png");
});

step("a line chain on the front face: inferred horizontal, closing on the first point, dragging, deleting a constraint", async () => {
  await startOn("bracket.faces().sort_by(Axis.Y)[0]", "the front");
  await tool("line");
  await clickAt(-20, 2);
  await clickAt(-5, 2.1);
  await clickAt(-12, 6);
  await clickAt(-20, 2);
  const src = await sketchSrc();
  check(/line1 = c\.line\(\(-20, 2\), \(-5, 2\.1\)\)\n\s+c\.horizontal\(line1\)\n\s+line2 = c\.line\(line1\.end, \(-12, 6\)\)\n\s+line3 = c\.line\(line2\.end, line1\.start\)/.test(src),
    "a chain: lines share their ends, the nearly horizontal one is horizontal, the last ends on the first point", src);
  const m = await model();
  check(m.dof === 5 && /5 degrees/.test(await state()), "a triangle with one constraint: 5 degrees of freedom", m.dof);
  // Drag the free top vertex: the code follows; the horizontal line stays horizontal.
  await tool("select");
  await dragFrom([-12, 6], [-12, 9]);
  check(/line2 = c\.line\(line1\.end, \(-12(\.\d+)?, 9(\.\d+)?\)\)/.test(await sketchSrc()), "dragging the vertex moved it", (await sketchSrc()).match(/line2 = .*/)?.[0]);
  // The horizontal constraint shows as a glyph: click it, Delete.
  check((await page.$$eval(".sketch-labels .glyph", (g) => g.map((x) => x.textContent))).join() === "H", "the inferred constraint shows as a glyph: H");
  await page.click(".sketch-labels .glyph");
  await page.keyboard.press("Delete");
  await idle();
  check(!(await sketchSrc()).includes("c.horizontal(line1)") && (await model()).dof === 6, "selected through its glyph and deleted: 6 degrees of freedom");
  await app.shot("sketch-3-chain.png");
});

step("deleting a line takes what depends on it; Cancel saves nothing", async () => {
  await clickAt(-8.5, 5.55); // the middle of the second line, after the drag
  await page.keyboard.press("Delete");
  await idle();
  const src = await sketchSrc();
  check(src.includes("line1 = c.line") && !src.includes("line2 =") && !src.includes("line3 ="), "the third line, starting at the second's end, went too", src);
  await page.click("#sketch-panel button:not(.primary)[title^='Leave']");
  await closed();
  check(!(await code()).includes("sk2"), "Cancel saves nothing");
});

step("a sketch of points only (where holes will go); a point on the origin is tied to it", async () => {
  await startOn("bracket.faces().filter_by(Axis.Z).sort_by(Axis.Z)[0]", "the bottom");
  await tool("point");
  await clickAt(-20, 5);
  await clickAt(20, 5);
  await clickAt(0.2, -0.1);
  const src = await sketchSrc();
  check(/p3 = c\.point\(0, 0\)\n\s+c\.coincident\(p3, c\.origin\)/.test(src), "a click on the origin adds a point there, coincident with it (#7)", src);
  check(!(await page.$eval("#sketch-panel .primary", (b) => b.disabled)) && /p1 = c\.point\(-20, 5\)\n\s+p2 = c\.point\(20, 5\)/.test(await sketchSrc()), "a sketch of three points can be closed (Done)");
  await done();
  check(await page.evaluate(() => window.caad.state.result.sketches.some((s) => s.points.length === 9)), "its three points show in the view");
});

step("a circle on the top face, snapped to the origin, extruded", async () => {
  await startOn("bracket.faces().filter_by(Axis.Z).sort_by(Axis.Z)[-1]", "the top");
  await tool("circle");
  await clickAt(0.3, -0.2);
  await clickAt(4, 0);
  check(/circle1 = c\.circle\(c\.origin, 4\)/.test(await sketchSrc()), "the circle's centre snapped to the origin: c.circle(c.origin, 4)");
  await done();
  await extrude();
  check((await volume()) > v2, "extruded");
});

step("a new part: dragging a corner of a rectangle with one freedom left changes only its height", async () => {
  const g = await gen();
  await page.click("#new-part");
  await waitBuild(g);
  await newSketchOnTop();
  await clickAt(-50, 22);
  await clickAt(0.2, 0.1); // snaps to the origin
  await tool("select");
  await clickAt(-25, 22); // the top side
  await option("length");
  await typeDim("50");
  check((await model()).dof === 1 && (await sketchSrc()).includes("c.coincident(rect1.corners[1], c.origin)"), "a corner on the origin, the width set: 1 degree of freedom");
  await dragFrom([0, 22], [1.5, 30]); // a top corner, a little sideways and up
  check(/rect1 = c\.rectangle\(\(-50, 0\), \(0, 30(\.\d+)?\)\)/.test(await sketchSrc()), "only the height changed", (await sketchSrc()).match(/rect1 = .*/)?.[0]);
  await leave();
});

step("a new part: a closed polyline, then its extrude", async () => {
  await newSketchOnTop();
  await tool("line");
  for (const [x, y] of [[0, 0], [30, 0], [30, 10], [10, 20], [0, 20], [0, 0]]) await clickAt(x, y);
  await app.shot("sketch-4-polyline.png");
  await done();
  const src = await code();
  check(!src.includes("pass") && /line1 = c\.line\(c\.origin, \(30, 0\)\)/.test(src) && /line5 = c\.line\(line4\.end, c\.origin\)/.test(src) && (await volume()) === null,
    "the sketch is saved (starting and ending on the origin, where the clicks snapped); no solid yet", src);
  await extrude();
  check(Math.abs((await volume()) - 5000) < 1, "extruded 10: volume 5000 mm³", await volume());
  await app.shot("sketch-5-newpart.png");
});
step("Use: a part edge in the sketch, fixed, and a point constrained to it", async () => {
  await startOn("Plane.XY.offset(10)", "the top");
  await tool("use");
  await clickAt(15, 0); // the polyline part's front edge, on top
  let m = await model();
  const ref = m.entities.find((e) => e.ref === "ref1");
  const ends = m.entities.filter((e) => e.ref === "ref1.start" || e.ref === "ref1.end");
  check(/ref1 = c\.project\(\w+\.edges\(\)/.test(await sketchSrc()) && ref?.kind === "line" && ref.reference && ends.length === 2 && ends.every((p) => Math.abs(p.y) < 1e-6),
    "a click on the edge projects it: c.project(<its selector>), a line along y = 0", (await sketchSrc()).match(/ref1 = .*/)?.[0]);
  await tool("point");
  await clickAt(15, 5);
  await tool("select");
  await clickAt(15, 5);
  await shiftClickAt(8, 0);
  await option("on");
  await idle();
  m = await model();
  check(Math.abs(m.entities.find((e) => e.ref === "p1").y) < 1e-6 && /c\.on\(p1, ref1\)/.test(await sketchSrc()), "a point put on it goes to y = 0");
  const before = await sketchSrc();
  await dragFrom([5, 0], [5, 6]);
  check((await sketchSrc()) === before && (await model()).entities.filter((e) => e.reference && e.kind === "point").every((p) => Math.abs(p.y) < 1e-6), "the reference can't be dragged");
  await app.shot("sketch-6-use.png");
  await done();
  check(/ref1 = c\.project\(/.test(await code()) && await page.evaluate(() => window.caad.state.result.ok), "saved; the part builds");
});

step("Tools: trim a rectangle's side, fillet a corner, a pattern and its count", async () => {
  await startOn("Plane.XY.offset(10)", "the top");
  await clickAt(-10, -6); // the rectangle tool: a fresh sketch starts with it
  await clickAt(10, 6);
  await tool("line");
  await clickAt(0, -9);
  await clickAt(0.1, 9);
  await page.keyboard.press("Escape");
  await tool("trim");
  await clickAt(5, 6); // the top, right of the line
  let src = await sketchSrc();
  const top = src.match(/(line\d+) = c\.line\(\(0, 6\), \(-10, 6\)\)/)?.[1];
  check(!src.includes("c.rectangle") && top && new RegExp(`c\\.on\\(${top}\\.start, line\\d+\\)`).test(src),
    "trimmed: the rectangle became lines, its top now ends at the line, kept on it", src);
  await tool("select");
  await clickAt(-10, -6);
  await option("fillet");
  await typeDim("2");
  src = await sketchSrc();
  check(/fillet1 = c\.fillet\(line\d+\.start, 2\)/.test(src) && (await model()).entities.some((e) => e.kind === "arc" && Math.abs(e.r - 2) < 1e-6), "the corner filleted, radius typed: c.fillet(<line>.start, 2)", src);
  await tool("circle");
  await clickAt(-7, 0);
  await clickAt(-6.2, 0);
  await tool("select");
  await clickAt(-6.2, 0);
  await option("linear_pattern");
  await idle();
  check(/pattern1 = c\.linear_pattern\(\[circle1\], 3, 2, 0\)/.test(await sketchSrc()), "a linear pattern: 3 copies 2 apart (from the circle's size)", (await sketchSrc()).match(/pattern1 = .*/)?.[0]);
  await clickAt(-4.2, 0); // the second copy: its pattern's fields show
  await page.$eval('#sketch-panel input[data-arg="count"]', (i) => { i.value = ""; });
  await page.type('#sketch-panel input[data-arg="count"]', "4");
  await page.keyboard.press("Enter");
  await idle();
  check(/pattern1 = c\.linear_pattern\(\[circle1\], 4, 2, 0\)/.test(await sketchSrc()) && (await model()).entities.filter((e) => e.kind === "circle").length === 4, "the count field: 4 circles");
  await app.shot("sketch-7-tools.png");
  await done();
  check(await page.evaluate(() => window.caad.state.result.ok), "saved; the part builds");
});