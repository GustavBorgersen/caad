// Feature editing end to end in headless Chromium (docs/05-feature-model.md): double-click a feature,
// edit it in the dialog with a live preview, OK / Cancel, call features, picking edges from the view.
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const OUT = process.argv[2] ?? ".";
const PORT = 5197;
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
  let lastAlert = "";
  page.on("dialog", (d) => { lastAlert = d.message(); d.accept(); }); // confirm() and alert()
  for (let i = 0; i < 30; i++) { try { await page.goto(`http://127.0.0.1:${PORT}/`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  await page.waitForFunction(() => /^(Built|Failed)/.test(document.getElementById("status").textContent), { timeout: 300_000 });

  const code = () => page.evaluate(() => window.caad.editor.text);
  const gen = () => page.evaluate(() => window.caad.state.result?.gen ?? 0);
  // A build after `g` of the saved code (the dialog's previews don't count).
  const waitBuild = (g) => page.waitForFunction((x) => (window.caad.state.result?.gen ?? 0) > x && !window.caad.state.result.preview, { timeout: 60_000 }, g);
  const panelOpen = () => page.waitForSelector("#feature-panel:not([hidden]) .row", { timeout: 30_000 });
  const panelClosed = () => page.waitForSelector("#feature-panel[hidden]", { timeout: 30_000 });
  const dblclick = async (index) => {
    for (let i = 0; ; i++) { // the timeline re-renders after every build: retry with a fresh row
      try { await (await page.$$("#timeline .feature"))[index].click({ count: 2 }); return; }
      catch (e) { if (i > 5 || !/detached|not clickable/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 200)); }
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
  const original = await code();

  // 1. Fillet: edit the radius, preview, OK.
  await dblclick(5);
  await panelOpen();
  check(await page.evaluate(() => window.caad.state.upto === 4), "double-click rolls back to just before the feature");
  let v = await values();
  check(v.radius === "" && v.objects === "= 2 edges", `fields show values in the rolled-back model (${JSON.stringify(v)})`);
  await page.screenshot({ path: `${OUT}/feature-1-dialog.png` });
  await type("radius", "hole_d / 2");
  await page.waitForFunction(() => document.querySelector('#feature-panel [data-field="radius"] .value')?.textContent === "= 5", { timeout: 30_000 });
  check(true, "an edited expression shows its value (hole_d / 2 = 5)");
  check((await code()) === original, "the preview doesn't change the file");
  let g = await gen();
  await page.click("#feature-panel .primary");
  await panelClosed();
  await waitBuild(g);
  let src = await code();
  check(src === original.replace("radius=5)", "radius=hole_d / 2)"), "OK changes only the radius in the code");
  check(await page.evaluate(() => window.caad.state.upto === null && window.caad.state.result.ok), "the rollback bar returns and the part builds");

  // 2. Extrude: tick Symmetric (a new keyword argument).
  await dblclick(1);
  await panelOpen();
  check((await page.$eval('#feature-panel [data-field="to_extrude"] select', (s) => s.selectedOptions[0].textContent)) === "Pending: base", "the extrude shows its pending sketch");
  await (await fieldInput("both")).click();
  g = await gen();
  await page.keyboard.press("Enter").catch(() => {});
  await page.click("#feature-panel .primary").catch(() => {});
  await panelClosed();
  await waitBuild(g);
  src = await code();
  check(src.includes("extrude(amount=thickness, both=True)"), "Symmetric adds both=True");

  // 3. Cancel (Escape) writes nothing.
  const before = await code();
  await dblclick(1);
  await panelOpen();
  await type("amount", "99");
  await page.keyboard.press("Escape");
  await panelClosed();
  await new Promise((r) => setTimeout(r, 500));
  check((await code()) === before && await page.evaluate(() => window.caad.state.upto === null), "Escape cancels: file unchanged, rollback restored");

  // 4. A failing value shows in the dialog's preview.
  await dblclick(5);
  await panelOpen();
  await type("radius", "50");
  await page.waitForFunction(() => /Preview:/.test(document.querySelector("#feature-panel .message")?.textContent ?? ""), { timeout: 30_000 });
  check(/Preview: /.test(await message()), `preview error shown: ${(await message()).slice(0, 80)}`);
  await page.screenshot({ path: `${OUT}/feature-2-error.png` });

  // 5. Use selection: pick edges in the view for the fillet.
  await page.evaluate(async () => {
    const r = await window.caad.kernel.highlightIndices("bracket.edges().filter_by(Axis.Z)");
    window.caad.viewer.onSelect(r.edges.map((index) => ({ kind: "edge", index })));
  });
  await page.waitForFunction(() => window.caad.state.selection.length === 1, { timeout: 30_000 });
  await page.click('#feature-panel [data-field="objects"] .use');
  const picked = await page.$eval('#feature-panel [data-field="objects"] input', (i) => i.value);
  check(/^bracket\.edges\(\)/.test(picked), `Use selection fills in a verified selector: ${picked}`);
  g = await gen();
  await page.click("#feature-panel .cancel");
  await panelClosed();
  await waitBuild(g);

  // 6. The bracket's hole is a hole feature: depth, then a counterbore (its own fields appear).
  await dblclick(4);
  await panelOpen();
  let rows = await page.$$eval("#feature-panel .row", (r) => r.map((x) => x.dataset.field));
  check(JSON.stringify(rows) === JSON.stringify(["kind", "locations", "radius", "depth"]) &&
    (await page.$eval('#feature-panel [data-field="depth"] input', (i) => i.placeholder)) === "through all", `hole fields: ${rows} (depth empty: through all)`);
  await page.select('#feature-panel [data-field="kind"] select', "CounterBoreHole");
  rows = await page.$$eval("#feature-panel .row", (r) => r.map((x) => x.dataset.field));
  check(rows.includes("counter_bore_radius") && rows.includes("counter_bore_depth"), "choosing Counterbore shows its sizes");
  await type("depth", "6");
  g = await gen();
  await page.click("#feature-panel .primary");
  await panelClosed();
  await waitBuild(g);
  check((await code()).includes("        CounterBoreHole(radius=hole_d / 2, counter_bore_radius=10, counter_bore_depth=5, depth=6)"), "a counterbore hole, 6 deep: only the hole's call changed");

  // 7. A call feature (Cylinder in the pump body): generic dialog, add an argument.
  await page.evaluate(() => window.caad.openPart("caad-examples/parts/pump_body.py"));
  await page.waitForFunction(() => window.caad.state.path === "caad-examples/parts/pump_body.py" && window.caad.state.result?.ok, { timeout: 60_000 });
  const pumpBefore = await code();
  await dblclick(0);
  await panelOpen();
  const shown = await page.$$eval("#feature-panel .row", (rows) => rows.map((r) => r.dataset.field));
  check(JSON.stringify(shown) === JSON.stringify(["radius", "height", "align"]), `call feature shows the arguments in the code (${shown})`);
  await page.select("#feature-panel .add select", "arc_size");
  await type("arc_size", "180");
  g = await gen();
  await page.click("#feature-panel .primary");
  await panelClosed();
  await waitBuild(g);
  src = await code();
  check(src === pumpBefore.replace("Cylinder(outer_r, height, align=(Align.CENTER, Align.CENTER, Align.MIN))", "Cylinder(outer_r, height, align=(Align.CENTER, Align.CENTER, Align.MIN), arc_size=180)"),
    "Add argument appends arc_size=180");
  await page.screenshot({ path: `${OUT}/feature-3-call.png` });
  // A code feature (with Locations(...): Cylinder(...)): no dialog, the code is shown.
  await dblclick(2);
  await new Promise((r) => setTimeout(r, 300));
  check(await page.$eval("#feature-panel", (p) => p.hidden) && /code/.test(await page.$eval("#status", (s) => s.textContent)), "a code feature points to the code panel");

  // 8. Named sketches: the extrude's sketch is a choice of the sketches before it.
  const twoSketches = `from build123d import *

with BuildPart() as part:
    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:
        Rectangle(20, 20)
    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk2:
        Circle(5)
    extrude(sk1.sketch, amount=5)
`;
  g = await gen();
  await page.evaluate((src) => window.caad.applyCode("named.py", src), twoSketches);
  await page.waitForFunction(() => window.caad.state.path === "named.py" && window.caad.state.result?.ok, { timeout: 60_000 });
  await dblclick(2);
  await panelOpen();
  const options = await page.$$eval('#feature-panel [data-field="to_extrude"] option', (o) => o.map((x) => x.textContent));
  check(JSON.stringify(options) === JSON.stringify(["None", "sk1", "sk2"]), `sketch choices: ${options}`);
  await page.select('#feature-panel [data-field="to_extrude"] select', "sk2.sketch");
  g = await gen();
  await page.click("#feature-panel .primary");
  await panelClosed();
  await waitBuild(g);
  check((await code()).includes("    extrude(sk2.sketch, amount=5)\n"), "choosing sk2 changes only the sketch reference");
  check(Math.abs(await page.evaluate(() => window.caad.state.result.summary.volume) - Math.PI * 25 * 5) < 0.01, "and the part is the extruded circle");

  // 9. Deleting: refused while a later feature uses it, else the line goes.
  lastAlert = "";
  await (await page.$$("#timeline .feature .del"))[1].evaluate((b) => b.click());
  await page.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 500));
  check(/^'sk2' is used by 3\. Extrude sk2/.test(lastAlert) && (await code()).includes("as sk2:"), `deleting a used sketch is refused: ${lastAlert}`);
  g = await gen();
  await (await page.$$("#timeline .feature .del"))[0].evaluate((b) => b.click());
  await waitBuild(g);
  check(!(await code()).includes("sk1") && await page.evaluate(() => window.caad.state.result.ok), "deleting the unused sk1 removes its lines");

  // 10. "+ Fillet" at the rollback bar: a new feature on the selected edges, opened in its dialog.
  await page.evaluate(() => window.caad.openPart("caad-examples/parts/bracket.py"));
  await page.waitForFunction(() => window.caad.state.path === "caad-examples/parts/bracket.py" && window.caad.state.result?.ok, { timeout: 60_000 });
  const bracketBefore = await code();
  await page.evaluate(async () => {
    const r = await window.caad.kernel.highlightIndices("bracket.edges().filter_by(Axis.Z).group_by(Axis.Y)[-1]");
    window.caad.viewer.onSelect(r.edges.map((index) => ({ kind: "edge", index })));
  });
  await page.waitForFunction(() => window.caad.state.selection.length === 1, { timeout: 30_000 });
  await page.evaluate(() => [...document.querySelectorAll(".rollback-bar button")].find((b) => b.textContent === "+ Fillet").click());
  await panelOpen();
  check(/New fillet/.test(await page.$eval("#feature-panel .head", (h) => h.textContent)) && (await values()).objects === "= 2 edges", "the dialog opens for the new fillet on the 2 selected edges");
  check((await code()) === bracketBefore, "nothing is written before OK");
  await type("radius", "2");
  g = await gen();
  await page.click("#feature-panel .primary");
  await panelClosed();
  await waitBuild(g);
  src = await code();
  const added = src.slice(bracketBefore.length);
  check(src.startsWith(bracketBefore) && /^    fillet\(bracket\.edges\(\)[^\n]*, radius=2\)\n$/.test(added), `OK adds the fillet at the end: ${added.trim()}`);
  check(await page.evaluate(() => window.caad.state.result.ok && window.caad.state.result.timeline.features.length === 7), "and it builds as feature 7");

  // 11. A new chamfer, cancelled: nothing changes.
  await page.evaluate(async () => {
    const r = await window.caad.kernel.highlightIndices("bracket.edges().filter_by(Axis.X).sort_by(Axis.Z)[-1]");
    window.caad.viewer.onSelect(r.edges.map((index) => ({ kind: "edge", index })));
  });
  await page.waitForFunction(() => window.caad.state.selection.length === 1, { timeout: 30_000 });
  await page.evaluate(() => [...document.querySelectorAll(".rollback-bar button")].find((b) => b.textContent === "+ Chamfer").click());
  await panelOpen();
  await page.keyboard.press("Escape");
  await panelClosed();
  await new Promise((r) => setTimeout(r, 500));
  check((await code()) === src, "a cancelled new chamfer leaves the file as it was");

  // 12. "+ Hole" at the points of a sketch: a hole at each point, drilled into the sketch's face.
  const plate = `from build123d import *\nfrom caad import Constrained\n\nwith BuildPart() as plate:\n    Box(60, 40, 8)\n    with BuildSketch(plate.faces().sort_by(Axis.Z)[-1], mode=Mode.PRIVATE) as sk1:\n        with Constrained() as c:\n            p1 = c.point(-20, 10)\n            p2 = c.point(20, 10)\n            c.hdistance(p1, p2, 40)\n`;
  await page.evaluate((s) => window.caad.applyCode("caad-examples/parts/holes.py", s), plate);
  await page.waitForFunction(() => window.caad.state.path === "caad-examples/parts/holes.py" && window.caad.state.result?.ok, { timeout: 60_000 });
  check(await page.evaluate(() => window.caad.state.result.sketches[0]?.points.length === 6), "the sketch's two points show in the view");
  await page.evaluate(() => [...document.querySelectorAll(".rollback-bar button")].find((b) => b.textContent === "+ Hole").click());
  await panelOpen();
  const at = await page.$eval('#feature-panel [data-field="locations"] select', (s) => [...s.options].map((o) => `${o.selected ? "*" : ""}${o.textContent}`).join());
  check(/New hole/.test(await page.$eval("#feature-panel .head", (h) => h.textContent)) && at === "*sk1 (2 points)", `the dialog opens for the new hole at sk1 (${at})`);
  await type("radius", "3");
  g = await gen();
  await page.click("#feature-panel .primary");
  await panelClosed();
  await waitBuild(g);
  src = await code();
  check(src.includes("from caad import Constrained, points\n") && src.endsWith("    with Locations(*points(sk1)):\n        Hole(radius=3)\n") &&
    Math.abs(60 * 40 * 8 - (await page.evaluate(() => window.caad.state.result.summary.volume)) - 2 * Math.PI * 9 * 8) < 0.01, "+ Hole: two holes through the plate, at the points");
  // Move a point (as the sketch editor would): its hole moves along.
  g = await gen();
  await page.evaluate((s) => window.caad.applyCode("caad-examples/parts/holes.py", s), src.replace("c.point(20, 10)", "c.point(20, -10)").replace("            c.hdistance(p1, p2, 40)\n", ""));
  await waitBuild(g);
  check(await page.evaluate(() => window.caad.state.result.ok), "the moved point's part builds");
  const holeAt = await page.evaluate(async () => (await window.caad.kernel.snippet("[round(f.center().Y, 3) for f in plate.faces().filter_by(GeomType.CYLINDER)]")).value);
  check(String(holeAt).includes("-10") && String(holeAt).includes("10"), `moving a point moves its hole (hole centres at y = ${holeAt})`);

  // 12b. A sketch on XY under the part: + Hole drills up into it; Start at the far side puts the counterbore on top.
  const under = `from build123d import *\nfrom caad import Constrained\n\nwith BuildPart() as base:\n    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:\n        with Constrained() as c:\n            c.rectangle((-30, -20), (30, 20))\n            p1 = c.point(10, 5)\n    extrude(sk1.sketch, amount=10)\n`;
  await page.evaluate((s) => window.caad.applyCode("caad-examples/parts/under.py", s), under);
  await page.waitForFunction(() => window.caad.state.path === "caad-examples/parts/under.py" && window.caad.state.result?.ok, { timeout: 60_000 });
  await page.evaluate(() => [...document.querySelectorAll(".rollback-bar button")].find((b) => b.textContent === "+ Hole").click());
  await panelOpen();
  check(await page.$eval('#feature-panel [data-field="reverse"] input', (i) => i.checked), "+ Hole under the part: Drill the other way is ticked (towards the part)");
  await page.select('#feature-panel [data-field="kind"] select', "CounterBoreHole");
  await page.click('#feature-panel [data-field="far"] input');
  g = await gen();
  await page.click("#feature-panel .primary");
  await panelClosed();
  await waitBuild(g);
  src = await code();
  const capZ = await page.evaluate(async () => (await window.caad.kernel.snippet("max(round(f.center().Z, 3) for f in base.faces() if f.geom_type.name == 'CYLINDER' and f.radius > 3)")).value);
  check(src.includes("with Locations(*points(sk1, reverse=True, far=base)):\n        CounterBoreHole(") && Number(capZ) > 5, `counterbore from the far side: on the top face (z ${capZ})`);

  // 13. "+ Revolve" the latest sketch, a quarter turn; "+ Mirror" it about YZ.
  const ring = `from build123d import *\n\nwith BuildPart() as ring:\n    with BuildSketch(Plane.XZ, mode=Mode.PRIVATE) as sk1:\n        with Locations((12.5, 2.5)):\n            Rectangle(5, 5)\n`;
  g = await gen();
  await page.evaluate((s) => window.caad.applyCode("caad-examples/parts/ring.py", s), ring);
  await page.waitForFunction(() => window.caad.state.path === "caad-examples/parts/ring.py" && window.caad.state.result?.ok, { timeout: 60_000 });
  await page.evaluate(() => [...document.querySelectorAll(".rollback-bar button")].find((b) => b.textContent === "+ Revolve").click());
  await panelOpen();
  await type("revolution_arc", "90");
  g = await gen();
  await page.click("#feature-panel .primary");
  await panelClosed();
  await waitBuild(g);
  const quarter = Math.PI * (15 ** 2 - 10 ** 2) * 5 / 4;
  check((await code()).endsWith("    revolve(sk1.sketch, revolution_arc=90)\n") && Math.abs((await page.evaluate(() => window.caad.state.result.summary.volume)) - quarter) < 0.01, "+ Revolve: a quarter ring");
  await page.evaluate(() => [...document.querySelectorAll(".rollback-bar button")].find((b) => b.textContent === "+ Mirror").click());
  await panelOpen();
  g = await gen();
  await page.click("#feature-panel .primary");
  await panelClosed();
  await waitBuild(g);
  check((await code()).endsWith("    mirror(about=Plane.YZ)\n") && Math.abs((await page.evaluate(() => window.caad.state.result.summary.volume)) - 2 * quarter) < 0.01, "+ Mirror about YZ: twice the volume");
  await page.screenshot({ path: `${OUT}/feature-4-revolve.png` });

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  await finish(failures ? 1 : 0);
} catch (e) {
  console.log("ERROR:", e.message);
  await (await browser.pages()).at(-1).screenshot({ path: `${OUT}/feature-error.png` }).catch(() => {});
  await finish(1);
}
