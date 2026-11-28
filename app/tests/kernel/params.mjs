// The parameters panel (docs/10-visual-system.md): run() lists the part's number parameters, patch_param changes one
// parameter's expression and nothing else.
import { describe, test } from "node:test";
import { call, check, tryCall } from "./env.mjs";

const src = `from build123d import *
from params import *  # not a parameter

width = 60
depth = width / 2   # half of it
name = "bracket"
flag = True
height = (
    10
)

with BuildPart() as part:
    Box(width, depth, height)
    inner = 3
`;

describe("parameters", () => {
  test("run lists the number parameters before the part, with expressions and values", () => {
    const r = call("run", src.replace("from params import *  # not a parameter\n", ""), "part.py");
    const got = r.params.map((p) => `${p.name}=${p.expr}:${p.value}@${p.line}`).join(" ");
    check(got === "width=60:60@3 depth=width / 2:30@4 height=10:10@7", "numbers only (not strings or bools), none from inside the part", got);
  });

  test("patch_param changes the expression only: comments, other lines and brackets stay", () => {
    const plain = src.replace("from params import *  # not a parameter\n", "");
    const a = call("patch_param", plain, "depth", "width / 3");
    check(a === plain.replace("depth = width / 2   # half of it", "depth = width / 3   # half of it"), "the comment stays", a);
    const b = call("patch_param", plain, "height", "12");
    check(b === plain.replace("height = (\n    10\n)", "height = (\n    12\n)"), "the brackets around a value stay", b);
    check(call("run", b, "part.py").summary.volume === 60 * 30 * 12, "and builds with it");
  });

  test("patch_param refuses what isn't one expression or isn't a parameter", () => {
    const plain = src.replace("from params import *  # not a parameter\n", "");
    for (const [name, expr] of [["width", "6 +"], ["width", "a = 3"], ["inner", "4"], ["nothing", "1"]]) {
      const e = tryCall("patch_param", plain, name, expr);
      check(!!e.error, `refused: ${name} = ${expr}`, e);
    }
  });
});
