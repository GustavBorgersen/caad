// Turning a GUI sketch into build123d code, and inserting it into a part file at a timeline position.

export type Shape =
  | { kind: "rect"; x: number; y: number; w: number; h: number } // centre and size, in sketch coordinates
  | { kind: "circle"; x: number; y: number; r: number }
  | { kind: "poly"; pts: [number, number][] };

export type Operation = { op: "extrude" | "cut"; amount: number; both: boolean; through: boolean };

/** Short number for code: up to 3 decimals, no trailing zeros. */
export const num = (v: number) => String(Math.round(v * 1000) / 1000 || 0);

export function sketchLines(planeExpr: string, shapes: Shape[], op: Operation): string[] {
  const out = [`with BuildSketch(${planeExpr}):`];
  for (const s of shapes) {
    if (s.kind === "poly") {
      out.push(`    Polygon(${s.pts.map(([x, y]) => `(${num(x)}, ${num(y)})`).join(", ")}, align=None)`);
      continue;
    }
    const call = s.kind === "rect" ? `Rectangle(${num(s.w)}, ${num(s.h)})` : `Circle(${num(s.r)})`;
    if (Math.abs(s.x) < 1e-9 && Math.abs(s.y) < 1e-9) out.push(`    ${call}`);
    else out.push(`    with Locations((${num(s.x)}, ${num(s.y)})):`, `        ${call}`);
  }
  if (op.op === "cut") {
    if (op.through) out.push("extrude(until=Until.LAST, mode=Mode.SUBTRACT)");
    else out.push(`extrude(amount=${op.both ? num(op.amount) : num(-op.amount)}${op.both ? ", both=True" : ""}, mode=Mode.SUBTRACT)`);
  } else out.push(`extrude(amount=${num(op.amount)}${op.both ? ", both=True" : ""})`);
  return out;
}

type Feature = { line: number; end: number };

/**
 * Insert feature lines into the part block after feature `after` (index; null = after the last one).
 * A block that only contains `pass` gets the lines instead of the `pass`.
 */
export function insertFeatures(src: string, features: Feature[], after: number | null, lines: string[]): string {
  const text = src.split("\n");
  if (!features.length) throw new Error("This file has no `with BuildPart()` block to add to.");
  const indent = text[features[0].line - 1].match(/^\s*/)![0];
  const body = lines.map((l) => indent + l);
  if (features.length === 1 && text[features[0].line - 1].trim() === "pass") {
    text.splice(features[0].line - 1, 1, ...body);
  } else {
    const at = features[Math.min(after ?? features.length - 1, features.length - 1)].end;
    text.splice(at, 0, ...body);
  }
  return text.join("\n");
}

export function newPartSource(name: string): string {
  return `from build123d import *\n\nwith BuildPart() as ${name}:\n    pass\n`;
}
