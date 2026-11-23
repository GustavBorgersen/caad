// Spike 2 (JS): solve a small sketch with PlaneGCS compiled to WebAssembly.
import { init_planegcs_module, GcsWrapper } from "@salusoft89/planegcs";
const mod = await init_planegcs_module();
const gcs = new GcsWrapper(new mod.GcsSystem());
const P = [
  { id: "p1", type: "point", x: 0, y: 0, fixed: true },
  { id: "p2", type: "point", x: 55, y: 3, fixed: false },
  { id: "p3", type: "point", x: 52, y: 38, fixed: false },
  { id: "p4", type: "point", x: -2, y: 41, fixed: false },
  { id: "l1", type: "line", p1_id: "p1", p2_id: "p2" },
  { id: "l2", type: "line", p1_id: "p2", p2_id: "p3" },
  { id: "l3", type: "line", p1_id: "p3", p2_id: "p4" },
  { id: "l4", type: "line", p1_id: "p4", p2_id: "p1" },
  { id: "h1", type: "horizontal_l", l_id: "l1" },
  { id: "h3", type: "horizontal_l", l_id: "l3" },
  { id: "v2", type: "vertical_l", l_id: "l2" },
  { id: "v4", type: "vertical_l", l_id: "l4" },
  { id: "w", type: "p2p_distance", p1_id: "p1", p2_id: "p2", distance: 60 },
  { id: "h", type: "p2p_distance", p1_id: "p2", p2_id: "p3", distance: 40 },
  { id: "c", type: "point", x: 20, y: 22, fixed: false },
  { id: "circ", type: "circle", c_id: "c", radius: 7 },
  { id: "r", type: "circle_radius", c_id: "circ", radius: 5 },
  { id: "d1", type: "p2p_distance", p1_id: "p1", p2_id: "c", distance: 25 },
  { id: "d2", type: "p2p_distance", p1_id: "p2", p2_id: "c", distance: 45 },
];
const t0 = performance.now();
gcs.push_primitives_and_params(P);
const status = gcs.solve();
gcs.apply_solution();
const ms = (performance.now() - t0).toFixed(2);
const out = Object.fromEntries(gcs.sketch_index.get_primitives()
  .filter(p => p.type === "point" || p.type === "circle")
  .map(p => [p.id, p.type === "point" ? [+p.x.toFixed(6), +p.y.toFixed(6)] : +p.radius.toFixed(6)]));
console.log(JSON.stringify({ status, ms: +ms, ...out }));
