// Timeline panel: one row per feature statement, with a rollback bar like Onshape's. A row shows the name the code
// uses (sk1, pl1) and what the feature is (docs/09: code and timeline map one to one).
import { featureIcon, icon } from "./icons";
import type { BuildResult, Feature } from "./kernel";
import { sketchStatus } from "./tools";
import { esc } from "./ui";

// A click rolls back, a double-click edits: wait this long so a double-click doesn't roll back first.
const DOUBLE_CLICK_MS = 200;
let clickTimer = 0;

export type AddKind = "plane" | "extrude" | "revolve" | "hole" | "fillet" | "chamfer" | "mirror";

export type TimelineHandlers = {
  rollback: (upto: number | null) => void;
  hover: (feature: Feature | null) => void;
  edit: (feature: Feature) => void;
  remove: (feature: Feature) => void;
  /** Right-click on a row. */
  menu: (feature: Feature, at: { x: number; y: number }) => void;
};

export type TimelineMarks = {
  /** Indexes of the features the agent changed (shown with a violet dot until you change the file). */
  agent: Set<number>;
  /** The feature being edited in a dialog or the sketch editor. */
  active: number | null;
  /** The feature the cursor in the code is in. */
  cursor?: number | null;
};

/** The index of the timeline row that has the keyboard focus (for F2 and Delete), or null. */
export function focusedFeature(el: HTMLElement): number | null {
  const a = document.activeElement as HTMLElement | null;
  return a && el.contains(a) && a.matches("li.feature[data-index]") ? Number(a.dataset.index) : null;
}

/** Mark the row of the feature the cursor in the code is in (without redrawing the timeline). */
export function markCursor(el: HTMLElement, index: number | null) {
  for (const li of el.querySelectorAll<HTMLElement>("li.feature[data-index]")) {
    const on = li.dataset.index === String(index);
    if (on && !li.classList.contains("at-cursor")) li.scrollIntoView({ block: "nearest" });
    li.classList.toggle("at-cursor", on);
  }
}

/** "sk1 = Sketch: Rectangle" → name and what it is, apart; a label without a name stays as it is. */
function split(f: Feature): { name: string | null; what: string } {
  const label = f.label.replace(/^\w+\s*=\s*/, "");
  if (!f.name) return { name: null, what: label };
  // The name is shown first, so the description doesn't repeat it ("Plane pl1 on a face" → "pl1 · Plane on a face").
  const what = label.replace(new RegExp(`(^|\\s)${f.name}(\\s*[·:=]\\s*|\\s+|$)`), "$1").trim();
  return { name: f.name, what: what || f.kind };
}

export function renderTimeline(el: HTMLElement, result: BuildResult | null, h: TimelineHandlers, marks: TimelineMarks = { agent: new Set(), active: null }) {
  const focused = focusedFeature(el); // keeps the keyboard focus on its row when the timeline is redrawn
  el.replaceChildren();
  const feats = result?.timeline?.features ?? [];
  const last = feats.length - 1;
  const rolledBack = result?.upto != null && result.upto < last;

  if (!feats.length && !result?.error) {
    el.append(Object.assign(document.createElement("li"), { className: "timeline-empty", textContent: result ? "No features yet: start with Sketch (S)." : "Open a part to see its timeline." }));
  }
  if (rolledBack && result!.upto === -1) el.append(bar(() => h.rollback(null))); // before the first feature
  feats.forEach((f) => {
    const li = document.createElement("li");
    li.className = `feature ${f.status}${f.sketch?.dof ? " under" : ""}${f.sketch?.message ? " warn" : ""}${marks.active === f.index ? " active" : ""}${marks.cursor === f.index ? " at-cursor" : ""}`;
    li.dataset.index = String(f.index);
    li.tabIndex = 0;
    li.title = `${f.label}${f.sketch ? ` — ${sketchStatus(f.sketch)}` : ""}\nLine ${f.line}${f.end > f.line ? `–${f.end}` : ""} · click to roll back to here · double-click to ${f.tier === "code" ? "show its code" : "edit"} · right-click for more${f.name ? " · F2 renames it" : ""}` +
      (f.status === "error" && result?.error ? `\n${result.error.message}` : "");
    const { name, what } = split(f);
    li.innerHTML = `<span class="icon">${icon(featureIcon(f.kind))}</span><span class="label">${name ? `<span class="n tn">${esc(name)}</span>` : ""}${esc(what)}</span>` +
      `<span class="marks">${marks.agent.has(f.index) ? '<i class="mark-agent" title="Changed by the agent"></i>' : ""}${f.status === "error" ? '<i class="mark-err" title="This feature failed"></i>' : ""}` +
      `<button class="del" title="Delete this feature · Delete" aria-label="Delete">${icon("trash")}</button></span>`;
    li.querySelector<HTMLButtonElement>(".del")!.onclick = (e) => { e.stopPropagation(); h.remove(f); };
    if (f.status === "error" && result?.error) {
      const msg = document.createElement("div");
      msg.className = "message";
      msg.textContent = result.error.message;
      li.append(msg);
    }
    li.onclick = (e) => {
      if (li.classList.contains("editing")) return; // typing its new name
      clearTimeout(clickTimer);
      if (e.detail === 1) clickTimer = window.setTimeout(() => h.rollback(f.index === last ? null : f.index), DOUBLE_CLICK_MS);
    };
    li.ondblclick = () => { if (li.classList.contains("editing")) return; clearTimeout(clickTimer); h.edit(f); };
    li.oncontextmenu = (e) => { e.preventDefault(); h.menu(f, { x: e.clientX, y: e.clientY }); };
    li.onmouseenter = () => h.hover(f);
    li.onmouseleave = () => h.hover(null);
    el.append(li);
    if (rolledBack && f.index === result!.upto) el.append(bar(() => h.rollback(null)));
  });
  if (feats.length && !rolledBack) el.append(bar(null));
  if (focused !== null) el.querySelector<HTMLElement>(`li.feature[data-index="${focused}"]`)?.focus({ preventScroll: true });
  if (result?.error && result.error.feature == null) {
    const li = document.createElement("li");
    li.className = "feature error";
    li.innerHTML = `<span class="icon">${icon("alert")}</span><span class="label"></span>`;
    li.querySelector(".label")!.textContent = `Line ${result.error.line ?? "?"}: ${result.error.message}`;
    li.title = li.textContent ?? "";
    el.append(li);
  }
}

/** The rollback bar: new features go here. Rolled back, a click on it shows the whole part again. */
function bar(toEnd: (() => void) | null) {
  const li = document.createElement("li");
  li.className = `rollback-bar${toEnd ? " back" : ""}`;
  li.title = toEnd ? "Rolled back: new features go here. Click to show the whole part" : "End of the part: new features go here";
  li.innerHTML = toEnd ? "<span>Show all</span>" : "";
  if (toEnd) li.onclick = toEnd;
  return li;
}
