// Sketch editor end to end in headless Chromium (docs/06-sketches.md): draw, Done, extrude; reopen and drag;
// line chains with snapping and inferred constraints; delete; a sketch on a face; Cancel; a new part.
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
  const gen = () => page.evaluate(() => window.caad.state.result?.gen ?? 0);
  // A build after `gen` of the saved code (the feature dialog's previews don't count).
  const waitBuild = (g) => page.waitForFunction((x) => (window.caad.state.result?.gen ?? 0) > x && !window.caad.state.result.preview, { timeout: 60_000 }, g);
  const sketchSrc = () => page.evaluate(() => window.caad.sketcher.src);
  const model = () => page.evaluate(() => window.caad.sketcher.model);
  const idle = () => page.waitForFunction(() => window.caad.sketcher.idle, { timeout: 30_000 });
  const opened = () => page.waitForFunction(() => window.caad.sketcher.active && !document.getElementById("sketch-panel").hidden, { timeout: 60_000 });
  const screen = (x, y) => page.evaluate(([a, b]) => window.caad.sketcher.screen([a, b]), [x, y]);
  const clickAt = async (x, y) => { const s = await screen(x, y); await page.mouse.move(s.x, s.y); await page.mouse.click(s.x, s.y); await idle(); };
  const dragFrom = async ([x0, y0], [x1, y1]) => {
    const a = await screen(x0, y0), b = await screen(x1, y1);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8);
    await page.mouse.up();
    await idle();
  };
  const tool = (t) => page.click(`#sketch-panel [data-tool="${t}"]`);
  const state = () => page.$eval("#sketch-panel .state", (s) => s.textContent);
  const done = async () => { const g = await gen(); await page.click("#sketch-panel .primary"); await waitBuild(g); };
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
    for (let i = 0; ; i++) {
      try { await (await page.$$("#timeline .feature"))[index].click({ count: 2 }); return; }
      catch (e) { if (i > 5 || !/detached|not clickable/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 200)); }
    }
  };
  const v0 = await volume();
  const saved0 = await code();

  // 1. A new sketch on Top: the rectangle tool is ready; two clicks; nothing is saved before Done.
  await page.click("#sketch-button");
  await page.click('#plane-choice [data-plane="Plane.XY"]');
  await opened();
  check(await page.$eval('#sketch-panel [data-tool="rect"]', (b) => b.classList.contains("on")), "an empty sketch opens with the rectangle tool");
  await clickAt(-10, -6);
  await clickAt(4, 6);
  let m = await model();
  check(m.entities.filter((e) => e.kind === "line").length === 4 && /rect1 = c\.rectangle\(\(-10, -6\), \(4, 6\)\)/.test(await sketchSrc()), "two clicks drew a rectangle: rect1 = c.rectangle((-10, -6), (4, 6))");
  check((await code()) === saved0, "nothing is saved yet");
  check(/4 degrees of freedom/.test(await state()), `under-constrained: ${await state()}`);
  await page.screenshot({ path: `${OUT}/sketch-1-rect.png` });
  await done();
  let src = await code();
  check(src.includes("from caad import Constrained") && /with BuildSketch\(Plane\.XY, mode=Mode\.PRIVATE\) as sk1:\n\s+with Constrained\(\) as c:\n\s+rect1 = c\.rectangle\(\(-10, -6\), \(4, 6\)\)\n/.test(src), "Done saves the sketch");
  await extrude({ end: "Until.LAST", result: "Mode.SUBTRACT" });
  const v1 = await volume();
  check(v1 < v0, `cut through all (volume ${v0} -> ${v1})`);

  // 2. Reopen it (double-click) and drag a corner: the numbers in the code follow.
  const sketchIndex = (await page.evaluate(() => window.caad.state.result.timeline.features.findIndex((f) => f.name === "sk1")));
  await dblclickFeature(sketchIndex);
  await opened();
  check(await page.evaluate((i) => window.caad.state.upto === i - 1, sketchIndex), "double-clicking the sketch opens it, rolled back to just before it");
  await dragFrom([4, 6], [8, 10]);
  check(/rect1 = c\.rectangle\(\(-10, -6\), \(8(\.\d+)?, 10(\.\d+)?\)\)/.test(await sketchSrc()), `dragging the corner moved it: ${(await sketchSrc()).match(/rect1 = .*/)?.[0]}`);
  await done();
  const v2 = await volume();
  check(/rect1 = c\.rectangle\(\(-10, -6\), \(8/.test(await code()) && v2 < v1, `saved; the bigger cut removes more (${v1} -> ${v2})`);
  await page.screenshot({ path: `${OUT}/sketch-2-dragged.png` });

  // 3. A line chain on the front face: horizontal is inferred, ending on the first point closes the triangle.
  await page.evaluate(() => window.caad.startSketch("bracket.faces().sort_by(Axis.Y)[0]", "the front"));
  await opened();
  await tool("line");
  await clickAt(-20, 2);
  await clickAt(-5, 2.1);
  await clickAt(-12, 6);
  await clickAt(-20, 2);
  src = await sketchSrc();
  check(/line1 = c\.line\(\(-20, 2\), \(-5, 2\.1\)\)\n\s+c\.horizontal\(line1\)\n\s+line2 = c\.line\(line1\.end, \(-12, 6\)\)\n\s+line3 = c\.line\(line2\.end, line1\.start\)/.test(src),
    "a chain: lines share their ends, the nearly horizontal one is horizontal, the last ends on the first point");
  console.log(src.split("\n").filter((l) => /line\d = |horizontal/.test(l)).map((l) => "   " + l.trim()).join("\n"));
  m = await model();
  check(m.dof === 5 && /5 degrees/.test(await state()), `a triangle with one constraint: 5 degrees of freedom (${m.dof})`);
  await page.screenshot({ path: `${OUT}/sketch-3-chain.png` });

  // 4. Select the second line and delete it: the third, which starts at its end, goes too.
  await tool("select");
  await clickAt(-8.5, 4.05);
  await page.keyboard.press("Delete");
  await idle();
  src = await sketchSrc();
  check(src.includes("line1 = c.line") && !src.includes("line2 =") && !src.includes("line3 ="), "deleting a line takes what depends on it");
  await page.click("#sketch-panel button:not(.primary)[title^='Leave']");
  await page.waitForFunction(() => !window.caad.sketcher.active);
  check(!(await code()).includes("sk2"), "Cancel saves nothing");

  // 5. A circle on the top face, centred on the origin (it snaps there): extrude it.
  await page.evaluate(() => window.caad.startSketch("bracket.faces().filter_by(Axis.Z).sort_by(Axis.Z)[-1]", "the top"));
  await opened();
  await tool("circle");
  await clickAt(0.3, -0.2);
  await clickAt(4, 0);
  src = await sketchSrc();
  check(/circle1 = c\.circle\(c\.origin, 4\)/.test(src), "the circle's centre snapped to the origin: c.circle(c.origin, 4)");
  await done();
  await extrude();
  check((await volume()) > v2, "extruded");

  // 6. A new part: a closed polyline, then its extrude.
  const g = await gen();
  await page.click("#new-part");
  await waitBuild(g);
  await page.click("#sketch-button");
  await page.click('#plane-choice [data-plane="Plane.XY"]');
  await opened();
  await tool("line");
  for (const [x, y] of [[0, 0], [30, 0], [30, 10], [10, 20], [0, 20], [0, 0]]) await clickAt(x, y);
  await page.screenshot({ path: `${OUT}/sketch-4-polyline.png` });
  await done();
  src = await code();
  check(!src.includes("pass") && /line1 = c\.line\(c\.origin, \(30, 0\)\)/.test(src) && /line5 = c\.line\(line4\.end, c\.origin\)/.test(src) && (await volume()) === null,
    "the new part's sketch is saved (starting and ending on the origin, where the clicks snapped); no solid yet");
  await extrude();
  check(Math.abs((await volume()) - 5000) < 1, `extruded 10: volume 5000 mm³ (${await volume()})`);
  await page.screenshot({ path: `${OUT}/sketch-5-newpart.png` });

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  await finish(failures ? 1 : 0);
} catch (e) {
  console.log("TEST ERROR:", e.message);
  await (await browser.pages()).at(-1).screenshot({ path: `${OUT}/sketch-error.png` }).catch(() => {});
  await finish(1);
}
