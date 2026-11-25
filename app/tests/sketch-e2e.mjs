// Sketch mode end to end in headless Chromium: draw with the mouse, Done, then + Extrude / cut; on a face; new part.
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const OUT = process.argv[2] ?? ".";
const PORT = 5196;
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
  page.on("dialog", (d) => d.accept("widget"));
  for (let i = 0; i < 30; i++) { try { await page.goto(`http://127.0.0.1:${PORT}/`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  await page.waitForFunction(() => /^(Built|Failed)/.test(document.getElementById("status").textContent), { timeout: 300_000 });
  const volume = () => page.evaluate(() => window.caad.state.result?.summary?.volume ?? null);
  const code = () => page.evaluate(() => window.caad.editor.text);
  // A build after `gen` of the saved code (the feature dialog's previews don't count).
  const waitBuild = (gen) => page.waitForFunction((g) => (window.caad.state.result?.gen ?? 0) > g && !window.caad.state.result.preview, { timeout: 60_000 }, gen);
  const gen = () => page.evaluate(() => window.caad.state.result?.gen ?? 0);
  const v0 = await volume();

  const sketches = () => page.evaluate(() => window.caad.state.result?.sketches.map((s) => s.name) ?? []);
  /** Close the sketch (Done): only the named sketch is added, shown as an outline. */
  const done = async () => {
    const g = await gen();
    await page.evaluate(() => document.querySelector("#sketch-panel .primary").click());
    await waitBuild(g);
  };
  /** "+ Extrude" at the rollback bar, set the dialog's fields, OK. */
  const extrude = async ({ end, result, opposite } = {}) => {
    await page.evaluate(() => [...document.querySelectorAll(".rollback-bar button")].find((b) => b.textContent === "+ Extrude").click());
    await page.waitForSelector("#feature-panel:not([hidden]) .row", { timeout: 30_000 });
    if (end) await page.select('#feature-panel [data-field="until"] select', end);
    if (result) await page.select('#feature-panel [data-field="mode"] select', result);
    if (opposite) await page.click('#feature-panel [data-field="dir"] input');
    const g = await gen();
    await page.click("#feature-panel .primary");
    await page.waitForSelector("#feature-panel[hidden]", { timeout: 30_000 });
    await waitBuild(g);
  };

  // 1. Sketch on the top plane, draw a rectangle with two clicks, Done; then cut through all.
  await page.click("#sketch-button");
  await page.click('#plane-choice [data-plane="Plane.XY"]');
  await page.waitForSelector("#sketch-panel:not([hidden])");
  check(!(await page.$("#sketch-panel .op")), "the sketch panel has no extrude/cut options");
  const box = await (await page.$("#view canvas")).boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  for (const [fx, fy] of [[0.40, 0.45], [0.55, 0.55]]) { const [x, y] = at(fx, fy); await page.mouse.move(x, y); await page.mouse.click(x, y); }
  check((await page.$$("#sketch-panel .shape")).length === 1, "a rectangle was drawn with two clicks");
  await page.screenshot({ path: `${OUT}/sketch-1-drawing.png` });
  const before = await code();
  await done();
  let src = await code();
  check(src.includes("    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:\n        with Constrained() as c:\n            rect1 = c.rectangle((") && !/extrude\(sk1/.test(src),
    "Done adds only the named sketch, as a constrained sketch");
  check(src.includes("from build123d import *\nfrom caad import Constrained\n") && /c\.length\(rect1\.bottom, [\d.]+\)\n\s+c\.length\(rect1\.left, [\d.]+\)\n\s+c\.hdistance\(c\.origin, rect1\.center, -?[\d.]+\)\n\s+c\.vdistance\(c\.origin, rect1\.center, -?[\d.]+\)/.test(src),
    "with the import, its size as dimensions and its position from the origin");
  console.log(src.split("\n").filter((l) => l.includes("rect1")).join("\n"));
  check(await page.evaluate(() => window.caad.state.result.timeline.features.at(-1).sketch?.dof === 0), "fully constrained (0 degrees of freedom)");
  check(JSON.stringify(await sketches()) === '["sk1"]' && (await volume()) === v0, "the sketch shows as an outline; the part is unchanged");
  await page.screenshot({ path: `${OUT}/sketch-2-sketch.png` });
  await extrude({ end: "Until.LAST", result: "Mode.SUBTRACT" });
  src = await code();
  check(src.includes("    extrude(sk1.sketch, until=Until.LAST, mode=Mode.SUBTRACT)\n"), "+ Extrude, Through all, Remove: the cut uses sk1");
  const v1 = await volume();
  check(v1 < v0 && (await sketches()).length === 0, `the cut removed material (volume ${v0} -> ${v1}) and the used sketch is no longer drawn`);
  const feats = await page.$$eval("#timeline .feature", (l) => l.map((x) => x.className));
  check(feats.every((c) => c.includes("ok")), `all ${feats.length} features ok in the timeline`);
  await page.screenshot({ path: `${OUT}/sketch-3-cut.png` });

  // 2. Sketch on a selected face (by selector), circle at an offset; extrude it 10 (the default).
  await page.evaluate(() => window.caad.startSketch("bracket.faces().filter_by(Axis.Y).sort_by(Axis.Z)[-1]", "the wall"));
  await page.waitForSelector("#sketch-panel:not([hidden])");
  await page.evaluate(() => window.caad.sketcher.addShape({ kind: "circle", x: 12, y: 6, r: 5 }));
  await done();
  await extrude();
  src = await code();
  check(src.includes("with BuildSketch(bracket.faces().filter_by(Axis.Y).sort_by(Axis.Z)[-1], mode=Mode.PRIVATE) as sk2:") && src.includes("circle1 = c.circle((12, 6), 5)\n            c.radius(circle1, 5)") && src.includes("extrude(sk2.sketch, amount=10)"), "sketch on a face with its selector, extruded");
  const v2 = await volume();
  check(v2 > v1, "the extrude added material");
  await page.screenshot({ path: `${OUT}/sketch-4-face.png` });

  // 2b. Cut through all from a sketch on the bottom face: Opposite direction makes it go into the part.
  await page.evaluate(() => window.caad.startSketch("bracket.faces().sort_by(Axis.Z)[0]", "the bottom"));
  await page.waitForSelector("#sketch-panel:not([hidden])");
  await page.evaluate(() => window.caad.sketcher.addShape({ kind: "circle", x: 20, y: 0, r: 2 }));
  await done();
  await extrude({ end: "Until.LAST", result: "Mode.SUBTRACT", opposite: true });
  src = await code();
  check(src.includes("extrude(sk3.sketch, until=Until.LAST, dir=-sk3.sketch.faces()[0].normal_at(), mode=Mode.SUBTRACT)"), "Opposite direction flips the sketch's normal");
  const v3 = await volume();
  check(await page.evaluate(() => window.caad.state.result.ok) && Math.abs(v2 - v3 - Math.PI * 4 * 8) < 0.5, `it removed a 4 mm hole through the 8 mm base (${(v2 - v3).toFixed(1)} mm³)`);

  // 3. A new part: a sketch alone (no solid yet), then its extrude.
  let g = await gen();
  await page.click("#new-part");
  await waitBuild(g);
  check((await page.$$eval("#parts li", (l) => l.map((x) => x.textContent))).includes("widget.py"), "new part created and listed");
  await page.click("#sketch-button");
  await page.click('#plane-choice [data-plane="Plane.XY"]');
  await page.waitForSelector("#sketch-panel:not([hidden])");
  await page.evaluate(() => window.caad.sketcher.addShape({ kind: "poly", pts: [[0, 0], [30, 0], [30, 10], [10, 20], [0, 20]] }));
  await done();
  src = await code();
  check(!src.includes("pass") && src.includes("poly1 = c.polygon((0, 0), (30, 0), (30, 10), (10, 20), (0, 20))\n            c.fix(*poly1.points)") && (await volume()) === null && JSON.stringify(await sketches()) === '["sk1"]',
    "the sketch replaced `pass`: no solid yet, just the outline");
  await page.screenshot({ path: `${OUT}/sketch-5-only-sketch.png` });
  await extrude();
  console.log(await code());
  check(Math.abs((await volume()) - 5000) < 1, `extruded 10: volume 5000 mm³ (${await volume()})`);
  await page.screenshot({ path: `${OUT}/sketch-6-newpart.png` });
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  await finish(failures ? 1 : 0);
} catch (e) {
  console.log("TEST ERROR:", e.message);
  await finish(1);
}
