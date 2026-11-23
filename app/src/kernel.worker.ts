/// <reference lib="webworker" />
// The CAD kernel: Pyodide + a lean build123d + caad_kernel.py, in a Web Worker so the UI stays responsive.
// Lean = build123d without the packages modelling doesn't need (see docs/02-spike-results.md, spike 1b).

export {}; // a module, so names don't clash with DOM globals

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v314.0.8/full/";
const OCP = "cadquery-ocp-novtk-OCP.wasm==8.0.1.1.post202609241841";
const LIB3MF = "lib3mf-OCP.wasm==2.5.0.post202609241713";
const BUILD123D = "build123d==0.13.0";
// Installed as placeholders: they import fine and only fail if that specific feature is used.
const STUBS: Record<string, string> = {
  "threejs-materials": "1.2.5", sympy: "1.14.0", "scikit-learn": "1.8.0", ipython: "9.12.0", ezdxf: "1.4.5", scipy: "1.18.0",
};
const STUB_MODULES = ["threejs_materials", "sympy", "sklearn", "IPython", "ezdxf", "scipy"];

const INSTALL = `
import micropip, importlib.metadata as md
await micropip.install(["${OCP}", "${LIB3MF}"])
ocp, l3 = md.version("cadquery-ocp-novtk-OCP.wasm"), md.version("lib3mf-OCP.wasm")
mocks = [("cadquery-ocp", ocp), ("cadquery-ocp-novtk", ocp), ("cadquery_ocp_proxy", ocp),
         ("lib3mf", l3), ("py-lib3mf", l3)] + list(${JSON.stringify(STUBS)}.items())
for name, version in mocks:
    micropip.add_mock_package(name, version)
await micropip.install("${BUILD123D}")
for name, _ in mocks:
    micropip.remove_mock_package(name)

import sys, importlib.abc, importlib.machinery
from unittest.mock import MagicMock
class _Stub(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    roots = set(${JSON.stringify(STUB_MODULES)})
    def find_spec(self, name, path=None, target=None):
        return importlib.machinery.ModuleSpec(name, self, is_package=True) if name.split(".")[0] in self.roots else None
    def create_module(self, spec):
        m = MagicMock(name=spec.name); m.__path__ = []; m.__spec__ = spec; return m
    def exec_module(self, module): pass
sys.meta_path.insert(0, _Stub())
`;

type RunRequest =
  | { id: number; type: "run"; src: string; filename: string; upto: number | null }
  | { id: number; type: "call"; fn: "select" | "resolve"; args: unknown[] };

const t0 = performance.now();
const seconds = () => ((performance.now() - t0) / 1000).toFixed(1);
const setStatus = (text: string) => postMessage({ type: "status", text });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let py: any;
let run: ((src: string, filename: string, upto?: number) => any) | null = null;
const queue: RunRequest[] = [];

async function boot() {
  setStatus("Loading Python…");
  const { loadPyodide } = await import(/* @vite-ignore */ PYODIDE + "pyodide.mjs");
  py = await loadPyodide({ indexURL: PYODIDE });
  py.setStdout({ batched: (s: string) => postMessage({ type: "log", text: s }) });
  py.setStderr({ batched: (s: string) => postMessage({ type: "log", text: s }) });
  await py.loadPackage(["micropip", "numpy"]);
  setStatus(`Installing build123d… (${seconds()} s)`);
  await py.runPythonAsync(INSTALL);
  setStatus(`Starting OpenCascade… (${seconds()} s)`);
  py.runPython(await (await fetch(new URL("/caad_kernel.py", self.location.origin))).text());
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
  postMessage({ type: "result", id: req.id, gen, result }, transfer);
}

function drain() {
  while (run && queue.length) {
    const req = queue.shift()!;
    try { handle(req); }
    catch (e) { postMessage({ type: "result", id: req.id, error: String((e as Error).message ?? e) }); }
  }
}

self.onmessage = (e: MessageEvent<RunRequest>) => { queue.push(e.data); drain(); };
boot().catch((e) => postMessage({ type: "failed", text: String(e?.message ?? e).split("\n").slice(-4).join(" ") }));
