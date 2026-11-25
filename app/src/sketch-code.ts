// Turning a GUI sketch into build123d: a constrained sketch's body (the kernel writes the named sketch feature).

export type Shape =
  | { kind: "rect"; x: number; y: number; w: number; h: number } // centre and size, in sketch coordinates
  | { kind: "circle"; x: number; y: number; r: number }
  | { kind: "poly"; pts: [number, number][] };

/** Short number for code: up to 3 decimals, no trailing zeros. */
export const num = (v: number) => String(Math.round(v * 1000) / 1000 || 0);

/**
 * The body of a sketch: a constrained sketch (docs/06-sketches.md) with one shape per drawn shape, its size
 * as dimensions and its position as distances from the origin, so it is fully constrained. The kernel adds
 * the `with BuildSketch` line and the import.
 */
export function sketchBody(shapes: Shape[]): string[] {
  const out: string[] = [];
  const count: Record<string, number> = {};
  const name = (kind: string) => `${kind}${(count[kind] = (count[kind] ?? 0) + 1)}`;
  const place = (point: string, x: number, y: number) => Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9
    ? [`c.coincident(${point}, c.origin)`]
    : [`c.hdistance(c.origin, ${point}, ${num(x)})`, `c.vdistance(c.origin, ${point}, ${num(y)})`];
  const xy = (x: number, y: number) => `(${num(x)}, ${num(y)})`;
  for (const s of shapes) {
    if (s.kind === "rect") {
      const n = name("rect");
      out.push(`${n} = c.rectangle(${xy(s.x - s.w / 2, s.y - s.h / 2)}, ${xy(s.x + s.w / 2, s.y + s.h / 2)})`,
        `c.length(${n}.bottom, ${num(s.w)})`, `c.length(${n}.left, ${num(s.h)})`, ...place(`${n}.center`, s.x, s.y));
    } else if (s.kind === "circle") {
      const n = name("circle");
      out.push(`${n} = c.circle(${xy(s.x, s.y)}, ${num(s.r)})`, `c.radius(${n}, ${num(s.r)})`, ...place(`${n}.center`, s.x, s.y));
    } else {
      const n = name("poly");
      out.push(`${n} = c.polygon(${s.pts.map(([x, y]) => xy(x, y)).join(", ")})`, `c.fix(*${n}.points)`);
    }
  }
  return ["with Constrained() as c:", ...out.map((l) => "    " + l)];
}

export function newPartSource(name: string): string {
  return `from build123d import *\n\nwith BuildPart() as ${name}:\n    pass\n`;
}
