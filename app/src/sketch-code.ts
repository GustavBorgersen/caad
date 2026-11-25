// Small helpers for code the page writes: numbers and new part files (sketch code is written by the kernel).

/** Short number for code: up to 3 decimals, no trailing zeros. */
export const num = (v: number) => String(Math.round(v * 1000) / 1000 || 0);

export function newPartSource(name: string): string {
  return `from build123d import *\n\nwith BuildPart() as ${name}:\n    pass\n`;
}
