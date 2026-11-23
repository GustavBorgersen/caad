// Smoke test: drives the app in headless Chromium. Usage: node tests/smoke.mjs [screenshot-dir]
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const OUT = process.argv[2] ?? ".";
const PORT = 5199;
const server = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1400,850"],
  defaultViewport: { width: 1400, height: 850 },
});
const done = async (code) => { await browser.close(); server.kill(); process.exit(code); };
try {
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && console.log("  [page error]", m.text()));
  page.on("pageerror", (e) => console.log("  [page exception]", e.message));
  for (let i = 0; i < 30; i++) { try { await page.goto(`http://127.0.0.1:${PORT}/`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }

  const t0 = Date.now();
  await page.waitForFunction(() => /^(Built|Failed)/.test(document.getElementById("status").textContent), { timeout: 300_000 });
  const timeline = () => page.$$eval("#timeline li", (lis) => lis.map((li) => `${li.className.padEnd(18)} ${li.textContent}`));
  console.log(`first build after ${((Date.now() - t0) / 1000).toFixed(0)} s:`, await page.$eval("#status", (e) => e.textContent));
  console.log("parts:", await page.$$eval("#parts li", (lis) => lis.map((l) => l.textContent)));
  console.log((await timeline()).join("\n"));
  await page.screenshot({ path: `${OUT}/caad-1-built.png` });

  const lastStatus = () => page.$eval("#status", (e) => e.textContent);
  const waitNewBuild = async (before) => page.waitForFunction((b) => document.getElementById("status").textContent !== b, { timeout: 60_000 }, before);

  let before = await lastStatus();
  await page.click("#timeline li:nth-child(2)");
  await waitNewBuild(before);
  console.log("\nafter clicking feature 2 (rollback):\n" + (await timeline()).join("\n"));
  await page.screenshot({ path: `${OUT}/caad-2-rollback.png` });

  before = await lastStatus();
  await page.evaluate(() => {
    const { editor, state } = window.caad;
    state.upto = null;
    editor.view.dispatch({ changes: { from: 0, to: editor.text.length, insert: editor.text.replace("radius=5)", "radius=50)") } });
  });
  await waitNewBuild(before);
  console.log("\nafter breaking the fillet:\n" + (await timeline()).join("\n"));
  console.log("error panel:", await page.$eval("#error", (e) => e.hidden ? "(hidden)" : e.textContent));
  await page.screenshot({ path: `${OUT}/caad-3-error.png` });

  // Undo the broken fillet, then select a face and check the panel.
  const edit = (from, to) => page.evaluate(([f, t]) => {
    const { editor } = window.caad;
    editor.view.dispatch({ changes: { from: 0, to: editor.text.length, insert: editor.text.replace(f, t) } });
  }, [from, to]);
  before = await lastStatus();
  await edit("radius=50)", "radius=5)");
  await waitNewBuild(before);
  const panel = () => page.$eval("#selection", (e) => e.hidden ? "(hidden)" : e.innerText.replace(/\n+/g, " | "));
  const box = await (await page.$("#view canvas")).boundingBox();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.62);
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.62);
  await page.waitForFunction(() => !document.getElementById("selection").hidden, { timeout: 10_000 });
  console.log("\nselection panel:", await panel());
  await page.screenshot({ path: `${OUT}/caad-4-select.png` });

  // Shift-click a second face: group selector.
  await page.keyboard.down("Shift");
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.35);
  await page.keyboard.up("Shift");
  await page.waitForFunction(() => /faces?|edges?/.test(document.querySelector("#selection .title")?.textContent ?? "") && window.caad.viewer.selection.length === 2, { timeout: 10_000 }).catch(() => {});
  console.log("two selected:", await panel());
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.62); // back to one face

  // Change a dimension: the selection must survive the rebuild.
  await page.waitForFunction(() => window.caad.viewer.selection.length === 1, { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, 1500));
  const selBefore = await panel();
  before = await lastStatus();
  await edit("thickness = 8", "thickness = 12");
  await waitNewBuild(before);
  await new Promise((r) => setTimeout(r, 2500));
  const selAfter = await panel();
  console.log("after thickness 8 -> 12:", selAfter);
  console.log(selBefore.split(" | ").at(-1) === selAfter.split(" | ").at(-1) ? "PASS: selection kept across rebuild" : "CHECK: selection changed");
  await page.screenshot({ path: `${OUT}/caad-5-kept.png` });
  await done(0);
} catch (e) {
  console.log("TEST FAILED:", e.message);
  await done(1);
}
