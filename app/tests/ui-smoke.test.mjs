// UI smoke test, part of the fast set: the app starts from its own origin only, builds the bracket, rolls back,
// shows a failing feature, and selects faces in the view (the selection survives a rebuild).
import { after } from "node:test";
import { check } from "./common.mjs";
import { openApp, sleep, steps } from "./ui/env.mjs";

const app = await openApp("smoke", { wait: false });
after(() => app.close());
const { page } = app;
// Everything the page needs comes from its own origin: networks that filter CDNs and PyPI broke the start.
const foreign = new Set(); // page.on("request") also sees the kernel worker's requests
page.on("request", (r) => { if (!/^(http:\/\/127\.0\.0\.1:|data:|blob:)/.test(r.url())) foreign.add(r.url()); });
await app.built();

const step = steps(app);
const statuses = () => page.$$eval("#timeline li.feature", (lis) => lis.map((li) => li.className.replace("feature ", "")));
const status = () => page.$eval("#status", (e) => e.textContent);
/** Wait for a build (not a dialog's preview) whose result passes `pred` (a function source, run in the page on `r`). */
const waitResult = (pred) => page.waitForFunction(`(() => { const r = window.caad.state.result; return !!r && !r.preview && (${pred})(r); })()`, { timeout: 60_000 });
const edit = (from, to) => page.evaluate(([f, t]) => {
  const { editor } = window.caad;
  editor.view.dispatch({ changes: { from: 0, to: editor.text.length, insert: editor.text.replace(f, t) } });
}, [from, to]);
const panel = () => page.$eval("#selection", (e) => e.hidden ? "(hidden)" : e.innerText.replace(/\n+/g, " | "));
const canvasAt = async (fx, fy) => { const b = await (await page.$("#view canvas")).boundingBox(); return [b.x + b.width * fx, b.y + b.height * fy]; };

step("the first part builds, its files and features listed", async () => {
  check(/^Built/.test(await status()), `status: ${await status()}`);
  const parts = await page.$$eval("#parts li", (lis) => lis.map((l) => l.textContent));
  check(parts.includes("bracket.py") && parts.includes("pump_body.py"), "the examples are listed", parts);
  const s = await statuses();
  check(s.length === 6 && s.every((x) => x === "ok"), "six features, all built", s);
  await app.shot("caad-1-built.png");
});

step("clicking a feature rolls back to it", async () => {
  // In the page in one go: the timeline re-renders after every build, which can detach a row between finding and clicking it.
  await page.evaluate(() => document.querySelector("#timeline li:nth-child(2)").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  await waitResult("(r) => r.upto === 1");
  const s = await statuses();
  check(s.slice(0, 2).every((x) => x === "ok") && s.slice(2).every((x) => x === "rolled-back"), "the features after the second are rolled back", s);
  check(await page.$$eval("#timeline li.rollback-bar", (b) => b.length === 1 && b[0].previousElementSibling?.matches("li.feature:nth-child(2)")), "the rollback bar is after it");
  await app.shot("caad-2-rollback.png");
});

step("a failing fillet shows in the timeline and the error panel", async () => {
  await page.evaluate(() => { window.caad.state.upto = null; });
  await edit("radius=5)", "radius=50)");
  await waitResult("(r) => !r.ok");
  const s = await statuses();
  check(s[5] === "error" && s.slice(0, 5).every((x) => x === "ok"), "the fillet (feature 5, the last) fails, the features before it build", s);
  const error = await page.$eval("#error", (e) => e.hidden ? "" : e.textContent);
  check(/fillet|line 18/i.test(error), "the error panel explains it", error);
  await app.shot("caad-3-error.png");
});

step("clicking a face shows it and its selectors", async () => {
  await edit("radius=50)", "radius=5)");
  await waitResult("(r) => r.ok && r.upto === r.timeline.features.length - 1");
  const [x, y] = await canvasAt(0.45, 0.62);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await page.waitForFunction(() => !document.getElementById("selection").hidden, { timeout: 10_000 });
  const p = await panel();
  check(/^Face · /.test(p) && p.includes("bracket.faces()"), "the panel shows the face and a selector", p);
  await app.shot("caad-4-select.png");
});

step("shift-click adds a second face", async () => {
  const [x, y] = await canvasAt(0.62, 0.35);
  await page.keyboard.down("Shift");
  await page.mouse.click(x, y);
  await page.keyboard.up("Shift");
  await page.waitForFunction(() => window.caad.viewer.selection.length === 2 && /faces?|edges?/.test(document.querySelector("#selection .title")?.textContent ?? ""), { timeout: 10_000 });
  check(/^\d+ (face|edge)/.test(await panel()), "the panel shows both", await panel());
});

step("the selection survives a rebuild", async () => {
  const [x, y] = await canvasAt(0.45, 0.62);
  await page.mouse.click(x, y); // back to one face
  await page.waitForFunction(() => window.caad.viewer.selection.length === 1, { timeout: 10_000 });
  await sleep(1500);
  const best = () => page.$eval("#selection .sel code", (c) => c.textContent);
  const selBefore = await best();
  const v = await page.evaluate(() => window.caad.state.result.summary.volume);
  await edit("thickness = 8", "thickness = 12");
  await waitResult(`(r) => r.ok && r.summary.volume > ${v}`);
  await sleep(2500);
  const selAfter = await best();
  check(!(await page.$eval("#selection", (e) => e.hidden)) && selBefore === selAfter, "the same face's best selector after thickness 8 -> 12", { selBefore, selAfter });
  await app.shot("caad-5-kept.png");
});

step("no requests to other origins", () => {
  check(foreign.size === 0, "everything came from the page's origin", [...foreign]);
});
