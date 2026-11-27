// Selection info and selector suggestions (caad_kernel.py's select and resolve): what the user picked in
// the view becomes a selector expression that finds the same faces or edges again.
import { describe, test } from "node:test";
import { call, check, example, js, py } from "./env.mjs";

const S = `_current["shape"]`;
/** Build `file`, pick with Python (`[kind, indices]`), and return select()'s answer for the pick. */
const pick = (file, code) => {
  call("run", example(file), file);
  const [kind, idx] = js(py.runPython(code));
  return { kind, idx, ...call("select", kind, idx) };
};
const resolves = (s) => JSON.stringify(call("resolve", s.kind, s.selectors[0].expr)) === JSON.stringify(s.idx);

describe("select", () => {
  test("the highest face", () => {
    const s = pick("bracket.py", `fs=${S}.faces(); ["face", [max(range(len(fs)), key=lambda i: fs[i].center().Z)]]`);
    check(s.items.length === 1 && s.items[0].type === "PLANE" && s.items[0].area === 480 && JSON.stringify(s.items[0].normal) === "[0,0,1]", "its info", s.items);
    check(s.selectors[0].expr === "bracket.faces().sort_by(Axis.Z)[-1]" && !s.selectors[0].fragile, s.selectors[0].expr);
    check(resolves(s), "the selector finds it again");
  });

  test("two front vertical edges: a group", () => {
    const s = pick("bracket.py", `es=${S}.edges(); ["edge", [i for i,e in enumerate(es) if e.geom_type.name=="LINE" and abs(e.tangent_at(0).Z)>0.99 and e.center().Y < -19]]`);
    check(s.idx.length === 2 && s.items.every((it) => it.type === "LINE" && it.length === 8), "two 8 mm lines", s.items);
    check(s.selectors[0].expr === "bracket.edges().filter_by(Axis.Z).group_by(Axis.Y)[0]", s.selectors[0].expr);
    check(resolves(s), "the selector finds both again");
  });

  test("the hole walls: cylinders with radius and axis", () => {
    const s = pick("bracket.py", `fs=${S}.faces(); ["face", [i for i,f in enumerate(fs) if f.geom_type.name=="CYLINDER" and f.area < 300]]`);
    check(s.idx.length === 3 && s.items.every((it) => it.type === "CYLINDER" && it.radius === 5 && it.axis), "three cylinders, radius 5", s.items);
    check(s.selectors[0].expr === "bracket.faces().filter_by(GeomType.CYLINDER)" && resolves(s), s.selectors[0].expr);
  });

  test("a bolt-hole circle on the pump body: only fragile selectors", () => {
    const s = pick("pump_body.py", `es=${S}.edges(); c=[i for i,e in enumerate(es) if e.geom_type.name=="CIRCLE" and abs(e.radius-2.25)<0.01 and e.center().Z>34]; ["edge", c[:1]]`);
    check(s.items[0].type === "CIRCLE" && s.items[0].radius === 2.25, "a circle, radius 2.25", s.items);
    check(s.selectors.length > 0 && s.selectors.every((x) => x.fragile) && resolves(s), "fragile, but it resolves", s.selectors);
  });

  test("all four bolt holes", () => {
    const s = pick("pump_body.py", `fs=${S}.faces(); ["face", [i for i,f in enumerate(fs) if f.geom_type.name=="CYLINDER" and f.area < 600]]`);
    check(s.idx.length === 4 && s.selectors[0].expr === "pump_body.faces().filter_by(GeomType.CYLINDER).group_by(SortBy.AREA)[0]" && resolves(s), s.selectors[0]?.expr);
  });
});
