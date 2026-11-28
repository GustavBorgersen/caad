// Commands (docs/09-design-and-workflow.md): every action is a command in one registry; the toolbar, the
// shortcuts, the tooltips, the context menus and the shortcut sheet are built from it, so they can't drift apart.
import { icon, type IconName } from "./icons";

export type Mode = "part" | "sketch";

export type Command = {
  id: string;
  label: string;
  icon?: IconName;
  /** A single key (lower case) or a chord like "ctrl+z"; shown in tooltips, menus and the sheet. */
  key?: string;
  /** The mode it belongs to; none: everywhere. */
  mode?: Mode;
  /** In the mode's toolbar, in this group (groups are separated); the primary one closes the toolbar, filled. */
  toolbar?: "main" | "more" | "primary";
  /** A second key for a command (Ctrl+Shift+Z for redo): works, but isn't listed in the shortcut sheet. */
  alias?: boolean;
  /** A longer description for the tooltip. */
  title?: string;
  /** Can it run now? Disabled commands show greyed and their keys do nothing. */
  enabled?: () => boolean;
  /** Shown as on (the current tool). */
  active?: () => boolean;
  /** `anchor`: the element it was started from (a toolbar button), for commands that open a popover. */
  run: (anchor?: HTMLElement) => void;
};

const commands = new Map<string, Command>();
let mode: Mode = "part";
let toolbarEl: HTMLElement | null = null;
const changed = new Set<() => void>();

export function register(...cs: Command[]) { for (const c of cs) commands.set(c.id, c); refresh(); }
export const command = (id: string) => commands.get(id);
export const currentMode = () => mode;
export function setMode(m: Mode) { mode = m; refresh(); }
/** Called whenever the toolbar was redrawn (mode, enabled or active states changed). */
export function onCommandsChange(f: () => void) { changed.add(f); }

const available = (c: Command) => !c.mode || c.mode === mode;
const enabled = (c: Command) => available(c) && (c.enabled?.() ?? true);

/** Run a command by id if it can run now; returns whether it ran. */
export function run(id: string, anchor?: HTMLElement): boolean {
  const c = commands.get(id);
  if (!c || !enabled(c)) return false;
  c.run(anchor);
  return true;
}

/** "Ctrl+Z", "D", "?": a key as people read it. */
export function keyLabel(key: string): string {
  return key.split("+").map((k) => k === "ctrl" ? (navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl") : k === "shift" ? "Shift"
    : k === "delete" ? "Delete" : k === "escape" ? "Esc" : k === "enter" ? "Enter" : k.length === 1 || /^f\d+$/.test(k) ? k.toUpperCase() : k).join("+");
}

/** The tooltip for a command: its name and key, then its description. */
export function tooltip(c: Command): string {
  return `${c.label}${c.key ? ` · ${keyLabel(c.key)}` : ""}${c.title ? `\n${c.title}` : ""}`;
}

// --- The toolbar ----------------------------------------------------------------------------------------

export function mountToolbar(el: HTMLElement) { toolbarEl = el; refresh(); }

/** Redraw the toolbar (the mode's commands, their enabled and active states). Cheap: call after state changes. */
export function refresh() {
  if (toolbarEl) {
    const groups: Command["toolbar"][] = ["main", "more", "primary"];
    const html = groups.map((g) => [...commands.values()].filter((c) => c.toolbar === g && available(c)).map((c) =>
      `<button class="tool${g === "primary" ? " primary" : ""}${c.active?.() ? " on" : ""}" data-command="${c.id}"${c.id.startsWith("tool-") ? ` data-tool="${c.id.slice(5)}"` : ""}` +
      `${enabled(c) ? "" : " disabled"} aria-pressed="${!!c.active?.()}" title="${tooltip(c).replace(/"/g, "&quot;")}">${c.icon ? icon(c.icon) : ""}<span>${c.label}</span></button>`).join(""))
      .filter(Boolean).join('<span class="tool-sep"></span>');
    if (toolbarEl.dataset.html !== html) { // keep the buttons (and their focus) when nothing changed
      toolbarEl.innerHTML = html;
      toolbarEl.dataset.html = html;
      toolbarEl.dataset.mode = mode;
      for (const b of toolbarEl.querySelectorAll<HTMLButtonElement>("[data-command]")) b.onclick = () => run(b.dataset.command!, b);
    }
  }
  for (const f of changed) f();
}

// --- Keys -------------------------------------------------------------------------------------------------

/** Typing in a field or the code: keys are text there, not commands. */
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest(".cm-editor"));

function chord(e: KeyboardEvent): string {
  const k = e.key === " " ? "space" : e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  return `${ctrl ? "ctrl+" : ""}${ctrl && e.shiftKey ? "shift+" : ""}${e.altKey ? "alt+" : ""}${k}`; // Shift is in the character otherwise (?)
}

window.addEventListener("keydown", (e) => {
  if (typing(e.target) || e.defaultPrevented) return;
  const k = chord(e);
  // The mode's own command first, then one for every mode.
  const c = [...commands.values()].filter((x) => x.key === k && available(x)).sort((a, b) => (b.mode ? 1 : 0) - (a.mode ? 1 : 0))[0];
  if (!c) return;
  e.preventDefault();
  if (enabled(c)) c.run();
});

// --- The shortcut sheet (?) ----------------------------------------------------------------------------------

/** All commands with keys, by mode: the content of the shortcut sheet. */
export function shortcuts(): { title: string; items: [string, string][] }[] {
  const of = (m: Mode | undefined) => [...commands.values()].filter((c) => c.key && c.mode === m && !c.alias).map((c): [string, string] => [keyLabel(c.key!), c.label]);
  return [{ title: "Everywhere", items: of(undefined) }, { title: "Part", items: of("part") }, { title: "Sketch", items: of("sketch") }]
    .filter((g) => g.items.length);
}
