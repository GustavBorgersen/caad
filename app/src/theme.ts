// Themes (docs/10-visual-system.md): light and dark, following the system unless chosen in settings. Colours are CSS
// tokens on :root (style.css); the 3D view and the sketch editor read them here, so nothing has its own colours.
export type ThemeChoice = "system" | "light" | "dark";

const KEY = "caad.theme";
const listeners = new Set<() => void>();
const media = matchMedia("(prefers-color-scheme: dark)");

export function themeChoice(): ThemeChoice {
  try { return (localStorage.getItem(KEY) as ThemeChoice | null) ?? "system"; } catch { return "system"; }
}

/** Apply a choice (and remember it); without one, apply the remembered choice. */
export function setTheme(choice?: ThemeChoice) {
  if (choice) try { localStorage.setItem(KEY, choice); } catch { /* private window: this tab only */ }
  const c = choice ?? themeChoice();
  const dark = c === "dark" || (c === "system" && media.matches);
  if (document.documentElement.dataset.theme !== (dark ? "dark" : "light")) {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    cache.clear();
    for (const f of listeners) f();
  }
}
media.addEventListener("change", () => setTheme());

/** Called after the theme changed (the view repaints with the new colours). */
export function onThemeChange(f: () => void) { listeners.add(f); }

const cache = new Map<string, number>();
const probe = document.createElement("canvas").getContext("2d")!;

/** A colour token (`--accent`) as 0xRRGGBB, for three.js. */
export function token(name: string): number {
  let c = cache.get(name);
  if (c === undefined) {
    const css = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#ff00ff";
    probe.fillStyle = "#000";
    probe.fillStyle = css; // the canvas normalises any CSS colour to #rrggbb
    c = parseInt(String(probe.fillStyle).slice(1), 16);
    cache.set(name, c);
  }
  return c;
}

/** A colour token as CSS (`#rrggbb`), for canvas drawing. */
export const tokenCss = (name: string) => `#${token(name).toString(16).padStart(6, "0")}`;

/** Whether animations should be skipped (the system's reduce-motion setting). */
export const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
