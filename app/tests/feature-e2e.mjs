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

  // 6. A code feature: no dialog, the code is shown.
  await dblclick(4);
  await new Promise((r) => setTimeout(r, 300));
  check(await page.$eval("#feature-panel", (p) => p.hidden) && /code/.test(await page.$eval("#status", (s) => s.textContent)), "a code feature points to the code panel");

  // 7. A call feature (Cylinder in the pump body): generic dialog, add an argument.
  await page.evaluate(() => window.caad.openPart("pump_body.py"));
  await page.waitForFunction(() => window.caad.state.path === "pump_body.py" && window.caad.state.result?.ok, { timeout: 60_000 });
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
  await page.evaluate(() => window.caad.openPart("bracket.py"));
  await page.waitForFunction(() => window.caad.state.path === "bracket.py" && window.caad.state.result?.ok, { timeout: 60_000 });
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

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  await finish(failures ? 1 : 0);
} catch (e) {
  console.log("ERROR:", e.message);
  await (await browser.pages()).at(-1).screenshot({ path: `${OUT}/feature-error.png` }).catch(() => {});
  await finish(1);
}
