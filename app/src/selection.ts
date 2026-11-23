// Selection panel: what is selected (type, size, position) and verified build123d selectors for it.
import type { SelectInfo, SelectedItem } from "./kernel";

const fmt = (v: unknown) => Array.isArray(v) ? `(${v.map((n) => +Number(n).toFixed(3)).join(", ")})` : String(v);
const PROPS: [string, string, string?][] = [
  ["area", "Area", "mm²"], ["length", "Length", "mm"], ["radius", "Radius", "mm"], ["center", "Center"],
  ["normal", "Normal"], ["axis", "Axis"], ["direction", "Direction"], ["start", "Start"], ["end", "End"],
];

export function renderSelection(el: HTMLElement, infos: SelectInfo[]) {
  const items = infos.flatMap((i) => i.items);
  el.hidden = !items.length;
  if (!items.length) return;
  el.replaceChildren();

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = items.length === 1 ? `${cap(items[0].kind)} · ${items[0].type}` : summary(items);
  el.append(title);

  if (items.length === 1) {
    const props = document.createElement("div");
    props.className = "props";
    for (const [key, label, unit] of PROPS) {
      if (items[0][key] === undefined) continue;
      props.append(span(label), span(fmt(items[0][key]) + (unit ? ` ${unit}` : "")));
    }
    el.append(props);
  }

  for (const info of infos) {
    for (const [i, s] of info.selectors.entries()) {
      const row = document.createElement("div");
      row.className = "sel";
      const code = document.createElement("code");
      code.textContent = s.expr;
      const copy = document.createElement("button");
      copy.textContent = "Copy";
      copy.onclick = () => navigator.clipboard.writeText(s.expr).then(() => { copy.textContent = "Copied"; });
      row.append(code);
      if (s.fragile) row.append(tag("position-based"));
      else if (i === 0) row.append(tag("best"));
      row.append(copy);
      el.append(row);
    }
  }
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const span = (t: string) => Object.assign(document.createElement("span"), { textContent: t });
const tag = (t: string) => Object.assign(document.createElement("span"), { className: "tag", textContent: t });
function summary(items: SelectedItem[]) {
  const n = (k: string) => items.filter((i) => i.kind === k).length;
  return [n("face") && `${n("face")} face${n("face") > 1 ? "s" : ""}`, n("edge") && `${n("edge")} edge${n("edge") > 1 ? "s" : ""}`]
    .filter(Boolean).join(" + ");
}
