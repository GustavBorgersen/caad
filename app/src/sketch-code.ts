// Turning a GUI sketch into build123d: the sketch's body (the kernel writes the named sketch feature).

export type Shape =
  | { kind: "rect"; x: number; y: number; w: number; h: number } // centre and size, in sketch coordinates
  | { kind: "circle"; x: number; y: number; r: number }
  | { kind: "poly"; pts: [number, number][] };

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

export function newPartSource(name: string): string {
  return `from build123d import *\n\nwith BuildPart() as ${name}:\n    pass\n`;
}
