/// <reference lib="webworker" />
// The CAD kernel: Pyodide + a lean build123d + caad_kernel.py, in a Web Worker so the UI stays responsive.
// Lean = build123d without the packages modelling doesn't need (see docs/02-spike-results.md, spike 1b).

import gcsWasm from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import lock from "../kernel-lock.json";
import { loadSolver } from "./gcs-solve";
import { STUBS } from "./kernel-stubs";
import { siteUrl } from "./site";

export {}; // a module, so names don't clash with DOM globals

// Everything comes from the site itself (public/kernel/, filled by scripts/kernel-fetch.mjs from
// kernel-lock.json), not from a CDN or PyPI: networks that filter third-party downloads broke the start.
const KERNEL = siteUrl("kernel/");
const PYODIDE = `${KERNEL}pyodide-${lock.pyodide}/`;

/** Fetch from our origin, with an error that says what was blocked (a proxy's answer is often not a 404). */
async function download(url: string): Promise<Response> {
  let res: Response;
  try { res = await fetch(url); }
  catch (e) { throw new Error(`couldn't download ${url} (${(e as Error).message}) — is a network filter blocking it?`); }
  if (!res.ok) throw new Error(`couldn't download ${url}: HTTP ${res.status} — is a network filter blocking it?`);
  return res;
}

type RunRequest =
  | { id: number; type: "run"; src: string; filename: string; upto: number | null }
  | { id: number; type: "call"; fn: "select" | "resolve" | "snippet" | "api_help" | "highlight_indices" | "sketch_plane"
    | "read_feature" | "patch_feature" | "feature_values" | "insert_feature" | "delete_feature" | "sketch_open" | "sketch_action" | "sketch_convert" | "sketch_regions" | "set_project" | "export_part" | "patch_param"; args: unknown[] };

const t0 = performance.now();
const seconds = () => ((performance.now() - t0) / 1000).toFixed(1);
const setStatus = (text: string) => postMessage({ type: "status", text });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let py: any;
let run: ((src: string, filename: string, upto?: number) => any) | null = null;
const queue: RunRequest[] = [];

async function boot() {
  setStatus("Loading Python…");
  // Pyodide hangs or says only "exit(1)" when one of its files is blocked: check them first (status only),
  // and download the standard library here.
  await Promise.all(["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "pyodide-lock.json"]
    .map(async (f) => (await download(PYODIDE + f)).body?.cancel()));
  const stdlib = URL.createObjectURL(await (await download(PYODIDE + "python_stdlib.zip")).blob());
  const { loadPyodide } = await import(/* @vite-ignore */ PYODIDE + "pyodide.mjs");
  py = await loadPyodide({ indexURL: PYODIDE, stdLibURL: stdlib });
  URL.revokeObjectURL(stdlib);
  // Constrained sketches (caad.py) solve with PlaneGCS: the WebAssembly one, called from Python.
  py.registerJsModule("caad_gcs", await loadSolver(gcsWasm));
  py.setStdout({ batched: (s: string) => postMessage({ type: "log", text: s }) });
  py.setStderr({ batched: (s: string) => postMessage({ type: "log", text: s }) });
  setStatus(`Installing build123d… (${seconds()} s)`);
  // The wheels are unpacked straight into site-packages: no micropip, no dependency resolution at start.
  const site: string = py.runPython("import site; site.getsitepackages()[0]");
  const wheels = await Promise.all(lock.wheels.map(async (w) => new Uint8Array(await (await download(KERNEL + "wheels/" + w.file)).arrayBuffer())));
  for (const bytes of wheels) py.unpackArchive(bytes, "zip", { extractDir: site });
  py.runPython(STUBS);
  py.FS.writeFile(`${site}/caad.py`, await (await download(siteUrl("caad.py"))).text());
  setStatus(`Starting OpenCascade… (${seconds()} s)`);
  py.runPython(await (await download(siteUrl("caad_kernel.py"))).text());
  run = py.globals.get("run");
  postMessage({ type: "ready", seconds: Number(seconds()) });
  drain();
}

let gen = 0; // number of builds done: lets the page ignore answers about an older model

function handle(req: RunRequest) {
  if (req.type === "call") {
    const r = py.globals.get(req.fn)(...req.args.map((a) => py.toPy(a)));
    const result = r?.toJs ? r.toJs({ dict_converter: Object.fromEntries }) : r;
    r?.destroy?.();
    postMessage({ type: "result", id: req.id, gen, result });
    return;
  }
  const r = run!(req.src, req.filename, req.upto ?? undefined); // undefined becomes None (null would be JsNull)
  gen++;
  const result = r.toJs({ dict_converter: Object.fromEntries });
  r.destroy();
  const transfer: Transferable[] = [];
  const m = result.mesh;
  if (m) {
    m.positions = new Float32Array(m.positions);
    m.indices = new Uint32Array(m.indices);
    transfer.push(m.positions.buffer, m.indices.buffer);
    for (const e of m.edges) { e.points = new Float32Array(e.points); transfer.push(e.points.buffer); }
  }
  for (const s of result.sketches ?? []) for (const e of s.edges) { e.points = new Float32Array(e.points); transfer.push(e.points.buffer); }
  postMessage({ type: "result", id: req.id, gen, result }, transfer);
}

/** The last line of a Python traceback; our own ValueErrors are messages for the user, without the type. */
function pythonError(e: unknown): string {
  const lines = String((e as Error).message ?? e).trim().split("\n");
  return lines[lines.length - 1].replace(/^ValueError: /, "");
}

function drain() {
  while (run && queue.length) {
    const req = queue.shift()!;
    try { handle(req); }
    catch (e) { postMessage({ type: "result", id: req.id, error: pythonError(e) }); }
  }
}

self.onmessage = (e: MessageEvent<RunRequest>) => { queue.push(e.data); drain(); };
boot().catch((e) => postMessage({ type: "failed", text: String(e?.message ?? e).split("\n").slice(-4).join(" ") }));
