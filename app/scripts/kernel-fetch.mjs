// Puts the kernel's Python runtime into public/kernel/ so the page loads it from its own origin, not from
// cdn.jsdelivr.net and PyPI: networks that filter or rewrite third-party downloads (proxies at work) broke
// the start. Pyodide's core comes from the `pyodide` npm package; the wheels listed in kernel-lock.json are
// downloaded and checked against their sha256. Files already there with the right hash are kept.
//
// Run by the Vite plugin in vite.config.ts (dev server and build), or on its own: node scripts/kernel-fetch.mjs
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(APP, "public", "kernel");
const CORE = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function fetchKernel({ log = console.log } = {}) {
  const lock = JSON.parse(readFileSync(join(APP, "kernel-lock.json"), "utf8"));

  // Pyodide's core, from node_modules: its version must be the lock's.
  const pkgDir = dirname(createRequire(join(APP, "package.json")).resolve("pyodide/package.json"));
  const pkgVersion = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
  if (pkgVersion !== lock.pyodide) throw new Error(`npm package pyodide is ${pkgVersion}, kernel-lock.json wants ${lock.pyodide}`);
  const coreDir = join(OUT, `pyodide-${lock.pyodide}`);
  mkdirSync(coreDir, { recursive: true });
  for (const f of CORE) {
    const src = readFileSync(join(pkgDir, f));
    const dst = join(coreDir, f);
    if (!existsSync(dst) || sha256(readFileSync(dst)) !== sha256(src)) copyFileSync(join(pkgDir, f), dst);
  }

  // The wheels.
  const wheelDir = join(OUT, "wheels");
  mkdirSync(wheelDir, { recursive: true });
  const missing = lock.wheels.filter((w) => {
    const p = join(wheelDir, w.file);
    return !existsSync(p) || sha256(readFileSync(p)) !== w.sha256;
  });
  if (missing.length) log(`kernel: downloading ${missing.length} wheels (${(missing.reduce((s, w) => s + w.size, 0) / 1e6).toFixed(1)} MB)…`);
  await Promise.all(missing.map(async (w) => {
    const res = await fetch(w.url);
    if (!res.ok) throw new Error(`kernel: ${w.url}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (sha256(bytes) !== w.sha256) throw new Error(`kernel: ${w.file}: sha256 doesn't match kernel-lock.json`);
    writeFileSync(join(wheelDir, w.file), bytes);
  }));

  // Drop what the lock no longer lists (older Pyodide versions and wheels).
  const keep = new Set(lock.wheels.map((w) => w.file));
  for (const f of readdirSync(wheelDir)) if (!keep.has(f)) rmSync(join(wheelDir, f));
  for (const d of readdirSync(OUT)) if (d.startsWith("pyodide-") && d !== `pyodide-${lock.pyodide}`) rmSync(join(OUT, d), { recursive: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await fetchKernel();
