// Feature dialog: edit a feature's arguments as expressions, with a live preview (docs/05-feature-model.md).
// The kernel reads the feature and patches only the changed arguments; this panel just shows fields.
import { featureIcon, icon } from "./icons";
import type { FeatureDetail, FeatureField, Kernel, SketchRegions } from "./kernel";

const PREVIEW_DELAY_MS = 250;

export type FeatureDialogHost = {
  kernel: Kernel;
  /** Current source of the open part. */
  source: () => string;
  /** Build `src` up to feature `upto` and show it without saving; the error message, if any. */
  preview: (src: string, upto: number) => Promise<string | null>;
  /** Save the new source and rebuild as usual (the rollback bar returns to where it was). */
  apply: (src: string) => Promise<void>;
  /** Closed without changes. */
  cancel: () => void;
  /** Best selector for the selected edges or faces, if that's what is selected. */
  selection: (kind: "edge" | "face") => string | null;
  /** Show the regions of the sketch field's sketch in the view to pick (null: none); a click calls `toggle`. */
  regions: (r: SketchRegions | null, toggle: (index: number) => void) => void;
};

/** A sketch field's expression that uses a sketch (sk1.sketch, regions(sk1, …)) rather than the part's faces. */
const isSketch = (expr: string | null) => expr === null || /^\w+\.sketch$|^regions\(/.test(expr.trim());

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class FeatureDialog {
  private detail: FeatureDetail | null = null;
  private created: { src: string; original: string } | null = null; // a new feature: its source, not saved yet
  private exprs = new Map<string, string | null>(); // current expression per field; null = not in the code
  private added = new Set<string>(); // optional fields the user chose to show
  private timer = 0;
  private seq = 0;

  constructor(private el: HTMLElement, private host: FeatureDialogHost) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.cancel();
      else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") this.ok();
    });
  }

  get open() { return this.detail !== null; }

  /** Open for a feature; `newSrc` when it's a new feature that exists only in that (unsaved) source. */
  show(detail: FeatureDetail, newSrc?: string) {
    this.detail = detail;
    this.created = newSrc ? { src: newSrc, original: this.host.source() } : null;
    this.exprs = new Map(detail.fields!.map((f) => [f.name, f.expr ?? null]));
    this.added.clear();
    this.render();
    this.el.hidden = false;
    this.el.querySelector<HTMLInputElement>("input[type=text]")?.focus();
    this.schedule(0);
  }

  /** A flip field's expression for the current value of the field it flips, or null without one. */
  private flipped(f: FeatureField): string | null {
    const of = this.exprs.get(f.of!) ?? null;
    return of ? f.template!.replace("{}", of) : null;
  }

  private visible(f: FeatureField): boolean {
    const own = this.detail!.tier === "type" ? !f.extra : f.required;
    if (!own && this.exprs.get(f.name) == null && !this.added.has(f.name)) return false;
    return Object.entries(f.show_if ?? {}).every(([k, v]) => (this.exprs.get(k) ?? null) === (v ?? null)); // None arrives as undefined
  }

  private render() {
    const d = this.detail!;
    const fields = d.fields!;
    const hidden = fields.filter((f) => !this.visible(f) && !f.show_if);
    const name = d.tier === "type" ? d.kind[0].toUpperCase() + d.kind.slice(1) : `${d.call}()`;
    const title = this.created ? `New ${d.tier === "type" ? d.kind : name}` : name;
    this.el.innerHTML = `
      <div class="head">${icon(featureIcon(d.kind))}<b>${esc(title)}</b><span class="muted">feature ${d.index + 1}</span></div>
      <div class="fields">${fields.filter((f) => this.visible(f)).map((f) => this.row(f)).join("")}</div>
      ${hidden.length ? `<label class="add">Add argument <select><option value=""></option>${hidden.map((f) =>
        `<option value="${esc(f.name)}">${esc(f.label)}</option>`).join("")}</select></label>` : ""}
      ${fields.some((f) => f.type === "sketch" && this.visible(f) && isSketch(this.exprs.get(f.name) ?? null)) ? `<div class="note">Click regions of the sketch in the view to choose which to use, or select faces of the part and press Use selection.</div>` : ""}
      <div class="message" hidden></div>
      <div class="spacer"></div>
      <div class="actions"><button class="cancel">Cancel <kbd>Esc</kbd></button><button class="primary">OK <kbd>↵</kbd></button></div>`;

    this.el.querySelectorAll<HTMLElement>("[data-field]").forEach((row) => {
      const name = row.dataset.field!;
      const input = row.querySelector<HTMLInputElement | HTMLSelectElement>("input, select")!;
      const field = fields.find((f) => f.name === name)!;
      const read = () => input instanceof HTMLInputElement && input.type === "checkbox"
        ? (input.checked ? (field.type === "flip" ? this.flipped(field) : "True") : null)
        : (input.value.trim() || null);
      input.addEventListener(input instanceof HTMLSelectElement || input.type === "checkbox" ? "change" : "input", () => {
        this.assign(name, read());
        if (input instanceof HTMLSelectElement || input.type === "checkbox") this.render(); // may show or hide fields
        this.schedule();
      });
      row.querySelector<HTMLButtonElement>(".use")?.addEventListener("click", () => {
        const kind = field.pick ?? (field.type === "faces" || field.type === "sketch" ? "face" : "edge");
        const sel = this.host.selection(kind);
        if (!sel) { this.say(`Select ${field.pick ? `a flat ${kind}` : `${kind}s`} in the view first.`, true); return; }
        const expr = field.pick && field.template ? field.template.replace("{}", sel) : sel;
        this.assign(name, expr);
        if (input instanceof HTMLSelectElement) this.render(); // the selection becomes an option
        else input.value = expr;
        this.schedule();
      });
    });
    this.el.querySelector<HTMLSelectElement>(".add select")?.addEventListener("change", (e) => {
      const name = (e.target as HTMLSelectElement).value;
      if (!name) return;
      this.added.add(name);
      this.render();
      this.el.querySelector<HTMLInputElement>(`[data-field="${name}"] input`)?.focus();
    });
    this.el.querySelector<HTMLButtonElement>(".cancel")!.onclick = () => this.cancel();
    this.el.querySelector<HTMLButtonElement>(".primary")!.onclick = () => this.ok();
  }

  /** Set a field's expression; a flip of it follows (another sketch: flip that one instead). With the part's faces,
   * whose normals point out of the part, a flip with `inward` is on for the results that go into the part. */
  private assign(name: string, expr: string | null) {
    const fields = this.detail!.fields!;
    const flips = fields.filter((g) => g.type === "flip" && g.of === name && this.exprs.get(g.name) != null && this.exprs.get(g.name) === this.flipped(g));
    this.exprs.set(name, expr);
    for (const g of flips) this.exprs.set(g.name, this.flipped(g));
    for (const g of fields) {
      if (g.type !== "flip" || !g.inward || isSketch(this.exprs.get(g.of!) ?? null) || (name !== g.of && !(name in g.inward))) continue;
      const inward = Object.entries(g.inward).some(([k, vs]) => vs.includes(this.exprs.get(k) ?? ""));
      this.exprs.set(g.name, inward ? this.flipped(g) : null);
    }
  }

  /** A region clicked in the view: the sketch field becomes regions(sk1, ...) with that one added or removed. */
  private toggleRegion(field: string, r: SketchRegions, index: number) {
    if (!this.detail) return;
    const chosen = r.regions.filter((g, i) => (i === index ? !g.selected : g.selected));
    this.assign(field, `regions(${[r.name, ...chosen.map((g) => `(${g.at[0]}, ${g.at[1]})`)].join(", ")})`);
    this.render();
    this.schedule(0);
  }

  private row(f: FeatureField): string {
    const expr = this.exprs.get(f.name) ?? null;
    const changed = expr !== (f.expr ?? null);
    let input: string;
    const sketch = f.type === "sketch";
    if (sketch) { // the named sketches before this feature, or the pending ones
      const d = this.detail!;
      f = { ...f, type: "choice", options: [
        { label: d.pending.length ? `Pending: ${d.pending.join(", ")}` : "None" },
        ...d.sketches.map((n) => ({ expr: `${n}.sketch`, label: n })),
      ] };
      const some = expr?.match(/^regions\((\w+)/);
      if (some) {
        const n = (expr!.match(/\(\s*[-+\d.e]+\s*,\s*[-+\d.e]+\s*\)/g) ?? []).length;
        f.options!.push({ expr: expr!, label: `${some[1]}: ${n} region${n === 1 ? "" : "s"}` });
      } else if (!isSketch(expr)) f.options!.push({ expr: expr!, label: `Faces: ${expr}` });
    }
    if (f.type === "choice") {
      const opts = [...(f.options ?? [])];
      if (expr !== null && !opts.some((o) => (o.expr ?? null) === expr)) opts.push({ expr, label: expr });
      input = `<select>${opts.map((o) => `<option value="${esc(o.expr ?? "")}"${(o.expr ?? null) === expr ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
      if (f.pick || sketch) input += `<button class="use" title="Use the ${sketch ? "faces" : f.pick} selected in the view">Use selection</button>`;
    } else if (f.type === "bool" && (expr === null || expr === "True" || expr === "False")) {
      input = `<input type="checkbox"${expr === "True" ? " checked" : ""}>`;
    } else if (f.type === "flip" && (expr === null || expr === this.flipped(f))) {
      input = `<input type="checkbox"${expr !== null ? " checked" : ""}${this.flipped(f) ? "" : ' disabled title="Choose a sketch first"'}>`;
    } else {
      const placeholder = f.placeholder ?? (f.required ? "required" : f.default ?? "");
      input = `<input type="text" spellcheck="false" value="${esc(expr ?? "")}" placeholder="${esc(placeholder)}">`;
      if (f.type === "edges" || f.type === "faces") input += `<button class="use" title="Use the ${f.type} selected in the view">Use selection</button>`;
    }
    const value = changed ? "" : f.error ? `<span class="value error" title="${esc(f.error)}">${esc(f.error)}</span>`
      : f.value !== undefined && !["bool", "choice", "flip"].includes(f.type) && f.value !== expr ? `<span class="value">= ${esc(f.value)}</span>` : "";
    return `<div class="row" data-field="${esc(f.name)}" data-type="${f.type}"><label title="${esc(f.name)}">${esc(f.label)}</label><span class="input">${input}</span>${value}</div>`;
  }

  /** Arguments that differ from the code: {name: expression, or null to remove}. */
  private changes(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const f of this.detail!.fields!) {
      const shown = Object.entries(f.show_if ?? {}).every(([k, v]) => (this.exprs.get(k) ?? null) === (v ?? null));
      const now = shown ? this.exprs.get(f.name) ?? null : null; // hidden by another field (depth for through all): not written
      if (now !== (f.expr ?? null)) out[f.name] = now;
    }
    return out;
  }

  private schedule(delay = PREVIEW_DELAY_MS) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.preview(), delay);
  }

  /** Patch and build up to this feature without saving; show values of changed expressions. */
  private async preview() {
    const d = this.detail;
    if (!d) return;
    const seq = ++this.seq;
    const changes = this.changes();
    let src: string;
    try { src = await this.host.kernel.patchFeature(this.created?.src ?? this.host.source(), d.index, d.kind, changes); }
    catch (e) { if (seq === this.seq) this.say((e as Error).message, true); return; }
    // Closed or changed meanwhile: a stale preview build would replace the rebuild that OK started.
    if (seq !== this.seq) return;
    const error = await this.host.preview(src, d.index);
    if (seq !== this.seq || !this.detail) return;
    this.say(error ? `Preview: ${error}` : "", !!error);
    const sketch = d.fields!.find((f) => f.type === "sketch" && this.visible(f));
    const expr = sketch && isSketch(this.exprs.get(sketch.name) ?? null) ? this.exprs.get(sketch.name) : null;
    const regions = expr ? await this.host.kernel.sketchRegions(expr).catch(() => null) : null;
    if (seq !== this.seq || !this.detail) return;
    this.host.regions(regions?.regions.length ? regions : null, (i) => this.toggleRegion(sketch!.name, regions!, i));
    const edited = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== null)) as Record<string, string>;
    const values = Object.keys(edited).length ? await this.host.kernel.featureValues(edited) : {};
    if (seq !== this.seq || !this.detail) return;
    this.el.querySelectorAll<HTMLElement>("[data-field]").forEach((row) => {
      const v = values[row.dataset.field!];
      if (!v || ["bool", "choice", "flip"].includes(row.dataset.type!)) return;
      row.querySelector(".value")?.remove();
      const span = document.createElement("span");
      span.className = `value${v.error ? " error" : ""}`;
      span.textContent = v.error ?? `= ${v.value}`;
      if (v.error) span.title = v.error;
      row.append(span);
    });
  }

  private say(text: string, error = false) {
    const m = this.el.querySelector<HTMLElement>(".message");
    if (!m) return;
    m.hidden = !text;
    m.textContent = text;
    m.classList.toggle("error", error);
  }

  private async ok() {
    const d = this.detail;
    if (!d) return;
    const changes = this.changes();
    if (this.created && this.host.source() !== this.created.original) {
      this.say("The file changed while this dialog was open, so nothing was added. Cancel and try again.", true);
      return;
    }
    if (!this.created && !Object.keys(changes).length) { this.cancel(); return; }
    let src: string;
    // An edit patches the current source: if the file changed meanwhile, the kernel refuses unless the feature is still there.
    try { src = await this.host.kernel.patchFeature(this.created?.src ?? this.host.source(), d.index, d.kind, changes); }
    catch (e) { this.say((e as Error).message, true); return; }
    this.close();
    await this.host.apply(src);
  }

  cancel() {
    if (!this.detail) return;
    this.close();
    this.host.cancel();
  }

  private close() {
    this.host.regions(null, () => {});
    clearTimeout(this.timer);
    this.seq++;
    this.detail = null;
    this.created = null;
    this.el.hidden = true;
    this.el.replaceChildren();
  }
}
