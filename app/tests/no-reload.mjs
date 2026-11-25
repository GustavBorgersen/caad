// Editing a file in ../examples must not reload the page in the dev server (it would restart the kernel).
import { spawn } from "node:child_process";
import { utimesSync } from "node:fs";
import puppeteer from "puppeteer-core";

const PORT = 5198;
const server = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium" });
const page = await browser.newPage();
for (let i = 0; i < 30; i++) { try { await page.goto(`http://127.0.0.1:${PORT}/`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
await new Promise((r) => setTimeout(r, 2000));
await page.evaluate(() => { window.marker = "still here"; });
const now = new Date();
utimesSync("../examples/caad-examples/parts/bracket.py", now, now);
await new Promise((r) => setTimeout(r, 3000));
const marker = await page.evaluate(() => window.marker).catch(() => undefined);
console.log(marker === "still here" ? "PASS: no reload" : "FAIL: page reloaded");
await browser.close(); server.kill();
process.exit(marker === "still here" ? 0 : 1);
