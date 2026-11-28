// Building parts (caad_kernel.py's run): the timeline, rolling back, errors at their feature or line, meshes.
import { describe, test } from "node:test";
import { call, check, example } from "./env.mjs";

const bracket = example("bracket.py");
const pump = example("pump_body.py");
const statuses = (r) => r.timeline.features.map((f) => f.status).join();

describe("run", () => {
  test("the bracket: six features, all built, a mesh", () => {
    const r = call("run", bracket, "bracket.py");
    check(r.ok && r.upto === 5 && statuses(r) === "ok,ok,ok,ok,ok,ok", "builds", JSON.stringify(r.error));
    check(r.timeline.features.map((f) => f.kind).join() === "sketch,extrude,sketch,extrude,hole,fillet", "feature kinds");
    check(r.timeline.features[1].line === 13 && r.timeline.features[4].line === 21 && r.timeline.features[4].end === 22, "features know their lines");
    check(r.mesh.faces.length === 11 && r.mesh.edges.length === 27 && r.mesh.indices.length > 0, `a mesh with every face and edge (${r.mesh.faces.length} faces, ${r.mesh.edges.length} edges)`);
  });

  test("rolled back to feature 1: the later ones aren't built", () => {
    const r = call("run", bracket, "bracket.py", 1);
    check(r.ok && r.upto === 1 && statuses(r) === "ok,ok,rolled-back,rolled-back,rolled-back,rolled-back", statuses(r));
    check(r.mesh.faces.length === 6, `the plate alone: 6 faces (${r.mesh.faces.length})`);
  });

  test("the pump body: primitives and groups", () => {
    const r = call("run", pump, "pump_body.py");
    check(r.ok && statuses(r) === "ok,ok,ok,ok,ok,ok", "builds", JSON.stringify(r.error));
    check(r.timeline.features.map((f) => f.kind).join() === "cylinder,cylinder,group,group,group,fillet", "feature kinds");
    check(r.timeline.features[4].label === "Polar: Cylinder", r.timeline.features[4].label);
  });

  test("a failing feature: the error at it, the model before it shown", () => {
    const r = call("run", pump.replace("radius=1)", "radius=20)"), "pump_body.py");
    check(!r.ok && r.error.feature === 5 && r.error.line === 23 && /Failed creating a fillet/.test(r.error.message), "the fillet fails", JSON.stringify(r.error));
    check(statuses(r) === "ok,ok,ok,ok,ok,error" && r.mesh.faces.length === 18, "earlier features built; the mesh is the part before the fillet");
  });

  test("a syntax error: its line, no mesh", () => {
    const r = call("run", pump.replace("Cylinder(outer_r", "Cylinder((outer_r"), "pump_body.py");
    check(!r.ok && r.error.line === 10 && /^SyntaxError/.test(r.error.message) && r.error.feature === undefined && !r.mesh, JSON.stringify(r.error));
  });

  test("code without a builder is one custom code feature", () => {
    const r = call("run", "from build123d import *\nresult = Box(10, 20, 30) - Cylinder(4, 30)\n", "algebra.py");
    check(r.ok && r.timeline.features.length === 1 && r.timeline.features[0].kind === "code" && r.mesh.faces.length === 7, JSON.stringify(r.timeline?.features));
  });
});
