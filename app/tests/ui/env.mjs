// The app in headless Chromium for the UI tests: its own Vite dev server on a free port, its own browser and page.
// Each test file opens one, so files run in parallel without sharing anything.
//
//   CHROME   the browser (default /usr/bin/chromium)
//   SHOTS    a folder for screenshots (none when unset); a failing step saves <suite>-error.png there
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { createServer as listen } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { createServer } from "vite";

const APP = fileURLToPath(new URL("../../", import.meta.url));
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const BRIDGE_PORTS = [7337, 7346]; // where the page looks for caad-mcp bridges (src/agent.ts)

const freePort = () => new Promise((resolve, reject) => {
  const s = listen().once("error", reject).listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/**
 * Start the dev server and the browser, open the app and wait for its first build.
 * The page connects to no caad-mcp bridge (a developer's own, or another test's) except `bridgePort`.
 */
export async function openApp(name, { bridgePort = 0, viewport = { width: 1400, height: 850 }, wait = true } = {}) {
  const server = await createServer({
    root: APP,
    configFile: join(APP, "vite.config.ts"),
    cacheDir: join(APP, "node_modules", ".vite-tests", name), // parallel servers optimizing dependencies into one folder would race
    server: { host: "127.0.0.1", port: await freePort() },
    logLevel: "warn",
    clearScreen: false,
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME ?? "/usr/bin/chromium",
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--window-size=${viewport.width},${viewport.height}`, ...(process.env.CI ? ["--no-sandbox"] : [])],
    defaultViewport: viewport,
  });
  const page = await browser.newPage();
  const app = {
    name, page, browser, server, url,
    /** What the next prompt() is answered with; confirm() and alert() are accepted. */
    answer: "",
    /** The last dialog's message. */
    lastDialog: "",
    async shot(file) { if (SHOTS) await page.screenshot({ path: join(SHOTS, file) }).catch(() => {}); },
    async close() { await browser.close().catch(() => {}); await server.close(); },
    /**
     * Wait for the first build (it boots the kernel: tens of seconds) and the app to settle: the open part's build
     * is sent before the kernel is ready, and the kernel's ready message sends another, so wait for both.
     */
    built: () => page.waitForFunction(() => /^(Built|Failed)/.test(document.getElementById("status").textContent) && !window.caad.kernel.buildInflight, { timeout: 300_000 }),
  };
  page.on("pageerror", (e) => console.log(`[${name}] page exception: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("WebSocket") && console.log(`[${name}] console error: ${m.text()}`));
  page.on("dialog", (d) => { app.lastDialog = d.message(); d.accept(app.answer); });
  // A bridge talks to the newest page that connected: keep this page off the others' bridges.
  await page.evaluateOnNewDocument(([first, last, allowed]) => {
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(target, protocols) {
        const port = Number(/^wss?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(String(target))?.[1]);
        super(port >= first && port <= last && port !== allowed ? "ws://127.0.0.1:1" : target, protocols); // fails like a free port
      }
    };
  }, [...BRIDGE_PORTS, bridgePort]);
  await page.goto(url);
  if (wait) await app.built();
  return app;
}

/**
 * A test per step of a flow that carries on from the step before: after a failure the rest are skipped
 * (instead of each waiting out its timeouts), and the page is saved as <suite>-error.png.
 */
export function steps(app) {
  let failed = null;
  return (name, fn) => test(name, async (t) => {
    if (failed) return t.skip(`after "${failed}" failed`);
    try { await fn(t); }
    catch (e) { failed = name; await app.shot(`${app.name}-error.png`); throw e; }
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
