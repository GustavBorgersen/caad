// Timeline panel: one row per feature statement, with a rollback bar like Onshape's.
import type { BuildResult, Feature } from "./kernel";

const ICONS: Record<string, string> = {
  sketch: "✎", extrude: "⬆", revolve: "↻", fillet: "◜", chamfer: "◸", hole: "◉", group: "⌗", code: "{}",
  box: "▣", cylinder: "◎", sphere: "●", mirror: "⇋", loft: "⋈", sweep: "∿",
};

export type TimelineHandlers = {
  rollback: (upto: number | null) => void;
  hover: (feature: Feature | null) => void;
};

export function renderTimeline(el: HTMLElement, result: BuildResult | null, h: TimelineHandlers) {
  el.replaceChildren();
  const feats = result?.timeline?.features ?? [];
  const last = feats.length - 1;
  const rolledBack = result?.upto != null && result.upto < last;

  feats.forEach((f) => {
    const li = document.createElement("li");
    li.className = `feature ${f.status}`;
    li.title = `${f.label}\nLine ${f.line}${f.end > f.line ? `–${f.end}` : ""} · click to roll back to here` +
      (f.status === "error" && result?.error ? `\n${result.error.message}` : "");
    li.innerHTML = `<span class="icon"></span><span class="label"></span>`;
    li.querySelector(".icon")!.textContent = ICONS[f.kind] ?? "•";
    li.querySelector(".label")!.textContent = f.label;
    if (f.status === "error" && result?.error) {
      const msg = document.createElement("div");
      msg.className = "message";
      msg.textContent = result.error.message;
      li.append(msg);
    }
    li.onclick = () => h.rollback(f.index === last ? null : f.index);
    li.onmouseenter = () => h.hover(f);
    li.onmouseleave = () => h.hover(null);
    el.append(li);
    if (rolledBack && f.index === result!.upto) el.append(bar(() => h.rollback(null)));
  });
  if (feats.length && !rolledBack) el.append(bar(null));
  if (result?.error && result.error.feature == null) {
    const li = document.createElement("li");
    li.className = "feature error";
    li.textContent = `Line ${result.error.line ?? "?"}: ${result.error.message}`;
    el.append(li);
  }
}

function bar(toEnd: (() => void) | null) {
  const li = document.createElement("li");
  li.className = "rollback-bar";
  li.textContent = toEnd ? "Rolled back — click to show all" : "End of part";
  if (toEnd) li.onclick = toEnd;
  return li;
}
