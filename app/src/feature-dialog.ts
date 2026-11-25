// Feature dialog: edit a feature's arguments as expressions, with a live preview (docs/05-feature-model.md).
// The kernel reads the feature and patches only the changed arguments; this panel just shows fields.
import type { FeatureDetail, FeatureField, Kernel } from "./kernel";

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
};

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
      <div class="head"><b>${esc(title)}</b><span class="muted">feature ${d.index + 1}</span></div>
      <div class="fields">${fields.filter((f) => this.visible(f)).map((f) => this.row(f)).join("")}</div>
      ${hidden.length ? `<label class="add">Add argument <select><option value=""></option>${hidden.map((f) =>
        `<option value="${esc(f.name)}">${esc(f.label)}</option>`).join("")}</select></label>` : ""}
      <div class="message" hidden></div>
      <div class="actions"><button class="cancel">Cancel</button><button class="primary">OK</button></div>`;

    this.el.querySelectorAll<HTMLElement>("[data-field]").forEach((row) => {
      const name = row.dataset.field!;
      const input = row.querySelector<HTMLInputElement | HTMLSelectElement>("input, select")!;
      const read = () => input instanceof HTMLInputElement && input.type === "checkbox"
        ? (input.checked ? "True" : null)
        : (input.value.trim() || null);
      input.addEventListener(input instanceof HTMLSelectElement || input.type === "checkbox" ? "change" : "input", () => {
        this.exprs.set(name, read());
        if (input instanceof HTMLSelectElement || input.type === "checkbox") this.render(); // may show or hide fields
        this.schedule();
      });
      row.querySelector<HTMLButtonElement>(".use")?.addEventListener("click", () => {
        const kind = row.dataset.type === "faces" ? "face" : "edge";
        const sel = this.host.selection(kind);
        if (!sel) { this.say(`Select ${kind}s in the view first.`, true); return; }
        (input as HTMLInputElement).value = sel;
        this.exprs.set(name, sel);
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

  private row(f: FeatureField): string {
    const expr = this.exprs.get(f.name) ?? null;
    const changed = expr !== (f.expr ?? null);
    let input: string;
    if (f.type === "sketch") { // the named sketches before this feature, or the pending ones
      const d = this.detail!;
      f = { ...f, type: "choice", options: [
        { label: d.pending.length ? `Pending: ${d.pending.join(", ")}` : "None" },
        ...d.sketches.map((n) => ({ expr: `${n}.sketch`, label: n })),
      ] };
    }
    if (f.type === "choice") {
      const opts = [...(f.options ?? [])];
      if (expr !== null && !opts.some((o) => (o.expr ?? null) === expr)) opts.push({ expr, label: expr });
      input = `<select>${opts.map((o) => `<option value="${esc(o.expr ?? "")}"${(o.expr ?? null) === expr ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
    } else if (f.type === "bool" && (expr === null || expr === "True" || expr === "False")) {
      input = `<input type="checkbox"${expr === "True" ? " checked" : ""}>`;
    } else {
      const placeholder = f.type === "sketch" && this.detail!.pending.length ? `pending: ${this.detail!.pending.join(", ")}`
        : f.required ? "required" : f.default ?? "";
      input = `<input type="text" spellcheck="false" value="${esc(expr ?? "")}" placeholder="${esc(placeholder)}">`;
      if (f.type === "edges" || f.type === "faces") input += `<button class="use" title="Use the ${f.type} selected in the view">Use selection</button>`;
    }
    const value = changed ? "" : f.error ? `<span class="value error" title="${esc(f.error)}">${esc(f.error)}</span>`
      : f.value !== undefined && f.type !== "bool" && f.type !== "choice" && f.value !== expr ? `<span class="value">= ${esc(f.value)}</span>` : "";
    return `<div class="row" data-field="${esc(f.name)}" data-type="${f.type}"><label title="${esc(f.name)}">${esc(f.label)}</label><span class="input">${input}</span>${value}</div>`;
  }

  /** Arguments that differ from the code: {name: expression, or null to remove}. */
  private changes(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const f of this.detail!.fields!) {
      const now = this.exprs.get(f.name) ?? null;
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
    const error = await this.host.preview(src, d.index);
    if (seq !== this.seq || !this.detail) return;
    this.say(error ? `Preview: ${error}` : "", !!error);
    const edited = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== null)) as Record<string, string>;
    const values = Object.keys(edited).length ? await this.host.kernel.featureValues(edited) : {};
    if (seq !== this.seq || !this.detail) return;
    this.el.querySelectorAll<HTMLElement>("[data-field]").forEach((row) => {
      const v = values[row.dataset.field!];
      if (!v || row.dataset.type === "bool" || row.dataset.type === "choice") return;
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
    clearTimeout(this.timer);
    this.seq++;
    this.detail = null;
    this.created = null;
    this.el.hidden = true;
    this.el.replaceChildren();
  }
}
