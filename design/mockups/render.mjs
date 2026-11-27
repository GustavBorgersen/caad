// Renders part.py with CAAD's real kernel into flat-shaded SVG for the style mock-ups: an isometric view and a
// top view (for the sketch editor), written to assets/views.js. Faces carry a group (the top face, the
// counterbored holes, the fillets) so each mock-up styles selection and preview its own way; shading is a
// lightness per triangle (--l), mixed into each style's colours by CSS.
//   node design/mockups/render.mjs        (from the repository root; boots the kernel like the Node tests)
import { readFileSync, writeFileSync } from "node:fs";

const { call, pyval } = await import("../../app/tests/kernel/env.mjs");
const here = new URL("./", import.meta.url);
const r = call("run", readFileSync(new URL("part.py", here), "utf8"), "part.py");
if (!r.ok) throw new Error(JSON.stringify(r.error));
const mesh = pyval(`
m = tessellate(_current["shape"], tol=0.15, angular=0.3)
groups = []
for f in _current["shape"].faces():
    t, c = f.geom_type.name, f.center()
    g = ""
    if t == "PLANE" and abs(c.Z - 14) < 1e-3 and abs(c.X) < 30 and f.normal_at().Z > 0.99: g = "top"
    elif t == "CYLINDER" and f.radius in (2.5, 5.0) and 27 < abs(c.X) < 41 and c.Z < 6.5: g = "hole"  # (a cylinder's centre isn't on its axis)
    elif t == "PLANE" and abs(c.Z - 4) < 1e-3 and abs(abs(c.X) - 34) < 1: g = "hole"  # the counterbore's floor
    elif t == "TORUS" or (t == "CYLINDER" and abs(f.radius - 4) < 1e-3 and abs(c.X) > 26): g = "fillet"
    groups.append(g)
m["groups"] = groups
# edges without cylinder seams (a seam has the same face on both sides), sampled finely
shp, edges = _current["shape"], []
for e in shp.edges():
    owners = [f for f in shp.faces() if any(e.is_same(x) for x in f.edges())]
    if len(owners) < 2: continue
    n = max(2, int(e.length / 0.6))
    edges.append({"points": [c for i in range(n + 1) for c in tuple(e @ (i / n))]})
m["edges"] = edges
m`);
const P = mesh.positions, I = mesh.indices;
const faceOf = new Int32Array(I.length / 3);
mesh.faces.forEach(([start, count], f) => faceOf.fill(f, start / 3, (start + count) / 3));

const v = (i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
const f1 = (n) => +n.toFixed(2);

/** One view: `toCamera` points from the part to the camera; `up` is the screen's up. */
function render(name, toCamera, up) {
  const fwd = norm(toCamera.map((x) => -x));
  const right = norm(cross(fwd, up));
  const upv = cross(right, fwd);
  const proj = (p) => [dot(p, right), -dot(p, upv), dot(p, fwd)];
  const light = norm([-0.45, -0.7, 1.0]);
  const items = [], tris = [];
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let t = 0; t < I.length / 3; t++) {
    const [a, b, c] = [v(I[3 * t]), v(I[3 * t + 1]), v(I[3 * t + 2])];
    const n = norm(cross(sub(b, a), sub(c, a)));
    if (dot(n, fwd) > 0.02) continue; // facing away
    const pa = proj(a), pb = proj(b), pc = proj(c);
    tris.push([pa, pb, pc]);
    for (const p of [pa, pb, pc]) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); }
    const lit = Math.min(1, Math.max(0, 0.18 + 0.62 * Math.max(0, dot(n, light)) + 0.2 * (0.5 + 0.5 * n[2])));
    const g = mesh.groups[faceOf[t]];
    items.push({ depth: (pa[2] + pb[2] + pc[2]) / 3,
      svg: `<path class="t"${g ? ` data-g="${g}"` : ""} style="--l:${lit.toFixed(2)}" d="M${f1(pa[0])} ${f1(pa[1])}L${f1(pb[0])} ${f1(pb[1])}L${f1(pc[0])} ${f1(pc[1])}Z"/>` });
  }
  // Edges: drawn after all faces, keeping the bits a depth buffer of the faces says are visible
  const W = 1400, sc = W / Math.max(maxx - minx, maxy - miny), Hh = Math.ceil((maxy - miny) * sc) + 2;
  const zb = new Float32Array((W + 2) * Hh).fill(Infinity);
  const px = (p) => [(p[0] - minx) * sc, (p[1] - miny) * sc, p[2]];
  for (const tri of tris) {
    const [a, b, c] = tri.map(px);
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W + 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(Hh - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const d = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(d) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const u = ((b[0] - x) * (c[1] - y) - (c[0] - x) * (b[1] - y)) / d, w = ((c[0] - x) * (a[1] - y) - (a[0] - x) * (c[1] - y)) / d, t = 1 - u - w;
      if (u < -0.01 || w < -0.01 || t < -0.01) continue;
      const z = u * a[2] + w * b[2] + t * c[2], k = y * (W + 2) + x;
      if (z < zb[k]) zb[k] = z;
    }
  }
  const visible = (p) => { // nearest depth in a small neighbourhood, so an edge on a face's border counts as on top
    const [x, y, z] = px(p); let best = Infinity;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = Math.round(x) + dx, yy = Math.round(y) + dy;
      if (xx >= 0 && xx <= W + 1 && yy >= 0 && yy < Hh) best = Math.min(best, zb[yy * (W + 2) + xx]);
    }
    return z <= best + 1.0;
  };
  const edges = [];
  for (const e of mesh.edges) {
    const pts = e.points;
    let run = [];
    const len = () => run.slice(1).reduce((l, q, j) => l + Math.hypot(q[0] - run[j][0], q[1] - run[j][1]), 0);
    const flush = () => { if (run.length > 1 && len() > 1.5) edges.push(`<path class="e" d="M${run.map((q) => `${f1(q[0])} ${f1(q[1])}`).join("L")}"/>`); run = []; };
    for (let k = 0; k + 5 < pts.length; k += 3) {
      const a = proj([pts[k], pts[k + 1], pts[k + 2]]), b = proj([pts[k + 3], pts[k + 4], pts[k + 5]]);
      const n = 4, vis = [...Array(n)].map((_, j) => { const f = (j + 0.5) / n; return visible([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])]); });
      if (vis.filter(Boolean).length >= n / 2) { if (!run.length) run.push(a); run.push(b); } else flush();
    }
    flush();
  }
  items.sort((x, y) => y.depth - x.depth); // far first
  const m = 0.08 * Math.max(maxx - minx, maxy - miny);
  const box = [minx - m, miny - m, maxx - minx + 2 * m, maxy - miny + 2 * m];
  console.error(`${name}: ${items.length} triangles, ${edges.length} edge runs`);
  return { viewBox: box.map(f1).join(" "), svg: items.map((i) => i.svg).join("") + edges.join("") };
}

const views = {
  iso: render("iso", [1, -1.3, 1.0], [0, 0, 1]),
  top: render("top", [0, 0, 1], [0, 1, 0]), // screen x = X, y = -Y: sketch overlays use millimetres
};
writeFileSync(new URL("assets/views.js", here),
  `// Generated by render.mjs from part.py: the mounting hub, flat-shaded (see render.mjs). Don't edit by hand.\nwindow.CAAD_VIEWS = ${JSON.stringify(views)};\n`);
console.error("wrote assets/views.js");
