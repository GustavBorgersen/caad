// Timeline panel: one row per feature statement, with a rollback bar like Onshape's.
import type { BuildResult, Feature } from "./kernel";

const ICONS: Record<string, string> = {
  sketch: "✎", extrude: "⬆", revolve: "↻", fillet: "◜", chamfer: "◸", hole: "◉", group: "⌗", code: "{}",
  box: "▣", cylinder: "◎", sphere: "●", mirror: "⇋", loft: "⋈", sweep: "∿",
};

// A click rolls back, a double-click edits: wait this long so a double-click doesn't roll back first.
const DOUBLE_CLICK_MS = 200;
let clickTimer = 0;

export type TimelineHandlers = {
  rollback: (upto: number | null) => void;
  hover: (feature: Feature | null) => void;
  edit: (feature: Feature) => void;
  remove: (feature: Feature) => void;
  add: (kind: "fillet" | "chamfer") => void; // a new feature at the rollback bar
};

export function renderTimeline(el: HTMLElement, result: BuildResult | null, h: TimelineHandlers) {
  el.replaceChildren();
  const feats = result?.timeline?.features ?? [];
  const last = feats.length - 1;
  const rolledBack = result?.upto != null && result.upto < last;

  if (rolledBack && result!.upto === -1) el.append(bar(() => h.rollback(null), h)); // before the first feature
  feats.forEach((f) => {
    const li = document.createElement("li");
    li.className = `feature ${f.status}`;
    li.title = `${f.label}\nLine ${f.line}${f.end > f.line ? `–${f.end}` : ""} · click to roll back to here · double-click to ${f.tier === "code" ? "show its code" : "edit"}` +
      (f.status === "error" && result?.error ? `\n${result.error.message}` : "");
    li.innerHTML = `<span class="icon"></span><span class="label"></span><button class="del" title="Delete this feature">×</button>`;
    li.querySelector<HTMLButtonElement>(".del")!.onclick = (e) => { e.stopPropagation(); h.remove(f); };
    li.querySelector(".icon")!.textContent = ICONS[f.kind] ?? "•";
    li.querySelector(".label")!.textContent = f.label;
    if (f.status === "error" && result?.error) {
      const msg = document.createElement("div");
      msg.className = "message";
      msg.textContent = result.error.message;
      li.append(msg);
    }
    li.onclick = (e) => {
      clearTimeout(clickTimer);
      if (e.detail === 1) clickTimer = window.setTimeout(() => h.rollback(f.index === last ? null : f.index), DOUBLE_CLICK_MS);
    };
    li.ondblclick = () => { clearTimeout(clickTimer); h.edit(f); };
    li.onmouseenter = () => h.hover(f);
    li.onmouseleave = () => h.hover(null);
    el.append(li);
    if (rolledBack && f.index === result!.upto) el.append(bar(() => h.rollback(null), h));
  });
  if (feats.length && !rolledBack) el.append(bar(null, h));
  if (result?.error && result.error.feature == null) {
    const li = document.createElement("li");
    li.className = "feature error";
    li.textContent = `Line ${result.error.line ?? "?"}: ${result.error.message}`;
    el.append(li);
  }
}

function bar(toEnd: (() => void) | null, h: TimelineHandlers) {
  const li = document.createElement("li");
  li.className = "rollback-bar";
  const text = document.createElement("span");
  text.textContent = toEnd ? "Rolled back — click to show all" : "End of part";
  if (toEnd) text.onclick = toEnd;
  const add = document.createElement("span");
  add.className = "add";
  for (const kind of ["fillet", "chamfer"] as const) {
    const b = document.createElement("button");
    b.textContent = `+ ${kind[0].toUpperCase()}${kind.slice(1)}`;
    b.title = `Add a ${kind} here, on the edges selected in the view`;
    b.onclick = () => h.add(kind);
    add.append(b);
  }
  li.append(text, add);
  return li;
}
