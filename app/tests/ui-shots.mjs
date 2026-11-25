// Screenshots of the main UI states at a laptop-sized window, for checking the layout by eye.
// Usage: node tests/ui-shots.mjs [dir] [width] [height]
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const [OUT = ".", W = "1175", H = "650"] = process.argv.slice(2);
const PORT = 5195;
const server = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"], defaultViewport: { width: +W, height: +H },
});
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  [page exception]", e.message));
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch { /* about:blank */ } });
  for (let i = 0; i < 30; i++) { try { await page.goto(`http://127.0.0.1:${PORT}/`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  await page.waitForFunction(() => /^(Built|Failed)/.test(document.getElementById("status").textContent), { timeout: 300_000 });
  const box = await (await page.$("#view canvas")).boundingBox();
  // Select the wall's front face (flat), as a user would before sketching on it.
  await page.evaluate(async () => {
    const { kernel, viewer, state } = window.caad;
    const r = await kernel.highlightIndices("bracket.faces().filter_by(Axis.Y).sort_by(Axis.Z)[-1]");
    viewer.setSelection([{ kind: "face", index: r.faces[0] }]);
    viewer.onSelect(viewer.selection);
  });
  await page.waitForFunction(() => window.caad.state.selection.length > 0);
  await page.screenshot({ path: `${OUT}/ui-1-selected.png` });
  await page.click("#sketch-button");
  await page.waitForFunction(() => window.caad.sketcher.active, { timeout: 60_000 });
  await page.evaluate(() => window.caad.sketcher.act([{ op: "add", kind: "rectangle", args: [[-15, -1], [15, 11]] }]));
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6);
  await page.screenshot({ path: `${OUT}/ui-2-sketch.png` });
  await page.click("#sketch-panel button[title^='Leave']");
  await page.click("#toggle-code");
  await page.click("#toggle-left");
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: `${OUT}/ui-3-compact.png` });
  console.log("screenshots written");
} finally { await browser.close(); server.kill(); }
