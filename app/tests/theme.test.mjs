// Contrast of the theme's tokens (docs/10-visual-system.md, goal 12): every text and state pair passes WCAG AA in the
// light and the dark theme, read from src/style.css itself, so a later colour change can't silently fail it.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { check } from "./common.mjs";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const block = (selector) => {
  const i = css.indexOf(`${selector} {`);
  return Object.fromEntries([...css.slice(i, css.indexOf("\n}", i)).matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map(([, k, v]) => [k, v]));
};
const light = block(":root");
const dark = { ...light, ...block(':root[data-theme="dark"]') };

const lum = (hex) => {
  const [r, g, b] = hex.slice(1).match(/../g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [foreground, background, minimum]: 4.5 for text, 3 for graphics (lines, icons, borders that matter).
const TEXT = 4.5, GRAPHIC = 3;
const PAIRS = [
  ["text", "panel", TEXT], ["text", "panel-2", TEXT], ["text", "view-bottom", TEXT], ["muted", "panel", TEXT], ["muted", "panel-2", TEXT],
  ["muted", "view-bottom", TEXT], ["accent", "panel", TEXT], ["accent-text", "accent-soft", TEXT], ["accent-text", "panel", TEXT],
  ["on-accent", "accent", TEXT], ["agent", "panel", TEXT], ["agent", "agent-soft", TEXT], ["err", "panel", TEXT], ["err", "err-soft", TEXT],
  ["ok", "panel", TEXT], ["code-keyword", "panel", TEXT], ["code-number", "panel", TEXT], ["code-string", "panel", TEXT],
  ["code-keyword", "accent-soft", TEXT], ["code-number", "accent-soft", TEXT], ["code-string", "accent-soft", TEXT],
  ["faint", "panel", GRAPHIC], ["cons", "view-bottom", GRAPHIC], ["axis-x", "view-bottom", GRAPHIC], ["axis-y", "view-bottom", GRAPHIC],
  ["sk-free", "view-bottom", GRAPHIC], ["sk", "view-bottom", GRAPHIC], ["plane", "view-bottom", GRAPHIC], ["edge", "part-hi", GRAPHIC],
];

for (const [name, tokens] of [["light", light], ["dark", dark]]) {
  test(`${name} theme: every pair passes WCAG AA`, () => {
    const failing = PAIRS.map(([f, b, min]) => [f, b, min, ratio(tokens[f], tokens[b])]).filter(([, , min, r]) => r < min)
      .map(([f, b, min, r]) => `${f} on ${b}: ${r.toFixed(2)} < ${min}`);
    check(PAIRS.every(([f, b]) => tokens[f] && tokens[b]), "every token is defined", PAIRS.filter(([f, b]) => !tokens[f] || !tokens[b]));
    check(failing.length === 0, "contrast", failing);
  });
}
