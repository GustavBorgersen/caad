// The agent's helpers in caad_kernel.py (snippets, api_help, highlights) and every code example in the
// agent guide (public/agent/guide.md).
import { describe, test } from "node:test";
import { call, check, example, read } from "./env.mjs";

describe("agent helpers", () => {
  test("every example in the agent guide builds", () => {
    const blocks = [...read("app/public/agent/guide.md").matchAll(/```python\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
    check(blocks.length > 3, `the guide has examples (${blocks.length})`);
    for (const [i, code] of blocks.entries()) {
      const r = call("run", code, `guide_${i}.py`);
      check(r.ok, `guide example ${i + 1} builds`, r.error);
    }
  });

  test("run_snippet: output, the last value, errors with their line", () => {
    call("run", example("bracket.py"), "bracket.py");
    const s1 = call("snippet", "print('hi')\nlen(bracket.edges().filter_by(Axis.Z))");
    check(s1.output === "hi\n" && s1.value === "9", "printed output and the value", s1);
    const s2 = call("snippet", "bracket.faces().sort_by(Axis.Z)[-1]");
    check(s2.value.shape === "Face" && s2.value.type === "PLANE" && s2.value.area === 480, "a shape is described", s2);
    const s3 = call("snippet", "width * 2 + undefined_name");
    check(/^NameError: .*undefined_name.*\(line 1\)$/.test(s3.error), s3.error);
  });

  test("api_help: signatures, docs, members and close matches", () => {
    check(/: fillet\n\nfillet\(objects: /.test(call("api_help", "fillet")), "a function");
    check(call("api_help", "ShapeList.sort_by").includes("ShapeList.sort_by(self, sort_by:"), "a method");
    check(call("api_help", "Cone").split("\n\n")[1].startsWith("Cone(bottom_radius: 'float', top_radius: 'float', height: 'float'"), "a class: its constructor");
    check(call("api_help", "CounterBoreHole").split("\n\n")[1].startsWith("CounterBoreHole(radius: 'float', counter_bore_radius"), "a part operation");
    check(call("api_help", "Mode").includes("Members: ADD, SUBTRACT, INTERSECT, REPLACE, PRIVATE"), "an enum lists its members");
    const near = call("api_help", "counterbore");
    check(near.startsWith("'counterbore' is not an exact name") && near.includes("- CounterBoreHole:"), "a name that isn't exact: matches", near);
  });

  test("highlight_indices: what a selector picks, or why it can't be shown", () => {
    call("run", example("bracket.py"), "bracket.py");
    const h = call("highlight_indices", "bracket.edges().filter_by(Axis.Z)");
    check(h.faces.length === 0 && h.edges.length === 9, "the vertical edges", h);
    check(/select faces or edges/.test(call("highlight_indices", "bracket.part").error), "a part isn't highlighted");
    check(/^AttributeError: 'BuildPart' has no attribute 'nonsense'/.test(call("highlight_indices", "bracket.nonsense()").error), "a bad selector's error");
  });
});
