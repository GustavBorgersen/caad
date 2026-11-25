// Turning a GUI sketch into build123d: the sketch body and the extrude's arguments (the kernel writes the features).

export type Shape =
  | { kind: "rect"; x: number; y: number; w: number; h: number } // centre and size, in sketch coordinates
  | { kind: "circle"; x: number; y: number; r: number }
  | { kind: "poly"; pts: [number, number][] };

export type Operation = { op: "extrude" | "cut"; amount: number; both: boolean; through: boolean };

/** Short number for code: up to 3 decimals, no trailing zeros. */
export const num = (v: number) => String(Math.round(v * 1000) / 1000 || 0);

/** The body of a sketch: one build123d object per drawn shape. The kernel adds the `with BuildSketch` line. */
export function sketchBody(shapes: Shape[]): string[] {
  const out: string[] = [];
  for (const s of shapes) {
    if (s.kind === "poly") {
      out.push(`Polygon(${s.pts.map(([x, y]) => `(${num(x)}, ${num(y)})`).join(", ")}, align=None)`);
      continue;
    }
    const call = s.kind === "rect" ? `Rectangle(${num(s.w)}, ${num(s.h)})` : `Circle(${num(s.r)})`;
    if (Math.abs(s.x) < 1e-9 && Math.abs(s.y) < 1e-9) out.push(call);
    else out.push(`with Locations((${num(s.x)}, ${num(s.y)})):`, `    ${call}`);
  }
  return out;
}

/**
 * Arguments of the extrude or cut that uses the sketch. `into` is the direction into the part when the
 * sketch is on a face: its normal points out, so a cut through all must be told to go the other way.
 */
export function extrudeArgs(op: Operation, into: number[] | null): Record<string, string> {
  const both: Record<string, string> = op.both ? { both: "True" } : {};
  if (op.op === "extrude") return { amount: num(op.amount), ...both };
  if (op.through) return { until: "Until.LAST", mode: "Mode.SUBTRACT", ...(into ? { dir: `(${into.map(num).join(", ")})` } : {}) };
  return { amount: num(op.both ? op.amount : -op.amount), ...both, mode: "Mode.SUBTRACT" };
}

export function newPartSource(name: string): string {
  return `from build123d import *\n\nwith BuildPart() as ${name}:\n    pass\n`;
}
