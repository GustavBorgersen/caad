// Spike 6b: Pyodide memory snapshot after `import build123d`, with a clean install path.
// 1st run: resolve the lean wheel list with micropip (separate instance) and download the wheels.
// 2nd run: fresh Pyodide, unpack wheels straight into site-packages (no micropip), import, snapshot.
// 3rd run: start from the snapshot and build a model.
import { loadPyodide } from "pyodide";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
const t = () => performance.now();
const ms = (a, b) => `${((b - a) / 1000).toFixed(1)} s`;
const fail = (e) => { console.log("ERROR: " + String(e?.message ?? e).split("\n").slice(-8).join("\n").slice(0, 2000)); process.exit(1); };
const SNAP = "build123d.snapshot", LIST = "wheels/list.json";
const STUBS = { "threejs-materials": "1.2.5", "sympy": "1.14.0", "scikit-learn": "1.8.0", "ipython": "9.12.0", "ezdxf": "1.4.5", "scipy": "1.18.0" };
const STUB_FINDER = `
import sys, importlib.abc, importlib.machinery
from unittest.mock import MagicMock
class _Stub(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    roots = {"threejs_materials", "sympy", "sklearn", "IPython", "ezdxf", "scipy"}
    def find_spec(self, name, path=None, target=None):
        return importlib.machinery.ModuleSpec(name, self, is_package=True) if name.split(".")[0] in self.roots else None
    def create_module(self, spec):
        m = MagicMock(name=spec.name); m.__path__ = []; m.__spec__ = spec; return m
    def exec_module(self, module): pass
sys.meta_path.insert(0, _Stub())
`;
const MODEL = `
from build123d import *
with BuildPart() as p:
    Cylinder(50, 35)
    Cylinder(35, 35, mode=Mode.SUBTRACT)
    with PolarLocations(45, 4):
        Cylinder(2.25, 35, mode=Mode.SUBTRACT)
    fillet(p.edges().filter_by(GeomType.CIRCLE).sort_by(SortBy.RADIUS)[-1:], radius=1)
f"faces={len(p.part.faces())} volume={p.part.volume:.0f}"
`;
try {
  if (!existsSync(LIST)) {
    const py = await loadPyodide();
    await py.loadPackage("micropip");
    const lock = JSON.parse(await py.runPythonAsync(`
import micropip, importlib.metadata as md
await micropip.install(["cadquery-ocp-novtk-OCP.wasm==8.0.1.1.post202609241841", "lib3mf-OCP.wasm==2.5.0.post202609241713"])
v, l = md.version("cadquery-ocp-novtk-OCP.wasm"), md.version("lib3mf-OCP.wasm")
for n, ver in [("cadquery-ocp", v), ("cadquery-ocp-novtk", v), ("cadquery_ocp_proxy", v), ("lib3mf", l), ("py-lib3mf", l), *${JSON.stringify(STUBS)}.items()]:
    micropip.add_mock_package(n, ver)
await micropip.install("build123d==0.13.0")
import json, re
norm = lambda n: re.sub(r"[-_.]+", "-", n).lower()
mocks = {norm(n) for n in ["cadquery-ocp", "cadquery-ocp-novtk", "cadquery_ocp_proxy", "lib3mf", "py-lib3mf", "micropip", *${JSON.stringify(STUBS)}]}
installed = {norm(d.metadata["Name"]) for d in md.distributions()} - mocks
lock = json.loads(micropip.freeze())
lock["packages"] = {k: p for k, p in lock["packages"].items() if norm(k) in installed or norm(p.get("name", "")) in installed}
json.dumps(lock)
`));
    // file_name is a URL for PyPI wheels, a local cached path for Pyodide's own packages.
    const urls = Object.values(lock.packages).map((p) => p.file_name);
    mkdirSync("wheels", { recursive: true });
    for (const u of urls) writeFileSync("wheels/" + u.split("/").pop(),
      u.startsWith("http") ? Buffer.from(await (await fetch(u)).arrayBuffer()) : readFileSync(u));
    writeFileSync(LIST, JSON.stringify(urls.map((u) => u.split("/").pop()), null, 1));
    console.log(`downloaded ${urls.length} wheels:`, urls.map((u) => u.split("/").pop().split("-")[0]).join(" "));
  } else if (!existsSync(SNAP)) {
    const t0 = t();
    const py = await loadPyodide({ _makeSnapshot: true });
    const site = py.runPython("import site; site.getsitepackages()[0]");
    for (const w of JSON.parse(readFileSync(LIST))) py.unpackArchive(new Uint8Array(readFileSync("wheels/" + w)), "zip", { extractDir: site });
    py.runPython(STUB_FINDER);
    py.runPython("import build123d");
    const t1 = t();
    console.log(`fresh start without snapshot (unpack + import): ${ms(t0, t1)}`);
    writeFileSync(SNAP, py.makeMemorySnapshot());
    console.log(`snapshot written: ${(statSync(SNAP).size / 1e6).toFixed(0)} MB in ${ms(t1, t())}`);
  } else {
    const t0 = t();
    const py = await loadPyodide({ _loadSnapshot: readFileSync(SNAP) });
    const t1 = t();
    console.log(`started from snapshot: ${ms(t0, t1)}`);
    py.runPython("import build123d");
    console.log(`import build123d after snapshot: ${ms(t1, t())}`);
    const t2 = t();
    console.log(`model: ${py.runPython(MODEL)} in ${ms(t2, t())}`);
    console.log(`TOTAL to first model: ${ms(t0, t())}`);
  }
} catch (e) { fail(e); }
