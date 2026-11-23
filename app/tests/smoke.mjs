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

  // Hover and click a face in the middle of the view.
  const box = await (await page.$("#view canvas")).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  console.log("\nselection after click:", JSON.stringify(await page.evaluate(() => window.caad.viewer.selection)));
  await page.screenshot({ path: `${OUT}/caad-4-select.png` });
  await done(0);
} catch (e) {
  console.log("TEST FAILED:", e.message);
  await done(1);
}
