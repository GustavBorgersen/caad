// Feature editing end to end (docs/05-feature-model.md): double-click a feature, edit it in the dialog with a
// live preview, OK / Cancel, call features, picking edges from the view, new features at the rollback bar.
import { after } from "node:test";
import { check } from "../common.mjs";
import { openApp, sleep, steps } from "../ui/env.mjs";

const app = await openApp("feature");
after(() => app.close());
const { page } = app;
const step = steps(app);

const code = () => page.evaluate(() => window.caad.editor.text);
const gen = () => page.evaluate(() => window.caad.state.result?.gen ?? 0);
// A build after `g` of the saved code (the dialog's previews don't count).
const waitBuild = (g) => page.waitForFunction((x) => (window.caad.state.result?.gen ?? 0) > x && !window.caad.state.result.preview, { timeout: 60_000 }, g);
const panelOpen = () => page.waitForSelector("#feature-panel:not([hidden]) .row", { timeout: 30_000 });
const panelClosed = () => page.waitForSelector("#feature-panel[hidden]", { timeout: 30_000 });
const dblclick = async (index) => {
  for (let i = 0; ; i++) { // the timeline re-renders after every build: retry with a fresh row
    try { await (await page.$$("#timeline .feature"))[index].click({ count: 2 }); return; }
    catch (e) { if (i > 5 || !/detached|not clickable/.test(e.message)) throw e; await sleep(200); }
  }
};
const fieldInput = (name) => page.$(`#feature-panel [data-field="${name}"] input, #feature-panel [data-field="${name}"] select`);
const type = async (name, text) => {
  const input = await fieldInput(name);
  await input.click({ count: 3 });
  await input.type(text);
};
const values = () => page.$$eval("#feature-panel .row", (rows) => Object.fromEntries(rows.map((r) => [r.dataset.field, r.querySelector(".value")?.textContent ?? ""])));
const message = () => page.$eval("#feature-panel .message", (m) => (m.hidden ? "" : m.textContent));
const ok = async () => { const g = await gen(); await page.click("#feature-panel .primary"); await panelClosed(); await waitBuild(g); };
const addAtBar = (label) => page.evaluate((l) => [...document.querySelectorAll(".rollback-bar button")].find((b) => b.textContent === l).click(), label);
/** Open a part (or write `applySrc` to it and open it) and wait for its build. */
const open = async (path, applySrc) => {
  const g = await gen();
  await page.evaluate((p, s) => s ? window.caad.applyCode(p, s) : window.caad.openPart(p), path, applySrc);
  await page.waitForFunction((p, x) => window.caad.state.path === p && (window.caad.state.result?.gen ?? 0) > x && window.caad.state.result.ok, { timeout: 60_000 }, path, g);
};
const selectEdges = async (selector) => {
  await page.evaluate(async (s) => {
    const r = await window.caad.kernel.highlightIndices(s);
    window.caad.viewer.onSelect(r.edges.map((index) => ({ kind: "edge", index })));
  }, selector);
  await page.waitForFunction(() => window.caad.state.selection.length === 1, { timeout: 30_000 });
};
const volume = () => page.evaluate(() => window.caad.state.result.summary.volume);
const original = await code();
let src;

step("fillet: edit the radius, preview, OK", async () => {
  await dblclick(5);
  await panelOpen();
  check(await page.evaluate(() => window.caad.state.upto === 4), "double-click rolls back to just before the feature");
  const v = await values();
  check(v.radius === "" && v.objects === "= 2 edges", "fields show values in the rolled-back model", v);
  await app.shot("feature-1-dialog.png");
  await type("radius", "hole_d / 2");
  await page.waitForFunction(() => document.querySelector('#feature-panel [data-field="radius"] .value')?.textContent === "= 5", { timeout: 30_000 });
  check((await code()) === original, "the preview doesn't change the file");
  await ok();
  check((await code()) === original.replace("radius=5)", "radius=hole_d / 2)"), "OK changes only the radius in the code");
  check(await page.evaluate(() => window.caad.state.upto === null && window.caad.state.result.ok), "the rollback bar returns and the part builds");
});

step("extrude: tick Symmetric (a new keyword argument)", async () => {
  await dblclick(1);
  await panelOpen();
  check((await page.$eval('#feature-panel [data-field="to_extrude"] select', (s) => s.selectedOptions[0].textContent)) === "Pending: base", "the extrude shows its pending sketch");
  await (await fieldInput("both")).click();
  const g = await gen();
  await page.keyboard.press("Enter").catch(() => {});
  await page.click("#feature-panel .primary").catch(() => {});
  await panelClosed();
  await waitBuild(g);
  check((await code()).includes("extrude(amount=thickness, both=True)"), "Symmetric adds both=True");
});

step("Escape cancels: nothing is written", async () => {
  const before = await code();
  await dblclick(1);
  await panelOpen();
  await type("amount", "99");
  await page.keyboard.press("Escape");
  await panelClosed();
  await sleep(500);
  check((await code()) === before && await page.evaluate(() => window.caad.state.upto === null), "file unchanged, rollback restored");
});

step("a failing value shows in the dialog's preview", async () => {
  await dblclick(5);
  await panelOpen();
  await type("radius", "50");
  await page.waitForFunction(() => /Preview:/.test(document.querySelector("#feature-panel .message")?.textContent ?? ""), { timeout: 30_000 });
  check(/Preview: /.test(await message()), "preview error shown", await message());
  await app.shot("feature-2-error.png");
});

step("Use selection: pick edges in the view for the fillet", async () => {
  await selectEdges("bracket.edges().filter_by(Axis.Z)");
  await page.click('#feature-panel [data-field="objects"] .use');
  const picked = await page.$eval('#feature-panel [data-field="objects"] input', (i) => i.value);
  check(/^bracket\.edges\(\)/.test(picked), "Use selection fills in a verified selector", picked);
  const g = await gen();
  await page.click("#feature-panel .cancel");
  await panelClosed();
  await waitBuild(g);
});

step("a hole feature: depth, then a counterbore with its own fields", async () => {
  await dblclick(4);
  await panelOpen();
  let rows = await page.$$eval("#feature-panel .row", (r) => r.map((x) => x.dataset.field));
  check(JSON.stringify(rows) === JSON.stringify(["kind", "locations", "radius", "depth"]) &&
    (await page.$eval('#feature-panel [data-field="depth"] input', (i) => i.placeholder)) === "through all", "hole fields (depth empty: through all)", rows);
  await page.select('#feature-panel [data-field="kind"] select', "CounterBoreHole");
  rows = await page.$$eval("#feature-panel .row", (r) => r.map((x) => x.dataset.field));
  check(rows.includes("counter_bore_radius") && rows.includes("counter_bore_depth"), "choosing Counterbore shows its sizes", rows);
  await type("depth", "6");
  await ok();
  check((await code()).includes("        CounterBoreHole(radius=hole_d / 2, counter_bore_radius=10, counter_bore_depth=5, depth=6)"), "a counterbore hole, 6 deep: only the hole's call changed");
});

step("a call feature (Cylinder in the pump body): generic dialog, add an argument; a code feature has none", async () => {
  await open("caad-examples/parts/pump_body.py");
  const pumpBefore = await code();
  await dblclick(0);
  await panelOpen();
  const shown = await page.$$eval("#feature-panel .row", (rows) => rows.map((r) => r.dataset.field));
  check(JSON.stringify(shown) === JSON.stringify(["radius", "height", "align"]), "call feature shows the arguments in the code", shown);
  await page.select("#feature-panel .add select", "arc_size");
  await type("arc_size", "180");
  await ok();
  check((await code()) === pumpBefore.replace("Cylinder(outer_r, height, align=(Align.CENTER, Align.CENTER, Align.MIN))", "Cylinder(outer_r, height, align=(Align.CENTER, Align.CENTER, Align.MIN), arc_size=180)"),
    "Add argument appends arc_size=180");
  await app.shot("feature-3-call.png");
  // A code feature (with Locations(...): Cylinder(...)): no dialog, the code is shown.
  await dblclick(2);
  await sleep(300);
  check(await page.$eval("#feature-panel", (p) => p.hidden) && /code/.test(await page.$eval("#status", (s) => s.textContent)), "a code feature points to the code panel");
});

step("named sketches: the extrude's sketch is a choice of the sketches before it", async () => {
  await open("named.py", `from build123d import *

with BuildPart() as part:
    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:
        Rectangle(20, 20)
    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk2:
        Circle(5)
    extrude(sk1.sketch, amount=5)
`);
  await dblclick(2);
  await panelOpen();
  const options = await page.$$eval('#feature-panel [data-field="to_extrude"] option', (o) => o.map((x) => x.textContent));
  check(JSON.stringify(options) === JSON.stringify(["None", "sk1", "sk2"]), "sketch choices", options);
  await page.select('#feature-panel [data-field="to_extrude"] select', "sk2.sketch");
  await ok();
  check((await code()).includes("    extrude(sk2.sketch, amount=5)\n"), "choosing sk2 changes only the sketch reference");
  check(Math.abs((await volume()) - Math.PI * 25 * 5) < 0.01, "and the part is the extruded circle");
});

step("deleting: refused while a later feature uses it, else the lines go", async () => {
  app.lastDialog = "";
  await (await page.$$("#timeline .feature .del"))[1].evaluate((b) => b.click());
  await sleep(500);
  check(/^'sk2' is used by 3\. Extrude sk2/.test(app.lastDialog) && (await code()).includes("as sk2:"), "deleting a used sketch is refused", app.lastDialog);
  const g = await gen();
  await (await page.$$("#timeline .feature .del"))[0].evaluate((b) => b.click());
  await waitBuild(g);
  check(!(await code()).includes("sk1") && await page.evaluate(() => window.caad.state.result.ok), "deleting the unused sk1 removes its lines");
});

step("+ Fillet at the rollback bar: a new feature on the selected edges", async () => {
  await open("caad-examples/parts/bracket.py");
  const bracketBefore = await code();
  await selectEdges("bracket.edges().filter_by(Axis.Z).group_by(Axis.Y)[-1]");
  await addAtBar("+ Fillet");
  await panelOpen();
  check(/New fillet/.test(await page.$eval("#feature-panel .head", (h) => h.textContent)) && (await values()).objects === "= 2 edges", "the dialog opens for the new fillet on the 2 selected edges");
  check((await code()) === bracketBefore, "nothing is written before OK");
  await type("radius", "2");
  await ok();
  src = await code();
  const added = src.slice(bracketBefore.length);
  check(src.startsWith(bracketBefore) && /^    fillet\(bracket\.edges\(\)[^\n]*, radius=2\)\n$/.test(added), "OK adds the fillet at the end", added);
  check(await page.evaluate(() => window.caad.state.result.ok && window.caad.state.result.timeline.features.length === 7), "and it builds as feature 7");
});

step("a new chamfer, cancelled: nothing changes", async () => {
  await selectEdges("bracket.edges().filter_by(Axis.X).sort_by(Axis.Z)[-1]");
  await addAtBar("+ Chamfer");
  await panelOpen();
  await page.keyboard.press("Escape");
  await panelClosed();
  await sleep(500);
  check((await code()) === src, "a cancelled new chamfer leaves the file as it was");
});

step("+ Hole at the points of a sketch; moving a point moves its hole", async () => {
  await open("caad-examples/parts/holes.py", `from build123d import *\nfrom caad import Constrained\n\nwith BuildPart() as plate:\n    Box(60, 40, 8)\n    with BuildSketch(plate.faces().sort_by(Axis.Z)[-1], mode=Mode.PRIVATE) as sk1:\n        with Constrained() as c:\n            p1 = c.point(-20, 10)\n            p2 = c.point(20, 10)\n            c.hdistance(p1, p2, 40)\n`);
  check(await page.evaluate(() => window.caad.state.result.sketches[0]?.points.length === 6), "the sketch's two points show in the view");
  await addAtBar("+ Hole");
  await panelOpen();
  const at = await page.$eval('#feature-panel [data-field="locations"] select', (s) => [...s.options].map((o) => `${o.selected ? "*" : ""}${o.textContent}`).join());
  check(/New hole/.test(await page.$eval("#feature-panel .head", (h) => h.textContent)) && at === "*sk1 (2 points)", "the dialog opens for the new hole at sk1", at);
  await type("radius", "3");
  await ok();
  src = await code();
  check(src.includes("from caad import Constrained, points\n") && src.endsWith("    with Locations(*points(sk1)):\n        Hole(radius=3)\n") &&
    Math.abs(60 * 40 * 8 - (await volume()) - 2 * Math.PI * 9 * 8) < 0.01, "+ Hole: two holes through the plate, at the points", src);
  // Move a point (as the sketch editor would): its hole moves along.
  const g = await gen();
  await page.evaluate((s) => window.caad.applyCode("caad-examples/parts/holes.py", s), src.replace("c.point(20, 10)", "c.point(20, -10)").replace("            c.hdistance(p1, p2, 40)\n", ""));
  await waitBuild(g);
  check(await page.evaluate(() => window.caad.state.result.ok), "the moved point's part builds");
  const holeAt = await page.evaluate(async () => (await window.caad.kernel.snippet("[round(f.center().Y, 3) for f in plate.faces().filter_by(GeomType.CYLINDER)]")).value);
  check(String(holeAt).includes("-10") && String(holeAt).includes("10"), "moving a point moves its hole", `hole centres at y = ${holeAt}`);
});

step("+ Hole under the part drills up into it; Start at the far side puts the counterbore on top", async () => {
  await open("caad-examples/parts/under.py", `from build123d import *\nfrom caad import Constrained\n\nwith BuildPart() as base:\n    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:\n        with Constrained() as c:\n            c.rectangle((-30, -20), (30, 20))\n            p1 = c.point(10, 5)\n    extrude(sk1.sketch, amount=10)\n`);
  await addAtBar("+ Hole");
  await panelOpen();
  check(await page.$eval('#feature-panel [data-field="reverse"] input', (i) => i.checked), "Drill the other way is ticked (towards the part)");
  await page.select('#feature-panel [data-field="kind"] select', "CounterBoreHole");
  await page.click('#feature-panel [data-field="far"] input');
  await ok();
  src = await code();
  const capZ = await page.evaluate(async () => (await window.caad.kernel.snippet("max(round(f.center().Z, 3) for f in base.faces() if f.geom_type.name == 'CYLINDER' and f.radius > 3)")).value);
  check(src.includes("with Locations(*points(sk1, reverse=True, far=base)):\n        CounterBoreHole(") && Number(capZ) > 5, "counterbore from the far side: on the top face", `z ${capZ}`);
});

step("+ Revolve the latest sketch a quarter turn; + Mirror it about YZ", async () => {
  await open("caad-examples/parts/ring.py", `from build123d import *\n\nwith BuildPart() as ring:\n    with BuildSketch(Plane.XZ, mode=Mode.PRIVATE) as sk1:\n        with Locations((12.5, 2.5)):\n            Rectangle(5, 5)\n`);
  await addAtBar("+ Revolve");
  await panelOpen();
  await type("revolution_arc", "90");
  await ok();
  const quarter = Math.PI * (15 ** 2 - 10 ** 2) * 5 / 4;
  check((await code()).endsWith("    revolve(sk1.sketch, revolution_arc=90)\n") && Math.abs((await volume()) - quarter) < 0.01, "+ Revolve: a quarter ring");
  await addAtBar("+ Mirror");
  await panelOpen();
  await ok();
  check((await code()).endsWith("    mirror(about=Plane.YZ)\n") && Math.abs((await volume()) - 2 * quarter) < 0.01, "+ Mirror about YZ: twice the volume");
  await app.shot("feature-4-revolve.png");
});

step("+ Revolve about a construction line of the sketch, chosen in the dialog", async () => {
  await open("caad-examples/parts/axis.py", `from build123d import *\nfrom caad import Constrained\n\nwith BuildPart() as ring:\n    with BuildSketch(Plane.XZ, mode=Mode.PRIVATE) as sk1:\n        with Constrained() as c:\n            rect1 = c.rectangle((10, 0), (14, 4))\n            line1 = c.line((20, 0), (20, 10), construction=True)\n`);
  await addAtBar("+ Revolve");
  await panelOpen();
  const axes = await page.$eval('#feature-panel [data-field="axis"] select', (s) => [...s.options].map((o) => o.textContent));
  check(axes.includes("sk1: line1 (construction)") && axes.includes("sk1: rect1.left"), "the axis can be a line of the sketch", axes);
  await page.select('#feature-panel [data-field="axis"] select', "axis(sk1, line1)");
  await ok();
  const src = await code();
  check(src.includes("from caad import Constrained, axis\n") && src.endsWith("    revolve(sk1.sketch, axis=axis(sk1, line1))\n") && Math.abs((await volume()) - Math.PI * (100 - 36) * 4) < 0.01,
    "revolve(sk1.sketch, axis=axis(sk1, line1)): a ring around x = 20", src);
});

step("+ Extrude: click the sketch's regions in the view to extrude only those", async () => {
  await open("caad-examples/parts/regions.py", `from build123d import *\nfrom caad import Constrained\n\nwith BuildPart() as plate:\n    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:\n        with Constrained() as c:\n            rect1 = c.rectangle((-30, -20), (30, 20))\n            circle1 = c.circle((0, 0), 10)\n`);
  await addAtBar("+ Extrude");
  await panelOpen();
  const chosen = () => page.evaluate(() => window.caad.regionPicker()?.regions.map((r) => r.selected) ?? []);
  await page.waitForFunction(() => window.caad.regionPicker()?.regions.length === 2, { timeout: 30_000 });
  const [ring, disc] = (await chosen())[0] ? [0, 1] : [1, 0];
  check((await chosen()).filter(Boolean).length === 1 && /Click regions/.test(await page.$eval("#feature-panel .note", (n) => n.textContent)),
    "the sketch's two regions show in the view; sk1.sketch uses the ring", await chosen());
  const click = async (i) => {
    const at = await page.evaluate((i) => { const r = window.caad.viewer.canvas.getBoundingClientRect(); const p = window.caad.regionPicker().screen(i); return { x: r.left + p.x, y: r.top + p.y }; }, i);
    await page.mouse.move(at.x, at.y);
    await page.mouse.click(at.x, at.y);
  };
  await click(disc);
  await page.waitForFunction(() => window.caad.regionPicker()?.regions.every((r) => r.selected), { timeout: 30_000 });
  const label = await page.$eval('#feature-panel [data-field="to_extrude"] select', (s) => s.selectedOptions[0].textContent);
  check(label === "sk1: 2 regions", "clicking the disc adds it: regions(sk1, ...) with both", label);
  await click(ring);
  await page.waitForFunction((d) => { const r = window.caad.regionPicker()?.regions; return r && r[d].selected && r.filter((x) => x.selected).length === 1; }, { timeout: 30_000 }, disc);
  await app.shot("feature-5-regions.png");
  await ok();
  const src = await code();
  check(src.includes("from caad import Constrained, regions\n") && /\n    extrude\(regions\(sk1, \([-\d.]+, [-\d.]+\)\), amount=10\)\n$/.test(src) && Math.abs((await volume()) - Math.PI * 100 * 10) < 0.01,
    "clicking the ring removes it: only the disc is extruded", src);
  check(await page.evaluate(() => window.caad.regionPicker() === null && window.caad.viewer.tool === null), "the regions are gone with the dialog");
});

step("+ Plane on the selected top face, offset; ✎ Sketch on it; it hides once used", async () => {
  await open("caad-examples/parts/planes.py", `from build123d import *\n\nwith BuildPart() as block:\n    Box(20, 20, 10)\n`);
  await addAtBar("+ Plane");
  await panelOpen();
  check(/New plane/.test(await page.$eval("#feature-panel .head", (h) => h.textContent)) &&
    (await page.$eval('#feature-panel [data-field="base"] select', (s) => s.value)) === "Plane.XY", "nothing selected: + Plane is on XY");
  await page.waitForFunction(() => window.caad.state.result.preview && window.caad.state.result.planes.length === 1, { timeout: 30_000 });
  // Pick the top face while the dialog is open: Use selection makes it the plane's base.
  await page.evaluate(async () => {
    const r = await window.caad.kernel.highlightIndices("block.faces().sort_by(Axis.Z)[-1]");
    window.caad.viewer.onSelect(r.faces.map((index) => ({ kind: "face", index })));
  });
  await page.waitForFunction(() => window.caad.state.selection.length === 1, { timeout: 30_000 });
  await page.click('#feature-panel [data-field="base"] .use');
  await page.evaluate(() => window.caad.viewer.onSelect([])); // else ✎ Sketch would sketch on the selected face
  await type("offset", "5");
  await ok();
  const src = await code();
  const planes = await page.evaluate(() => window.caad.state.result.planes);
  check(/\n    pl1 = Plane\(block\.faces\(\)[^\n]+\)\.offset\(5\)\n$/.test(src) && /Plane pl1 on a face, offset 5 mm/.test(await page.$eval("#timeline", (t) => t.textContent)),
    "pl1 = Plane(<top face>).offset(5)", src);
  check(planes.length === 1 && planes[0].corners.filter((v, i) => i % 3 === 2).every((z) => Math.abs(z - 10) < 1e-6), "the plane shows, 5 above the top", planes);
  await app.shot("feature-6-plane.png");

  check(await page.evaluate(() => window.caad.state.selection.length === 0), "nothing is selected");
  await page.click("#sketch-button");
  check((await page.$$eval("#plane-features button", (b) => b.map((x) => x.textContent))).join() === "pl1", "✎ Sketch offers the plane");
  await page.click("#plane-features button");
  await page.waitForFunction(() => window.caad.sketcher.active, { timeout: 60_000 });
  check(await page.evaluate(() => Math.abs(window.caad.sketcher.plane.origin[2] - 10) < 1e-6), "the sketch is on pl1 (z = 10)");
  await page.click('#sketch-panel [data-tool="circle"]');
  for (const [x, y] of [[0, 0], [3, 0]]) {
    const s = await page.evaluate(([a, b]) => window.caad.sketcher.screen([a, b]), [x, y]);
    await page.mouse.move(s.x, s.y);
    await page.mouse.click(s.x, s.y);
    await page.waitForFunction(() => window.caad.sketcher.idle, { timeout: 30_000 });
  }
  const g = await gen();
  await page.click("#sketch-panel .primary");
  await waitBuild(g);
  check((await code()).includes("    with BuildSketch(pl1, mode=Mode.PRIVATE) as sk1:\n") && (await page.evaluate(() => window.caad.state.result.planes.length)) === 0,
    "Done: a sketch on pl1, which isn't drawn any more");
});

step("+ Extrude the face selected in the view; Remove goes into the part", async () => {
  await open("caad-examples/parts/faces.py", `from build123d import *\n\nwith BuildPart() as block:\n    Box(20, 20, 10)\n`);
  await page.evaluate(async () => {
    const r = await window.caad.kernel.highlightIndices("block.faces().sort_by(Axis.Z)[-1]");
    window.caad.viewer.onSelect(r.faces.map((index) => ({ kind: "face", index })));
  });
  await page.waitForFunction(() => window.caad.state.selection.length === 1, { timeout: 30_000 });
  await addAtBar("+ Extrude");
  await panelOpen();
  const source = await page.$eval('#feature-panel [data-field="to_extrude"] select', (s) => s.selectedOptions[0].textContent);
  check(/^Faces: block\.faces\(\)/.test(source) && !(await page.$("#feature-panel .note")), "the selected face is what's extruded (no sketch regions to click)", source);
  const flip = () => page.$eval('#feature-panel [data-field="dir"] input', (i) => i.checked);
  check(!(await flip()), "adding: out of the part");
  await page.select('#feature-panel [data-field="mode"] select', "Mode.SUBTRACT");
  check(await flip(), "Remove turns Opposite direction on: into the part");
  await type("amount", "4");
  await ok();
  const src = await code();
  const face = source.slice("Faces: ".length);
  check(src.endsWith(`    extrude(${face}, amount=4, dir=-${face}.faces()[0].normal_at(), mode=Mode.SUBTRACT)\n`) && Math.abs((await volume()) - 20 * 20 * 6) < 1e-6,
    "OK: 4 mm cut from the top face", src.split("\n").at(-2));
  check(/Cut face, 4 mm/.test(await page.$eval("#timeline", (t) => t.textContent)), "labelled Cut face in the timeline");
  await app.shot("feature-7-face.png");
});
