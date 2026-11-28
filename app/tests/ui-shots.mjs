// Screenshots of the main UI states at a laptop-sized window, for checking the layout by eye (not a test).
// Usage: node tests/ui-shots.mjs [dir] [width] [height]   (CHROME as for the tests)
import { join } from "node:path";
import { openApp } from "./ui/env.mjs";

const [OUT = ".", W = "1175", H = "650"] = process.argv.slice(2);
const app = await openApp("ui-shots", { viewport: { width: +W, height: +H } });
const { page } = app;
try {
  const box = await (await page.$("#view canvas")).boundingBox();
  // Select the wall's front face (flat), as a user would before sketching on it.
  await page.evaluate(async () => {
    const { kernel, viewer } = window.caad;
    const r = await kernel.highlightIndices("bracket.faces().filter_by(Axis.Y).sort_by(Axis.Z)[-1]");
    viewer.setSelection([{ kind: "face", index: r.faces[0] }]);
    viewer.onSelect(viewer.selection);
  });
  await page.waitForFunction(() => window.caad.state.selection.length > 0);
  await page.screenshot({ path: join(OUT, "ui-1-selected.png") });
  await page.click('#commands [data-command="sketch"]'); // on the selected face
  await page.waitForFunction(() => window.caad.sketcher.active, { timeout: 60_000 });
  await page.evaluate(() => window.caad.sketcher.act([{ op: "add", kind: "rectangle", args: [[-15, -1], [15, 11]] }]));
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6);
  await page.screenshot({ path: join(OUT, "ui-2-sketch.png") });
  await page.click("#sketch-panel button[title^='Leave']");
  await page.click("#toggle-code");
  await page.click("#collapse-left");
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: join(OUT, "ui-3-compact.png") });
  console.log("screenshots written");
} finally { await app.close(); }
