// Spike 1c: what does build123d pull in, how big is it, and where does import time go?
import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";
const py = await loadPyodide();
await py.loadPackage("micropip");
py.runPython(readFileSync("bootstrap.py", "utf8"));
await py.runPythonAsync("await bootstrap()");
const report = await py.runPythonAsync(`
import importlib.metadata as md, os, time, json, sys
rows = []
for d in md.distributions():
    size = 0
    for f in (d.files or []):
        try: size += os.path.getsize(d.locate_file(f))
        except OSError: pass
    rows.append((d.metadata["Name"], d.version, size))
rows.sort(key=lambda r: -r[2])
times = {}
for mod in ["numpy", "scipy", "sympy", "OCP", "OCP.TopoDS", "OCP.BRepAlgoAPI", "ezdxf", "ocpsvg", "IPython", "build123d"]:
    t = time.perf_counter()
    try:
        __import__(mod); times[mod] = round(time.perf_counter() - t, 1)
    except Exception as e:
        times[mod] = "fail: " + type(e).__name__
loaded = sorted(m for m in sys.modules if m.split(".")[0] in ("scipy", "sympy", "IPython", "sklearn", "PIL"))
json.dumps({"dists": rows[:25], "total_mb": round(sum(r[2] for r in rows) / 1e6), "import_s": times,
            "heavy_loaded": sorted({m.split(".")[0] for m in loaded})})
`);
const r = JSON.parse(report);
console.log("Installed on disk (uncompressed), top 25:");
for (const [n, v, s] of r.dists) console.log(`  ${(s / 1e6).toFixed(1).padStart(7)} MB  ${n} ${v}`);
console.log(`  TOTAL ${r.total_mb} MB`);
console.log("Import times (each import pays only for what wasn't loaded yet):", r.import_s);
console.log("Heavy packages actually imported by build123d:", r.heavy_loaded);
