// The layout and workflow of docs/09 and docs/10 end to end: the start page, commands with keys and tooltips, the
// shortcut sheet, context menus, standard views, parameters, undo and redo, deleting with Undo, the agent's marks,
// the preview colour, the code pane's toggle; and never a native popup.
import { after } from "node:test";
import { check } from "../common.mjs";
import { openApp, sleep, steps } from "../ui/env.mjs";

const app = await openApp("layout", { start: "page", code: false });
after(() => app.close());
const { page } = app;
const step = steps(app);

const gen = () => page.evaluate(() => window.caad.state.result?.gen ?? 0);
const waitBuild = (g) => page.waitForFunction((x) => (window.caad.state.result?.gen ?? 0) > x && !window.caad.state.result.preview && !window.caad.kernel.buildInflight, { timeout: 60_000 }, g);
const volume = () => page.evaluate(() => window.caad.state.result?.summary?.volume ?? null);
const code = () => page.evaluate(() => window.caad.editor.text);
const menuLabels = () => page.$$eval(".menu button.it .l", (b) => b.map((x) => x.textContent));
const clickMenu = async (label) => { await page.waitForSelector(".menu button.it", { timeout: 10_000 }); return clickMenuNow(label); };
const clickMenuNow = (label) => page.evaluate((l) => [...document.querySelectorAll(".menu button.it")].find((b) => b.querySelector(".l").textContent === l).click(), label);
const canvasAt = async (fx, fy) => { const b = await (await page.$("#view canvas")).boundingBox(); return [b.x + b.width * fx, b.y + b.height * fy]; };
/** Wait for a camera move to end. */
const still = () => page.waitForFunction(() => !window.caad.viewer.moving, { timeout: 15_000 });
const camDir = () => page.evaluate(() => { const v = window.caad.viewer; const c = v.camera.position.clone().sub(v.controls.target).normalize(); return [c.x, c.y, c.z].map((n) => +n.toFixed(2)); });

step("the first visit shows the start page; Explore the examples opens them", async () => {
  await page.waitForSelector("#start:not([hidden]) .choice", { timeout: 30_000 });
  const text = await page.$eval("#start", (s) => s.textContent);
  check(/Welcome to CAAD/.test(text) && /Open a folder/.test(text) && /Explore the examples/.test(text), "the start page offers a folder and the examples", text);
  check(await page.evaluate(() => getComputedStyle(document.getElementById("rail")).display === "none" && document.body.classList.contains("no-workspace")), "no rail while nothing is open");
  await page.click("#start [data-examples]");
  await app.built();
  check(await page.evaluate(() => document.getElementById("start").hidden && window.caad.state.path === "caad-examples/parts/bracket.py"), "the examples open on their first part");
  check(await page.evaluate(() => localStorage.getItem("caad.last")) === "examples", "and next time CAAD opens them directly");
});

step("commands: the toolbar names each command and its key; ? shows all keys; Esc closes it", async () => {
  const tip = await page.$eval('#commands [data-command="extrude"]', (b) => b.title);
  check(/^Extrude · E\n/.test(tip), "the tooltip names the command and its key", tip);
  await page.mouse.click(...(await canvasAt(0.95, 0.95))); // focus the page, not a field
  await page.keyboard.type("?");
  await page.waitForSelector(".sheet", { timeout: 5000 });
  const sheet = await page.$eval(".sheet", (s) => s.textContent);
  check(/Sketch\s*S/.test(sheet) && /Dimension\s*D/.test(sheet) && /Fit\s*F/.test(sheet) && /Undo\s*Ctrl\+Z/.test(sheet), "the sheet lists the keys by mode", sheet.slice(0, 300));
  await page.keyboard.press("Escape");
  check(!(await page.$(".sheet")), "Esc closes it");
});

step("right-click a flat face: the menu offers what fits it; Sketch on face starts a sketch there", async () => {
  const [x, y] = await canvasAt(0.42, 0.75);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y, { button: "right" });
  await page.waitForSelector(".menu", { timeout: 5000 });
  const items = await menuLabels();
  check(items.join() === "Sketch on face,Extrude face,Plane from face,View normal to,Copy selector", "face commands", items);
  const header = await page.$eval(".menu .h", (h) => h.textContent);
  check(header === "Face · plane", "the menu says what is under the mouse", header);
  await page.waitForFunction(() => window.caad.state.selection.length === 1, { timeout: 10_000 });
  await clickMenu("Sketch on face");
  await page.waitForFunction(() => window.caad.sketcher.active, { timeout: 60_000 });
  check(await page.evaluate(() => window.caad.commands.currentMode() === "sketch" && !!document.querySelector('#commands [data-tool="line"]')), "sketch mode: the toolbar has the sketch tools");
  check(/Sketch/.test(await page.$eval("#sketch-panel", (p) => p.textContent)) && !(await page.$eval("#sketch-status", (s) => s.hidden)), "the sketch's panel is docked, its status in the view");
  await page.click("#sketch-panel .cancel");
  await page.waitForFunction(() => !window.caad.sketcher.active && window.caad.commands.currentMode() === "part", { timeout: 30_000 });
});

step("right-click the empty view: standard views; the view cube turns with the camera", async () => {
  const [x, y] = await canvasAt(0.04, 0.5);
  await page.mouse.click(x, y, { button: "right" });
  await page.waitForSelector(".menu", { timeout: 5000 });
  check((await menuLabels()).join() === "Fit,Isometric,Front,Top,Right,Keyboard shortcuts", "view commands", await menuLabels());
  await clickMenu("Top");
  await still(); // the camera moves for 250 ms (longer when the machine is busy): check where it ends, not on the way
  check((await camDir())[2] === 1, "Top: looking straight down", await camDir());
  await page.keyboard.press("f"); // fit keeps the direction
  await still();
  check((await camDir())[2] === 1, "F fits, from the same side", await camDir());
  // The view cube: a click on its middle (the Top face, seen from above) keeps looking down; its edge turns the view.
  const cube = await (await page.$("#viewcube canvas")).boundingBox();
  await page.mouse.click(cube.x + cube.width / 2, cube.y + cube.height * 0.74);
  await still();
  const d = await camDir();
  check(d[2] < 0.99 && d[2] > 0.3, "a click on the cube's front edge turns the view towards it", d);
});

step("parameters: a value in the panel changes that line of the code; Ctrl+Z and Ctrl+Y", async () => {
  await page.click("#tab-timeline");
  const v0 = await volume();
  const g = await gen();
  await page.click("#param-thickness", { count: 3 });
  await page.keyboard.type("12");
  await page.keyboard.press("Enter");
  await waitBuild(g);
  check((await code()).includes("thickness = 12") && (await volume()) > v0, "thickness = 12, a thicker part");
  check(/Undo: thickness = 12/.test(await page.$eval("#undo", (b) => b.title)), "Undo names the change", await page.$eval("#undo", (b) => b.title));
  await page.mouse.click(...(await canvasAt(0.95, 0.95)));
  let g2 = await gen();
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
  await waitBuild(g2);
  check((await code()).includes("thickness = 8") && Math.abs((await volume()) - v0) < 1e-6, "Ctrl+Z: back to 8");
  g2 = await gen();
  await page.keyboard.down("Control"); await page.keyboard.press("y"); await page.keyboard.up("Control");
  await waitBuild(g2);
  check((await code()).includes("thickness = 12"), "Ctrl+Y: 12 again");
  check(/Redid: thickness = 12/.test(await app.message()), "the message says what was redone", await app.message());
});

step("deleting a feature happens at once, with Undo in the message", async () => {
  const before = await code();
  const g = await gen();
  await (await page.$$("#timeline .feature .del")).at(-1).evaluate((b) => b.click());
  await waitBuild(g);
  check(!(await code()).includes("fillet(") && /deleted/.test(await app.message()), "the fillet is gone, the message offers Undo", await app.message());
  const g2 = await gen();
  await page.evaluate(() => [...document.querySelectorAll("#messages button")].find((b) => b.textContent === "Undo").click());
  await waitBuild(g2);
  check((await code()) === before, "Undo brings it back");
});

step("the agent's change is marked in the timeline until you change the file", async () => {
  const g = await gen();
  const r = await page.evaluate(() => window.caad.agents.handlers.edit_part({ path: "caad-examples/parts/bracket.py", old_text: "radius=5)", new_text: "radius=4)" }));
  check(r.content[0].text.includes("built OK"), "the agent's edit builds", r.content[0].text);
  await waitBuild(g).catch(() => {});
  const marked = await page.$$eval("#timeline .feature", (rows) => rows.filter((li) => li.querySelector(".mark-agent")).map((li) => li.querySelector(".label").textContent));
  check(marked.length === 1 && /Fillet/.test(marked[0]), "the fillet the agent changed has the violet mark", marked);
  check(/Agent edit/.test(await page.$eval("#undo", (b) => b.title)), "and its change is in the history", await page.$eval("#undo", (b) => b.title));
  const g2 = await gen();
  await page.click("#param-hole_d", { count: 3 });
  await page.keyboard.type("11");
  await page.keyboard.press("Enter");
  await waitBuild(g2);
  check((await page.$$("#timeline .mark-agent")).length === 0, "your own change clears the marks");
});

step("a feature's dialog colours only what its preview changes", async () => {
  await page.evaluate(() => { const f = window.caad.state.result.timeline.features.find((x) => x.kind === "fillet"); window.caad.editFeature(f); });
  await page.waitForSelector("#feature-panel:not([hidden]) .row", { timeout: 30_000 });
  await page.waitForFunction(() => window.caad.state.result?.preview, { timeout: 30_000 });
  await sleep(300);
  const [fresh, faces] = await page.evaluate(() => [window.caad.viewer.fresh.size, window.caad.state.result.mesh.faces.length]);
  check(fresh >= 1 && fresh <= 4 && faces > 10, "the fillet's faces in the preview colour, not the whole part", { fresh, faces });
  check(await page.evaluate(() => document.body.classList.contains("docked") && getComputedStyle(document.getElementById("feature-panel")).display !== "none"), "the dialog is docked");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#feature-panel[hidden]", { timeout: 10_000 });
  check(await page.evaluate(() => window.caad.viewer.fresh.size === 0), "closed: no preview colour left");
});

step("the code pane is closed at first; Ctrl+J opens it", async () => {
  check(await page.evaluate(() => document.body.classList.contains("code-hidden")), "closed by default");
  await page.mouse.click(...(await canvasAt(0.95, 0.95)));
  await page.keyboard.down("Control"); await page.keyboard.press("j"); await page.keyboard.up("Control");
  check(await page.evaluate(() => !document.body.classList.contains("code-hidden") && getComputedStyle(document.getElementById("code")).display !== "none"), "Ctrl+J shows it");
  await app.shot("layout-1.png");
});

step("no native popups anywhere", () => {
  check(app.nativeDialogs.length === 0, "no alert, confirm or prompt", app.nativeDialogs);
});
