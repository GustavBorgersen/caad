// Spike 5: lean build123d in a (module) Web Worker. Posts timing lines back to the page.
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.8/full/pyodide.mjs";
const t0 = performance.now();
const log = (step, extra = "") => postMessage(`${((performance.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${step} ${extra}`);
log("worker started, loading Pyodide…");
const OCP = "cadquery-ocp-novtk-OCP.wasm==8.0.1.1.post202609241841";
const LIB3MF = "lib3mf-OCP.wasm==2.5.0.post202609241713";
const STUBS = { "threejs-materials": "1.2.5", "sympy": "1.14.0", "scikit-learn": "1.8.0", "ipython": "9.12.0", "ezdxf": "1.4.5", "scipy": "1.18.0" };
const STUB_MODULES = ["threejs_materials", "sympy", "sklearn", "IPython", "ezdxf", "scipy"];
(async () => {
  try {
    const py = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v314.0.8/full/" });
    await py.loadPackage(["micropip", "numpy"]);
    log("Pyodide + numpy loaded");
    await py.runPythonAsync(`
import micropip, importlib.metadata as md
await micropip.install(["${OCP}", "${LIB3MF}"])
mocks = [("cadquery-ocp", md.version("cadquery-ocp-novtk-OCP.wasm")), ("cadquery-ocp-novtk", md.version("cadquery-ocp-novtk-OCP.wasm")),
         ("cadquery_ocp_proxy", md.version("cadquery-ocp-novtk-OCP.wasm")), ("lib3mf", md.version("lib3mf-OCP.wasm")),
         ("py-lib3mf", md.version("lib3mf-OCP.wasm"))] + list(${JSON.stringify(STUBS)}.items())
for name, version in mocks: micropip.add_mock_package(name, version)
await micropip.install("build123d==0.13.0")
for name, _ in mocks: micropip.remove_mock_package(name)
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
`);
    log("build123d + OCP.wasm installed");
    await py.runPythonAsync("import build123d");
    log("import build123d done");
    const model = `
from build123d import *
with BuildPart() as body:
    Cylinder(50, 35, align=(Align.CENTER, Align.CENTER, Align.MIN))
    Cylinder(35, 35, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    with Locations((0, 0, 18)):
        Cylinder(39.5, 17, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    with PolarLocations(45, 4):
        Cylinder(2.25, 35, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
verts, tris = body.part.tessellate(0.05, 0.2)
f"faces={len(body.part.faces())}, {len(tris)} triangles"
`;
    log("first model built:", await py.runPythonAsync(model));
    const t = performance.now();
    await py.runPythonAsync(model);
    log("rebuild (warm):", `${((performance.now() - t) / 1000).toFixed(2)} s`);
    postMessage("DONE");
  } catch (e) {
    postMessage("ERROR: " + String(e.message || e).split("\n").slice(-6).join(" | "));
  }
})();
