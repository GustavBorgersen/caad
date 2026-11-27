// Shared by the style mock-ups: the part views (views.js), a small set of line icons, and the theme switch.
// Static pages, no build step; open them straight from disk.

/* Line icons (24 × 24, stroke), Lucide-like, drawn for the mock-ups. */
const ICONS = {
  sketch: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
  extrude: '<path d="M4 17l8 4 8-4-8-4z"/><path d="M12 13V3"/><path d="M8.5 6.5L12 3l3.5 3.5"/>',
  revolve: '<path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 3v4h-4"/>',
  hole: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  fillet: '<path d="M4 20V10a6 6 0 0 1 6-6h10"/>',
  chamfer: '<path d="M4 20v-9l7-7h9"/>',
  plane: '<path d="M3 17l5-10h13l-5 10z"/>',
  mirror: '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7L4 17h5z"/><path d="M15 7l5 10h-5z"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  agent: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  code: '<path d="M8 7l-5 5 5 5"/><path d="M16 7l5 5-5 5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  line: '<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  arc: '<path d="M4 18a8 8 0 0 1 16 0"/>',
  point: '<circle cx="12" cy="12" r="3.5"/>',
  dimension: '<path d="M4 8v8M20 8v8M4 12h16"/><path d="M7 9.5L4 12l3 2.5M17 9.5l3 2.5-3 2.5"/>',
  trim: '<circle cx="7" cy="17" r="2.5"/><circle cx="7" cy="7" r="2.5"/><path d="M9 15L20 5M9 9l11 10"/>',
  construction: '<path d="M4 20L20 4" stroke-dasharray="3 3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  box: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  target: '<circle cx="12" cy="12" r="8"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  pen: '<path d="M4 20h4L20 8l-4-4L4 16z"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  fileCode: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M10 12l-2 2 2 2M14 12l2 2-2 2"/>',
  fileDown: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M12 10v7M9 14l3 3 3-3"/>',
  folderOpen: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1"/><path d="M3 19l2.5-8h16L19 19z"/><path d="M3 7v12"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  gearFile: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><circle cx="12" cy="14" r="2.2"/>',
  swap: '<path d="M7 4L3 8l4 4"/><path d="M3 8h14"/><path d="M17 12l4 4-4 4"/><path d="M21 16H7"/>',
  sparkle: '<path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/>',
};

/* ---- The content every direction shows (only the style differs) ---- */

/** Timeline rows: [icon, name, label]. */
const FEATURES = [
  ["sketch", "sk1", "Sketch · profile"], ["revolve", "", "Revolve sk1 · 360°"], ["box", "", "Lug · Box 20 × 16 × 6"],
  ["mirror", "", "Mirror · YZ"], ["hole", "", "Hole Ø16 · through"], ["sketch", "sk2", "Sketch · 2 points"],
  ["hole", "", "Counterbore holes · at sk2"], ["fillet", "", "Fillet · r 3"], ["fillet", "", "Fillet · r 4 · 4 edges"],
];

/** hub.py as the code pane shows it: [html, "hl"?]; "gap" is the blank line between features. */
const CODE = [
  ['<span class="k">from</span> build123d <span class="k">import</span> *'], ['<span class="k">from</span> caad <span class="k">import</span> Constrained, points'], [""],
  ['radius = <span class="num">22</span>'], ['height = <span class="num">14</span>'], ['bolt_r = <span class="num">2.5</span>'], [""],
  ['<span class="k">with</span> BuildPart() <span class="k">as</span> hub:'],
  ['    <span class="k">with</span> BuildSketch(Plane.XZ, mode=Mode.PRIVATE) <span class="k">as</span> <span class="nm">sk1</span>:'], ['        ...'], ["gap"],
  ['    revolve(<span class="nm">sk1</span>.sketch, axis=Axis.Z)'], ["gap"],
  ['    <span class="k">with</span> Locations((radius + <span class="num">9</span>, <span class="num">0</span>, <span class="num">3</span>)):'], ['        Box(<span class="num">20</span>, <span class="num">16</span>, <span class="num">6</span>)'], ["gap"],
  ['    mirror(about=Plane.YZ)'], ["gap"],
  ['    <span class="k">with</span> Locations((<span class="num">0</span>, <span class="num">0</span>, height)):'], ['        Hole(<span class="num">8</span>)'], ["gap"],
  ['    <span class="k">with</span> BuildSketch(hub.faces()...[-<span class="num">1</span>]) <span class="k">as</span> <span class="nm">sk2</span>:'], ['        ...'], ["gap"],
  ['    <span class="k">with</span> Locations(*points(<span class="nm">sk2</span>)):', "hl"], ['        CounterBoreHole(radius=bolt_r, counter_bore_radius=<span class="num">5</span>,', "hl"], ['                        counter_bore_depth=<span class="num">2</span>)', "hl"], ["gap"],
  ['    fillet(hub.edges()...top rim, radius=<span class="num">3</span>)'],
];

/** Overlays drawn over a view, in its millimetres (top view: x = X, y = -Y). Classes are styled by each page. */
const OVERLAYS = {
  // sk3 on the top face: a key slot, four points on a construction circle, the bore as a reference; dimensions
  sketch: `  <defs><marker id="arA" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="1.1" markerHeight="1.1" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 1L10 5 0 9z" fill="var(--dim)"/></marker></defs>
  <path class="ax-x" d="M0 0H6"/><path class="ax-y" d="M0 0V-6"/>
  <circle class="ref" cx="0" cy="0" r="8"/>
  <circle class="cons" cx="0" cy="0" r="14"/>
  <path class="sk" d="M-3 -7V-10.5H3V-7"/><path class="sk sel" d="M-3 -10.5H3"/>
  <circle class="ring" cx="9.9" cy="-9.9" r=".85"/><circle class="ring" cx="-9.9" cy="-9.9" r=".85"/><circle class="ring" cx="-9.9" cy="9.9" r=".85"/><circle class="ring" cx="9.9" cy="9.9" r=".85"/>
  <circle class="dot" cx="0" cy="0" r=".45"/>
  <!-- key width 6 -->
  <path class="dl" d="M-3 -11V-14.2M3 -11V-14.2"/><path class="dl" d="M-3 -13.6H3" marker-start="url(#arA)" marker-end="url(#arA)"/>
  <text class="dt" x="0" y="-14.5">6</text>
  <!-- key height from the centre: 10.5 -->
  <path class="dl" d="M3.5 -10.5H6.6M.6 0H6.6"/><path class="dl" d="M6 0V-10.5" marker-start="url(#arA)" marker-end="url(#arA)"/>
  <text class="dt" x="7" y="-5.3" style="text-anchor:start">10.5</text>
  <!-- PCD -->
  <path class="dl" d="M12.1 7 L18.5 11.4 H22"/><text class="dt" x="20" y="11.3" style="text-anchor:start">Ø28</text>
  <!-- 45° -->
  <path class="dl" d="M5.5 0A5.5 5.5 0 0 0 3.9 -3.9"/><path class="dl" d="M0 0L9.9 -9.9" stroke-dasharray="1 2"/>
  <text class="dt" x="8.2" y="-1.2">45°</text>
  <!-- constraint glyphs -->
  <g class="gl"><rect x="11.2" y="-12.2" width="1.6" height="1.4" rx=".35"/><text x="12" y="-11.5">∈</text></g>
  <g class="gl"><rect x="-.8" y="-6.2" width="1.6" height="1.4" rx=".35"/><text x="0" y="-5.5">⇋</text></g>
`,
};

/** <svg class="i"> for an icon name. */
function icon(name, cls = "") {
  return `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
}

/* Fill every [data-icon] and [data-view] in the page. */
function fill(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon, el.dataset.iconClass ?? ""));
  for (const el of root.querySelectorAll("[data-view]")) {
    const v = window.CAAD_VIEWS?.[el.dataset.view];
    if (!v) continue;
    const overlay = OVERLAYS[el.dataset.overlay] ?? ""; // in the same millimetres as the view
    el.insertAdjacentHTML("afterbegin", `<svg class="part ${el.dataset.mods ?? ""}" viewBox="${el.dataset.box ?? v.viewBox}" preserveAspectRatio="xMidYMid meet">${v.svg}<g class="overlay">${overlay}</g></svg>`);
  }
}

/* Theme: follows the system unless chosen (kept in localStorage). */
function theme(choice) {
  const root = document.documentElement;
  try { if (choice) localStorage.setItem("caad-mockup-theme", choice); choice = localStorage.getItem("caad-mockup-theme") ?? "system"; } catch { choice ??= "system"; }
  const dark = choice === "dark" || (choice === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = dark ? "dark" : "light";
  for (const b of document.querySelectorAll("[data-theme-choice]")) b.setAttribute("aria-pressed", String(b.dataset.themeChoice === choice));
}

document.addEventListener("DOMContentLoaded", () => {
  fill();
  theme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => theme());
  for (const b of document.querySelectorAll("[data-theme-choice]")) b.onclick = () => theme(b.dataset.themeChoice);
});
