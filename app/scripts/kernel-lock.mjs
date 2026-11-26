// Resolves the kernel's Python packages into kernel-lock.json: the lean build123d (docs/02, spike 1b) as a
// list of wheels with their URLs and sha256. Run it after changing a version below; the page and the build
// only read the lock (scripts/kernel-fetch.mjs downloads what it lists into public/kernel/).
//
//   node scripts/kernel-lock.mjs
import { loadPyodide, version as PYODIDE_VERSION } from "pyodide";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const OCP = "cadquery-ocp-novtk-OCP.wasm==8.0.1.1.post202609241841";
const LIB3MF = "lib3mf-OCP.wasm==2.5.0.post202609241713";
const BUILD123D = "build123d==0.13.0";
// Not installed: build123d imports them, the page gives it placeholders (STUB_MODULES in kernel.worker.ts).
const STUBS = {
  "threejs-materials": "1.2.5", sympy: "1.14.0", "scikit-learn": "1.8.0", ipython: "9.12.0", ezdxf: "1.4.5", scipy: "1.18.0",
};
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

const py = await loadPyodide();
await py.loadPackage("micropip");
const lock = JSON.parse(await py.runPythonAsync(`
import micropip, importlib.metadata as md, json, re
await micropip.install(["${OCP}", "${LIB3MF}"])
ocp, l3 = md.version("cadquery-ocp-novtk-OCP.wasm"), md.version("lib3mf-OCP.wasm")
mocks = [("cadquery-ocp", ocp), ("cadquery-ocp-novtk", ocp), ("cadquery_ocp_proxy", ocp),
         ("lib3mf", l3), ("py-lib3mf", l3)] + list(${JSON.stringify(STUBS)}.items())
for name, version in mocks:
    micropip.add_mock_package(name, version)
await micropip.install("${BUILD123D}")
norm = lambda n: re.sub(r"[-_.]+", "-", n).lower()
skip = {norm(n) for n, _ in mocks} | {"micropip"}
installed = {norm(d.metadata["Name"]) for d in md.distributions()} - skip
lock = json.loads(micropip.freeze())
json.dumps([p for k, p in lock["packages"].items() if norm(k) in installed or norm(p.get("name", "")) in installed])
`));

// file_name is a URL for PyPI wheels and a local cached path for Pyodide's own packages (numpy…).
const wheels = [];
for (const p of lock) {
  const file = p.file_name.split("/").pop();
  const url = p.file_name.startsWith("http") ? p.file_name : CDN + file;
  const bytes = p.file_name.startsWith("http") ? Buffer.from(await (await fetch(url)).arrayBuffer()) : readFileSync(p.file_name);
  wheels.push({ name: p.name, version: p.version, file, url, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
}
wheels.sort((a, b) => a.name.localeCompare(b.name));
const out = { pyodide: PYODIDE_VERSION, requires: [OCP, LIB3MF, BUILD123D], stubs: STUBS, wheels };
writeFileSync(new URL("../kernel-lock.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`${wheels.length} wheels, ${(wheels.reduce((s, w) => s + w.size, 0) / 1e6).toFixed(1)} MB:`, wheels.map((w) => w.name).join(" "));
