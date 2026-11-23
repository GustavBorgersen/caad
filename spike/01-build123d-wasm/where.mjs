// Spike 6a: where does `import build123d` go? Times the OpenCascade bindings (import OCP) separately
// from build123d on top. Same lean install as lean-noscipy.mjs.
import { loadPyodide } from "pyodide";

const t = () => performance.now();
process.on("unhandledRejection", (e) => { console.log("ERROR: " + String(e?.message ?? e).split("\n").slice(-10).join("\n").slice(0, 2000)); process.exit(1); });
const ms = (a, b) => `${((b - a) / 1000).toFixed(1)} s`;
const OCP = "cadquery-ocp-novtk-OCP.wasm==8.0.1.1.post202609241841";
const LIB3MF = "lib3mf-OCP.wasm==2.5.0.post202609241713";
const STUBS = { "threejs-materials": "1.2.5", "sympy": "1.14.0", "scikit-learn": "1.8.0", "ipython": "9.12.0", "ezdxf": "1.4.5", "scipy": "1.18.0" };
const STUB_MODULES = ["threejs_materials", "sympy", "sklearn", "IPython", "ezdxf", "scipy"];

const t0 = t();
const py = await loadPyodide();
const run = async (code) => {
  try { return await py.runPythonAsync(code); }
  catch (e) { console.log("ERROR: " + String(e.message).split("\n").slice(-10).join("\n").slice(0, 2500)); process.exit(1); }
};
await py.loadPackage(["micropip", "numpy"]);
const t1 = t();
console.log(`Pyodide + numpy: ${ms(t0, t1)}`);

await run(`
import micropip, importlib.metadata as md
await micropip.install(["${OCP}", "${LIB3MF}"])
for name, dist in (("cadquery-ocp", "cadquery-ocp-novtk-OCP.wasm"), ("cadquery-ocp-novtk", "cadquery-ocp-novtk-OCP.wasm"),
                   ("cadquery_ocp_proxy", "cadquery-ocp-novtk-OCP.wasm"), ("lib3mf", "lib3mf-OCP.wasm"), ("py-lib3mf", "lib3mf-OCP.wasm")):
    micropip.add_mock_package(name, md.version(dist))
for name, version in ${JSON.stringify(STUBS)}.items():
    micropip.add_mock_package(name, version)
await micropip.install("build123d==0.13.0")
# Remove the dependency-resolution placeholders again, so the real OCP/lib3mf modules import.
for name in ("cadquery-ocp", "cadquery-ocp-novtk", "cadquery_ocp_proxy", "lib3mf", "py-lib3mf", *${JSON.stringify(STUBS)}):
    try: micropip.remove_mock_package(name)
    except Exception: pass

# Placeholder modules: any import of these packages (and submodules) returns a stand-in object.
import sys, importlib.abc, importlib.machinery, types
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
const t2 = t();
console.log(`lean install (OCP.wasm + build123d without heavy deps): ${ms(t1, t2)}`);

// Where does the import time go? Time the OCP extension module alone, then build123d on top.
console.log("so path:", py.runPython("import importlib.util; importlib.util.find_spec('OCP').origin"));
const so = py.runPython("import importlib.util; importlib.util.find_spec('OCP').origin");
const readFile = py.FS.readFile;
py.FS.readFile = function (path, opts) {
  if (String(path).includes("OCP")) console.log(`  FS.readFile ${path} at ${ms(t0, t())}`);
  return readFile.call(this, path, opts);
};
let ta = t();
console.log("Python sees:", await run(`
import time, sys
t = time.perf_counter(); import OCP; a = time.perf_counter() - t
t = time.perf_counter(); import OCP.TopoDS, OCP.BRepAlgoAPI, OCP.gp; b = time.perf_counter() - t
f"import OCP {a:.1f}s, submodules {b:.2f}s, OCP modules in sys.modules: {sum(m.startswith('OCP') for m in sys.modules)}"
`));
console.log(`  JS sees import OCP: ${ms(ta, t())}`);
ta = t();
await run("import build123d");
console.log(`  import build123d on top: ${ms(ta, t())}`);
const t3 = t();
console.log(`import build123d: ${ms(t2, t3)}`);

const result = await run(`
from build123d import *
import time
t = time.perf_counter()
with BuildPart() as body:
    Cylinder(50, 35, align=(Align.CENTER, Align.CENTER, Align.MIN))
    Cylinder(35, 35, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    Cylinder(40, 6, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    with Locations((0, 0, 18)):
        Cylinder(39.5, 17, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    with Locations((-33.5, 25, 26.5), (33.5, 25, 26.5)):
        Box(13, 50, 17, mode=Mode.SUBTRACT)
    with PolarLocations(45, 4):
        Cylinder(2.25, 35, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    fillet(body.edges().filter_by(GeomType.CIRCLE).group_by(Axis.Z)[0].sort_by(SortBy.RADIUS)[-1:], radius=1)
with BuildSketch() as sk:
    Rectangle(60, 40)
    fillet(sk.vertices(), radius=5)
build = time.perf_counter() - t
verts, tris = body.part.tessellate(0.05, 0.2)
f"faces={len(body.part.faces())} volume={body.part.volume:.0f} sketch_area={sk.sketch.area:.1f} build={build:.2f}s triangles={len(tris)}"
`);
const t4 = t();
console.log(`pump body + sketch: ${result} (${ms(t3, t4)})`);
console.log(`TOTAL cold start to first model: ${ms(t0, t4)}`);

const sizes = JSON.parse(await run(`
import importlib.metadata as md, os, json
rows = []
for d in md.distributions():
    s = sum(os.path.getsize(d.locate_file(f)) for f in (d.files or []) if os.path.exists(d.locate_file(f)))
    rows.append((d.metadata["Name"], round(s / 1e6, 1)))
json.dumps(sorted(rows, key=lambda r: -r[1])[:8] + [("TOTAL", round(sum(r[1] for r in rows), 1))])
`));
console.log("installed (MB, uncompressed):", sizes.map(([n, s]) => `${n} ${s}`).join(", "));
