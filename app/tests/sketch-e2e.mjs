// Sketch mode end to end in headless Chromium: draw with the mouse, cut, sketch on a face, new part.
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
  const waitBuild = (gen) => page.waitForFunction((g) => (window.caad.state.result?.gen ?? 0) > g, { timeout: 60_000 }, gen);
  const gen = () => page.evaluate(() => window.caad.state.result?.gen ?? 0);
  const v0 = await volume();

  // 1. Sketch on the top plane, draw a rectangle with two clicks, cut through all.
  await page.click("#sketch-button");
  await page.click('#plane-choice [data-plane="Plane.XY"]');
  await page.waitForSelector("#sketch-panel:not([hidden])");
  const box = await (await page.$("#view canvas")).boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  for (const [fx, fy] of [[0.40, 0.45], [0.55, 0.55]]) { const [x, y] = at(fx, fy); await page.mouse.move(x, y); await page.mouse.click(x, y); }
  check((await page.$$("#sketch-panel .shape")).length === 1, "a rectangle was drawn with two clicks");
  await page.screenshot({ path: `${OUT}/sketch-1-drawing.png` });
  await page.evaluate(() => [...document.querySelectorAll("#sketch-panel .op button")].find((b) => b.textContent === "Cut").click());
  await page.evaluate(() => [...document.querySelectorAll("#sketch-panel label")].find((l) => l.textContent.includes("through all")).querySelector("input").click());
  let g = await gen();
  await page.evaluate(() => document.querySelector("#sketch-panel .primary").click());
  await waitBuild(g);
  let src = await code();
  check(src.includes("with BuildSketch(Plane.XY):") && src.includes("extrude(until=Until.LAST, mode=Mode.SUBTRACT)"), "code for the sketch and the cut was inserted");
  console.log(src.split("\n").filter((l) => /BuildSketch\(Plane|Rectangle\(|Until.LAST|Locations\(\(-?\d/.test(l)).join("\n"));
  const v1 = await volume();
  check(v1 < v0, `the cut removed material (volume ${v0} -> ${v1})`);
  const feats = await page.$$eval("#timeline .feature", (l) => l.map((x) => x.className));
  check(feats.every((c) => c.includes("ok")), `all ${feats.length} features ok in the timeline`);
  await page.screenshot({ path: `${OUT}/sketch-2-cut.png` });

  // 2. Sketch on a selected face (by selector), circle at an offset, extrude 6.
  g = await gen();
  await page.evaluate(() => window.caad.startSketch("bracket.faces().filter_by(Axis.Y).sort_by(Axis.Z)[-1]", "the wall"));
  await page.waitForSelector("#sketch-panel:not([hidden])");
  await page.evaluate(() => window.caad.sketcher.addShape({ kind: "circle", x: 12, y: 6, r: 5 }));
  await page.evaluate(() => document.querySelector("#sketch-panel .primary").click());
  await waitBuild(g).catch(async () => console.log("  no rebuild; status:", await page.$eval("#status", (e) => e.textContent), "| error panel:", await page.$eval("#error", (e) => e.textContent)));
  src = await code();
  check(src.includes("with BuildSketch(bracket.faces().filter_by(Axis.Y).sort_by(Axis.Z)[-1]):") && src.includes("Circle(5)") && src.includes("extrude(amount=10)"), "sketch on a face inserted with its selector");
  check((await volume()) > v1, "the extrude added material");
  await page.screenshot({ path: `${OUT}/sketch-3-face.png` });

  // 3. A new part, then its first feature.
  g = await gen();
  await page.click("#new-part");
  await waitBuild(g);
  check((await page.$$eval("#parts li", (l) => l.map((x) => x.textContent))).includes("widget.py"), "new part created and listed");
  await page.click("#sketch-button");
  await page.click('#plane-choice [data-plane="Plane.XY"]');
  await page.waitForSelector("#sketch-panel:not([hidden])");
  await page.evaluate(() => window.caad.sketcher.addShape({ kind: "poly", pts: [[0, 0], [30, 0], [30, 10], [10, 20], [0, 20]] }));
  g = await gen();
  await page.evaluate(() => document.querySelector("#sketch-panel .primary").click());
  await waitBuild(g).catch(async () => console.log("  no rebuild; status:", await page.$eval("#status", (e) => e.textContent), "| code:", await code()));
  src = await code();
  check(!src.includes("pass") && src.includes("Polygon((0, 0), (30, 0)"), "the first feature replaced `pass`");
  console.log(src);
  check(Math.abs((await volume()) - 5000) < 1, `new part volume is 5000 mm³ (${await volume()})`);
  await page.screenshot({ path: `${OUT}/sketch-4-newpart.png` });
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  await finish(failures ? 1 : 0);
} catch (e) {
  console.log("TEST ERROR:", e.message);
  await finish(1);
}
