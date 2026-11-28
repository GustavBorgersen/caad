// CAAD's own messages, menus, popovers and questions (docs/09: no system popups). Styled by style.css.
import { keyLabel, shortcuts } from "./commands";
import { icon, type IconName } from "./icons";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export { esc };

// --- Messages ---------------------------------------------------------------------------------------------

const MESSAGE_MS = 5000;
let messagesEl: HTMLElement | null = null;
export function mountMessages(el: HTMLElement) { messagesEl = el; }

/**
 * A short message at the bottom of the view, with at most one action (Undo). It fades after a few seconds, but stays
 * while the pointer is on it. A newer message replaces it.
 */
export function message(text: string, opts: { action?: string; run?: () => void; error?: boolean; ms?: number } = {}) {
  if (!messagesEl) return;
  const el = document.createElement("div");
  el.className = `message${opts.error ? " error" : ""}`;
  el.setAttribute("role", "status");
  el.append(Object.assign(document.createElement("span"), { textContent: text }));
  if (opts.action && opts.run) {
    const b = Object.assign(document.createElement("button"), { textContent: opts.action });
    b.onclick = () => { el.remove(); opts.run!(); };
    el.append(b);
  }
  messagesEl.replaceChildren(el);
  let timer = 0;
  const arm = () => { timer = window.setTimeout(() => el.remove(), opts.ms ?? (opts.action ? MESSAGE_MS * 1.6 : MESSAGE_MS)); };
  el.onmouseenter = () => clearTimeout(timer);
  el.onmouseleave = arm;
  arm();
}

/** The current message's text (tests). */
export const lastMessage = () => messagesEl?.textContent ?? "";

// --- Menus and popovers ---------------------------------------------------------------------------------------

export type MenuItem = { label: string; icon?: IconName; key?: string; meta?: string; danger?: boolean; disabled?: boolean; run: () => void } | "-";
export type MenuSection = { header?: string; items: MenuItem[] };

let openMenu: { el: HTMLElement; close: () => void } | null = null;

export function closeMenu() { openMenu?.close(); }

/** Place a floating element at (x, y) in the window, kept inside it. */
function place(el: HTMLElement, x: number, y: number) {
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
}

function floating(el: HTMLElement, onClose?: () => void) {
  closeMenu();
  const close = () => {
    el.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", key, true);
    if (openMenu?.el === el) openMenu = null;
    onClose?.();
  };
  const outside = (e: Event) => { if (!el.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    const items = [...el.querySelectorAll<HTMLButtonElement>("button.it:not(:disabled)")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  };
  document.addEventListener("keydown", key, true);
  setTimeout(() => document.addEventListener("pointerdown", outside, true)); // not the click that opened it
  openMenu = { el, close };
  return close;
}

function menuHtml(sections: MenuSection[]): string {
  return sections.map((s, i) => `${i ? "<hr>" : ""}${s.header ? `<div class="h">${esc(s.header)}</div>` : ""}${s.items.map((it, j) => it === "-" ? "<hr>"
    : `<button class="it${it.danger ? " danger" : ""}" data-i="${i}.${j}"${it.disabled ? " disabled" : ""}>${it.icon ? icon(it.icon) : '<span class="i"></span>'}` +
      `<span class="l">${esc(it.label)}</span>${it.meta ? `<span class="meta">${esc(it.meta)}</span>` : ""}${it.key ? `<kbd>${esc(keyLabel(it.key))}</kbd>` : ""}</button>`).join("")}`).join("");
}

/** A context menu at the pointer (or under an element). */
export function menu(at: { x: number; y: number } | HTMLElement, sections: MenuSection[], opts: { className?: string; onClose?: () => void } = {}) {
  const el = document.createElement("div");
  el.className = `menu${opts.className ? ` ${opts.className}` : ""}`;
  el.setAttribute("role", "menu");
  el.innerHTML = menuHtml(sections.filter((s) => s.items.length));
  const close = floating(el, opts.onClose);
  for (const b of el.querySelectorAll<HTMLButtonElement>("button.it")) {
    const [i, j] = b.dataset.i!.split(".").map(Number);
    const it = sections.filter((s) => s.items.length)[i].items[j] as Exclude<MenuItem, "-">;
    b.onclick = () => { close(); it.run(); };
  }
  if (at instanceof HTMLElement) { const r = at.getBoundingClientRect(); place(el, r.left, r.bottom + 4); }
  else place(el, at.x, at.y);
  el.querySelector<HTMLButtonElement>("button.it:not(:disabled)")?.focus({ preventScroll: true });
  return close;
}

/** A popover with any content under an element; returns its element and a close function. */
export function popover(anchor: HTMLElement, content: string | HTMLElement, className = ""): { el: HTMLElement; close: () => void } {
  const el = document.createElement("div");
  el.className = `menu popover${className ? ` ${className}` : ""}`;
  if (typeof content === "string") el.innerHTML = content; else el.append(content);
  const close = floating(el);
  const r = anchor.getBoundingClientRect();
  place(el, r.left, r.bottom + 4);
  return { el, close };
}

// --- The shortcut sheet --------------------------------------------------------------------------------------

export function shortcutSheet() {
  const el = document.createElement("div");
  el.className = "sheet";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Keyboard shortcuts");
  el.innerHTML = `<div class="sheet-card"><header>${icon("keyboard")}<b>Keyboard shortcuts</b><button class="icon-btn close" aria-label="Close">${icon("x")}</button></header>
    <div class="sheet-cols">${shortcuts().map((g) => `<section><h3>${esc(g.title)}</h3>${g.items.map(([k, l]) =>
      `<div class="row"><span>${esc(l)}</span><kbd>${esc(k)}</kbd></div>`).join("")}</section>`).join("")}</div>
    <p class="muted">Keys do nothing while you type in a field or the code.</p></div>`;
  const close = floating(el);
  el.querySelector<HTMLButtonElement>(".close")!.onclick = close;
  el.onclick = (e) => { if (e.target === el) close(); };
  document.body.append(el);
}

// --- Questions (docked, like every dialog) ----------------------------------------------------------------------

/** Ask a question in a docked panel (`el`); resolves true for OK. Enter answers OK, Esc Cancel. */
export function ask(el: HTMLElement, q: { title: string; icon?: IconName; text: string; ok: string; cancel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    el.innerHTML = `<header class="dlg-head">${q.icon ? icon(q.icon) : ""}<b>${esc(q.title)}</b></header>
      <div class="dlg-body"><p>${esc(q.text).replace(/\n\n/g, "</p><p>")}</p></div>
      <footer class="dlg-foot"><button class="btn cancel">${esc(q.cancel ?? "Cancel")} <kbd>Esc</kbd></button><button class="btn primary">${esc(q.ok)} <kbd>↵</kbd></button></footer>`;
    el.hidden = false;
    document.body.classList.add("docked");
    const done = (ok: boolean) => {
      el.hidden = true;
      el.replaceChildren();
      document.body.classList.remove("docked");
      window.removeEventListener("keydown", key, true);
      resolve(ok);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(e.key === "Enter"); }
    };
    window.addEventListener("keydown", key, true);
    el.querySelector<HTMLButtonElement>(".cancel")!.onclick = () => done(false);
    el.querySelector<HTMLButtonElement>(".primary")!.onclick = () => done(true);
    el.querySelector<HTMLButtonElement>(".primary")!.focus();
  });
}

// --- Inline naming (tree rows) ----------------------------------------------------------------------------------

/**
 * Turn `row` into an input for a name: `check` says what is wrong with a name (or null), `hint` what Enter will do.
 * Resolves with the name on Enter, null on Esc or leaving the field.
 */
export function inlineName(row: HTMLElement, opts: { value: string; suffix?: string; check: (name: string) => string | null; hint: (name: string) => string }): Promise<string | null> {
  return new Promise((resolve) => {
    const label = row.querySelector<HTMLElement>(".tn") ?? row;
    const box = document.createElement("span");
    box.className = "edit";
    const input = Object.assign(document.createElement("input"), { value: opts.value, spellcheck: false });
    input.setAttribute("aria-label", "Name");
    box.append(input);
    if (opts.suffix) box.append(Object.assign(document.createElement("span"), { className: "ext", textContent: opts.suffix }));
    label.replaceWith(box);
    row.classList.add("editing");
    const hint = document.createElement("div");
    hint.className = "hint";
    row.after(hint);
    const update = () => {
      const problem = opts.check(input.value.trim());
      box.classList.toggle("bad", !!problem);
      hint.classList.toggle("bad", !!problem);
      hint.innerHTML = problem ? esc(problem) : `${esc(opts.hint(input.value.trim()))} · <kbd>Esc</kbd> cancels`;
    };
    let finished = false;
    const finish = (name: string | null) => {
      if (finished) return;
      finished = true;
      hint.remove();
      box.replaceWith(label);
      row.classList.remove("editing");
      resolve(name);
    };
    input.oninput = update;
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !opts.check(input.value.trim())) finish(input.value.trim());
      else if (e.key === "Escape") finish(null);
    };
    input.onblur = () => setTimeout(() => finish(null), 100);
    update();
    input.focus();
    input.select();
  });
}
