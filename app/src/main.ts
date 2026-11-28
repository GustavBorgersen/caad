import "./style.css";
import { Agents, localAccess } from "./agent";
import { setupAgentDialog } from "./agent-dialog";
import { command, currentMode, mountToolbar, refresh as refreshCommands, register, run, setMode, tooltip, type Command } from "./commands";
import { Editor } from "./editor";
import { FeatureDialog } from "./feature-dialog";
import { FilesPanel, PY_NAME } from "./files";
import { History } from "./history";
import { icon } from "./icons";
import { Kernel, type BuildResult, type Feature, type Kind, type SelectInfo } from "./kernel";
import { canOpenFolders, canReopen, examples, forgetFolder, indexWorkspace, openFolder, projectFile, projectOf, recentFolders, rememberFolder, reopen,
  type Recent, type ScannedFile, type Workspace, type WorkspaceIndex } from "./project";
import { RegionPicker } from "./regions";
import { renderSelection } from "./selection";
import { newPartSource } from "./sketch-code";
import { Sketcher, TOOLS } from "./sketcher";
import { setTheme, themeChoice, type ThemeChoice } from "./theme";
import { focusedFeature, markCursor, renderTimeline, type AddKind } from "./timeline";
import { makeTools } from "./tools";
import { ask, esc, inlineName, lastMessage, menu, message, mountMessages, popover, shortcutSheet, type MenuSection } from "./ui";
import { ViewCube } from "./viewcube";
import { Viewer, type Pick } from "./viewer";
import * as THREE from "three";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const POLL_MS = 1000;
const SAVE_DELAY_MS = 500;

setTheme();
mountMessages($("messages"));
const kernel = new Kernel();
const viewer = new Viewer($("view"));
new ViewCube($("viewcube"), viewer);
const editor = new Editor($("editor"));
const history = new History();

const state = {
  workspace: null as Workspace | null,
  files: [] as ScannedFile[], // the workspace's last scan
  index: { projects: [], loose: [] } as WorkspaceIndex,
  watched: new Map<string, number>(), // the open project's other .py files: their last-modified times
  path: null as string | null,
  upto: null as number | null,
  modified: 0, // last-modified time of the open file as we last saw or wrote it
  saved: "", // the open file's text as last saved (typing is recorded in the history from here)
  result: null as BuildResult | null,
  fitNext: true,
  // The current selection, as the best selector per kind: re-resolved after every rebuild.
  selection: [] as SelectInfo[],
  failed: new Set<string>(), // parts whose last build this session failed
  agent: new Map<string, Set<string>>(), // per file: the text of the features the agent changed, until you change the file
  active: null as number | null, // the feature being edited (dialog or sketch)
  cursorFeature: null as number | null, // the feature the cursor in the code is in
  cursorLine: null as number | null, // the line it is on, while the code has the focus
  timelineStale: false, // a build came in while a row's name was being typed: redraw the timeline after it
};

/** A hint, a result or an error: CAAD's own message at the bottom of the view (no popups). */
const say = (text: string, error = false) => message(text, { error });

// --- Status ---------------------------------------------------------------------------------------------------

kernel.onStatus = (text) => { $("overlay").textContent = text; $("overlay").hidden = false; };
kernel.onReady = (s) => {
  $("overlay").hidden = true;
  $("status").title = `CAD kernel ready in ${s.toFixed(0)} s`;
  // No rebuild here: opening a part always builds it, and a build sent before the kernel is ready waits in the
  // worker and runs once it is. Rebuilding here built the part twice at start-up (#3).
};

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 2 : n < 100 ? 1 : 0 });

/** The status line: the file, whether it built, its volume and size; the timings in its tooltip. */
function statusLine(r: BuildResult | null, ms?: number) {
  const el = $("status");
  if (!state.path) { el.innerHTML = ""; el.dataset.state = ""; return; }
  const file = esc(state.path.split("/").pop()!);
  if (!r) { el.innerHTML = `<b>${file}</b>`; el.dataset.state = ""; return; }
  const bb = r.summary?.bbox;
  const size = bb ? `${fmt(bb[3] - bb[0])} × ${fmt(bb[4] - bb[1])} × ${fmt(bb[5] - bb[2])} mm` : "";
  const parts = [`<span><b>${file}</b> · ${r.ok ? "built" : '<span class="bad">failed</span>'}</span>`];
  if (r.summary?.volume) parts.push(`<span>${fmt(r.summary.volume)} mm³</span>`);
  if (size) parts.push(`<span>${size}</span>`);
  if (r.upto != null && r.upto < (r.timeline?.features.length ?? 0) - 1) parts.push(`<span>rolled back to feature ${r.upto + 1}</span>`);
  el.innerHTML = parts.join("");
  el.dataset.state = r.ok ? "built" : "failed";
  el.title = `${r.ok ? "Built" : "Failed"}${ms !== undefined ? ` in ${ms} ms` : ""} (Python ${r.times.build} s, mesh ${r.times.mesh} s)`;
}

// --- Building ---------------------------------------------------------------------------------------------------

async function rebuild(): Promise<BuildResult | null> {
  if (!state.path) return null;
  if (!state.path.endsWith(".py")) { showNotPart(); return null; }
  const t = performance.now();
  let r: BuildResult | null;
  try { r = await kernel.build(editor.text, state.path, state.upto); }
  catch (e) { say("Kernel error: " + (e as Error).message, true); return null; }
  if (!r) return null; // replaced by a newer build
  state.result = r;
  viewer.setMesh(r.mesh, state.fitNext && !!r.mesh);
  viewer.setSketches(r.sketches, state.fitNext && !r.mesh); // a part with only sketches: frame those
  viewer.setPlanes(r.planes);
  if (r.mesh || r.sketches.length) state.fitNext = false;
  restoreSelection(r.gen);
  const wasFailed = state.failed.has(state.path);
  if (r.ok) state.failed.delete(state.path); else if (r.timeline?.part) state.failed.add(state.path);
  if (wasFailed !== state.failed.has(state.path)) files.render();
  showTimeline();
  showParams(r);
  editor.markError(r.error?.line ?? null);
  const err = $("error");
  err.hidden = !r.error;
  err.textContent = r.error ? `Line ${r.error.line ?? "?"}: ${r.error.message}` : "";
  statusLine(r, Math.round(performance.now() - t));
  refreshCommands();
  return r;
}

/** A file that isn't Python (pyproject.toml): its text in the code pane, nothing to build. */
function showNotPart() {
  state.result = null;
  viewer.setMesh(null, false);
  viewer.setSketches([], false);
  viewer.setPlanes([]);
  $("timeline").innerHTML = `<li class="timeline-empty">${esc(state.path!.split("/").pop()!)} isn't a part: edit it in the code.</li>`;
  $("params").replaceChildren();
  editor.markError(null);
  $("error").hidden = true;
  const el = $("status");
  el.innerHTML = `<span><b>${esc(state.path!.split("/").pop()!)}</b> · project file</span>`;
  el.dataset.state = "built";
  refreshCommands();
}

function featureText(src: string, f: Feature): string {
  return src.split("\n").slice(f.line - 1, f.end).filter((l) => l.trim()).join("\n");
}

/** The timeline, with the agent's marks and the feature being edited. */
function showTimeline() {
  // Not while a row's name is being typed: redrawing would take the field away. Renaming redraws when it ends.
  if ($("timeline").querySelector("li.editing")) { state.timelineStale = true; return; }
  state.timelineStale = false;
  const r = state.result;
  const feats = r?.timeline?.features ?? [];
  const marked = state.path ? state.agent.get(state.path) : undefined;
  const agent = new Set(marked ? feats.filter((f) => marked.has(featureText(editor.text, f))).map((f) => f.index) : []);
  editor.markAgent(feats.filter((f) => agent.has(f.index)).map((f) => [f.line, f.end]));
  renderTimeline($("timeline"), r, {
    rollback: (upto) => { if (!featureDialog.open && !sketcher.active) { state.upto = upto; rebuild(); } },
    hover: (f) => editor.markFeature(f ? [f.line, f.end] : null, !!f),
    edit: (f) => editFeature(f),
    remove: (f) => removeFeature(f),
    menu: (f, at) => timelineMenu(f, at),
  }, { agent, active: state.active, cursor: (state.cursorFeature = featureAtLine(state.cursorLine)) }); // lines move as the code changes
}

/** The part's parameters at the foot of the timeline: edit a value, and that line of the code changes. */
function showParams(r: BuildResult) {
  const el = $("params");
  const ps = r.params ?? [];
  if (!ps.length) { el.replaceChildren(); return; }
  if (el.contains(document.activeElement)) return; // don't replace the field being typed in
  el.innerHTML = `<div class="section-label">Parameters</div>` + ps.map((p) =>
    `<div class="param" title="${esc(p.name)} = ${esc(p.expr)} (line ${p.line})"><label for="param-${esc(p.name)}">${esc(p.name)}</label>` +
    `<input id="param-${esc(p.name)}" data-param="${esc(p.name)}" value="${esc(p.expr)}" spellcheck="false">` +
    `${String(p.value) !== p.expr.trim() ? `<span class="val">= ${fmt(p.value)}</span>` : ""}</div>`).join("");
  for (const input of el.querySelectorAll<HTMLInputElement>("input[data-param]")) {
    const before = input.value;
    const commit = async () => {
      const expr = input.value.trim();
      if (!expr || expr === before || !state.path) return;
      try {
        const src = await kernel.patchParam(editor.text, input.dataset.param!, expr);
        input.classList.remove("bad");
        await applyCode(state.path, src, `${input.dataset.param} = ${expr}`);
      } catch (e) { input.classList.add("bad"); say((e as Error).message.replace(/^\w*Error: /, ""), true); }
    };
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } else if (e.key === "Escape") { input.value = before; input.blur(); } };
    input.onchange = commit;
  }
}

// --- Selection ---------------------------------------------------------------------------------------------------

async function describeSelection(picks: { kind: Kind; index: number }[]) {
  const gen = state.result?.gen;
  const infos: SelectInfo[] = [];
  for (const kind of ["face", "edge"] as Kind[]) {
    const idx = picks.filter((p) => p.kind === kind).map((p) => p.index);
    if (idx.length) infos.push(await kernel.select(kind, idx));
  }
  if (gen !== state.result?.gen || infos.some((i) => i.gen !== gen)) return; // the model changed meanwhile
  state.selection = infos;
  renderSelection($("selection"), infos);
  refreshCommands();
}

function clearSelection() {
  viewer.setSelection([]);
  state.selection = [];
  renderSelection($("selection"), []);
  refreshCommands();
}

viewer.onSelect = (picks: Pick[]) => {
  $("agent-note").hidden = true; // a click replaces the agent's highlight
  if (!picks.length) { clearSelection(); return; }
  describeSelection(picks);
};

/** After a rebuild, find the selected geometry again through its selectors. */
async function restoreSelection(gen: number) {
  const keep = state.selection.filter((i) => i.selectors.length);
  if (!keep.length) { renderSelection($("selection"), []); return; }
  const picks: { kind: Kind; index: number }[] = [];
  for (const info of keep) {
    const kind = info.items[0].kind;
    const r = await kernel.resolve(kind, info.selectors[0].expr);
    if (r.gen !== gen) return; // another rebuild already happened
    picks.push(...r.value.map((index) => ({ kind, index })));
  }
  viewer.setSelection(picks);
  if (picks.length) describeSelection(picks);
  else { state.selection = []; renderSelection($("selection"), []); }
}

/** Best selector for the selection, when everything selected is of this kind. */
function selected(kind: Kind): string | null {
  const [info, ...more] = state.selection;
  return info && !more.length && info.items[0]?.kind === kind ? info.selectors[0]?.expr ?? null : null;
}
const selectedFlatFace = () => {
  const items = state.selection.flatMap((i) => i.items);
  return items.length === 1 && items[0].kind === "face" && items[0].type === "PLANE" ? state.selection[0].selectors[0]?.expr ?? null : null;
};

// --- Workspace and projects (docs/07-project-structure.md) ---------------------------------------------------------

/** Open a workspace: the remembered choice for the next start-up, its first part opened. */
async function setWorkspace(ws: Workspace, handle?: FileSystemDirectoryHandle) {
  state.workspace = ws;
  state.path = null;
  history.clear();
  state.agent.clear();
  state.failed.clear();
  document.body.classList.remove("no-workspace");
  $("start").hidden = true;
  try { localStorage.setItem("caad.last", ws.writable ? "folder" : "examples"); } catch { /* private window */ }
  await refreshBrowser();
  if (handle) rememberFolder(handle, state.index.projects.length);
  renderWorkspaceBox();
  const first = state.index.projects.flatMap((p) => p.files).find((f) => f.kind === "part") ?? state.index.loose[0];
  if (first) await openPart(first.path);
  else { crumb(); statusLine(null); showTimeline(); setTab("files"); }
}

function renderWorkspaceBox() {
  const ws = state.workspace;
  const n = state.index.projects.length;
  $("workspace").innerHTML = ws ? `${icon(ws.writable ? "folder" : "lock")}<span class="ws-text"><b>${esc(ws.name)}</b><small>${ws.writable ? "workspace" : "bundled"} · ${n} project${n === 1 ? "" : "s"}</small></span>${icon("swap", "sw")}` : "";
  $("files-foot").innerHTML = ws ? (ws.writable ? `${icon("check")}Saved to disk as you work` : `${icon("lock")}Examples: edits stay in this page`) : "";
}

/** Scan the workspace: its projects and their files by kind. */
async function refreshBrowser() {
  const ws = state.workspace;
  state.files = ws ? await ws.scan() : [];
  state.index = indexWorkspace(state.files, ws?.name ?? "");
  files.render();
  renderWorkspaceBox();
}

/** The project and part in the top bar. */
function crumb() {
  const ws = state.workspace, path = state.path;
  const project = path ? projectOf(state.index, path) : undefined;
  $("crumb").innerHTML = ws ? `${icon("folder")}<b>${esc(project?.name ?? ws.name)}</b>${path ? `<span>/</span><span>${esc(path.split("/").pop()!)}</span>` : ""}${icon("down")}`
    : `${icon("folder")}<span>No folder open</span>`;
}

const files = new FilesPanel($("parts"), {
  workspace: () => state.workspace,
  index: () => state.index,
  paths: () => state.files.map((f) => f.path),
  path: () => state.path,
  failed: () => state.failed,
  agentChanged: () => new Set([...state.agent].filter(([, v]) => v.size).map(([k]) => k)),
  open: (path) => { if (path !== state.path) openPart(path); },
  download: (path) => download(path),
  create: async (path, text) => { await applyCode(path, text, "New file"); },
  refresh: () => refreshBrowser(),
  moved: (from, to) => onMoved(from, to),
  newProject: () => newProjectDialog(),
  makeProject: (folder) => makeProject(folder),
  async recents() {
    const list = await recentFolders();
    return Promise.all(list.map(async (r) => ({ ...r, ready: await canReopen(r.handle) })));
  },
  switchTo: (c) => switchWorkspace(c),
  forget: (name) => forgetFolder(name),
  exportPart: async (path, format) => { if (path !== state.path) await openPart(path); runExport(format); },
  newPartSource,
});

/** A file or folder was renamed (`to`) or deleted (null): the open file, its history and its marks follow it. */
async function onMoved(from: string, to: string | null) {
  history.move(from, to);
  const follow = (p: string) => p === from ? to : p.startsWith(from + "/") ? (to ? to + p.slice(from.length) : null) : p;
  for (const set of [state.failed]) for (const p of [...set]) { const q = follow(p); set.delete(p); if (q) set.add(q); }
  for (const [p, v] of [...state.agent]) { const q = follow(p); state.agent.delete(p); if (q) state.agent.set(q, v); }
  if (state.path && follow(state.path) !== state.path) {
    const q = follow(state.path);
    if (q) { state.path = q; crumb(); $("file-name").textContent = q; await refreshBrowser(); await syncProject(q); rebuild(); } // its module name changed
    else { state.path = null; await refreshBrowser(); const next = state.index.projects.flatMap((p) => p.files).find((f) => f.kind === "part"); if (next) await openPart(next.path); else closePart(); }
  }
}

function closePart() {
  state.path = null;
  state.result = null;
  editor.setText("");
  viewer.setMesh(null, false);
  viewer.setSketches([], false);
  viewer.setPlanes([]);
  crumb();
  statusLine(null);
  showTimeline();
  $("params").replaceChildren();
  files.render();
  refreshCommands();
}

async function switchWorkspace(c: { recent?: Recent; examples?: true; pick?: true }) {
  try {
    if (c.examples) await setWorkspace(examples());
    else if (c.recent) {
      const ws = await reopen(c.recent.handle);
      if (ws) await setWorkspace(ws, c.recent.handle);
      else say(`The browser didn't allow CAAD to use ${c.recent.name}.`, true);
    } else if (c.pick) {
      if (!canOpenFolders()) { say(isSecureContext ? "Opening folders needs Chrome or Edge (File System Access API)." : "Opening folders needs the page over https:// (or on localhost).", true); return; }
      const { workspace, handle } = await openFolder();
      await setWorkspace(workspace, handle);
    }
  } catch (e) { if ((e as Error).name !== "AbortError") say(String((e as Error).message ?? e), true); }
}

/** The open part's project's .py files go into the kernel, so parts can import shared code. */
async function syncProject(path: string) {
  const ws = state.workspace;
  const project = projectOf(state.index, path);
  const files: Record<string, string> = {};
  state.watched = new Map();
  if (ws && project) {
    for (const f of state.files) {
      if (!f.path.endsWith(".py") || (project.root && !f.path.startsWith(project.root + "/"))) continue;
      try {
        files[project.root ? f.path.slice(project.root.length + 1) : f.path] = await ws.read(f.path);
        if (f.path !== path) state.watched.set(f.path, await ws.modified(f.path));
      } catch { /* removed since the scan */ }
    }
  }
  await kernel.setProject(files);
}

/**
 * Export the open part (all its features) as STEP or STL into its project's exports/, where the browser lists it
 * (click to download). A part in no project downloads directly.
 */
async function exportPart(format: "step" | "stl"): Promise<{ path?: string; bytes: number; summary: NonNullable<BuildResult["summary"]> }> {
  const ws = state.workspace, path = state.path;
  if (!ws || !path) throw new Error("No part is open.");
  if (!(await kernel.whenReady(100_000))) throw new Error("The CAD kernel is still loading.");
  const r = await kernel.exportPart(editor.text, path, format);
  const name = `${path.split("/").pop()!.replace(/\.py$/, "")}.${format}`;
  const project = projectOf(state.index, path);
  if (!project) {
    saveAs(new Blob([r.data as Uint8Array<ArrayBuffer>]), name);
    return { bytes: r.data.length, summary: r.summary };
  }
  const out = `${project.root ? `${project.root}/` : ""}exports/${name}`;
  await ws.writeBytes(out, r.data);
  await refreshBrowser();
  return { path: out, bytes: r.data.length, summary: r.summary };
}

async function runExport(format: "step" | "stl") {
  say(`Exporting ${format.toUpperCase()}…`);
  try {
    const r = await exportPart(format);
    if (r.path) message(`Exported ${r.path} (${Math.ceil(r.bytes / 1000)} kB)`, { action: "Download", run: () => download(r.path!) });
    else say(`Downloaded the ${format.toUpperCase()} file.`);
  } catch (e) { say((e as Error).message, true); }
}

function saveAs(blob: Blob, name: string) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function download(path: string) {
  if (state.workspace) saveAs(await state.workspace.blob(path), path.split("/").pop()!);
}

async function openPart(path: string, rollback: number | null = null): Promise<BuildResult | null> {
  if (!state.workspace) return null;
  if (sketcher.active) sketcher.cancel();
  if (featureDialog.open) featureDialog.cancel();
  flushTyping();
  state.path = path;
  state.upto = rollback;
  state.fitNext = true;
  state.selection = [];
  state.result = null;
  renderSelection($("selection"), []);
  files.render();
  crumb();
  $("file-name").textContent = path;
  const text = await state.workspace.read(path);
  editor.setText(text);
  state.saved = text;
  $("code-lines").textContent = `${text.split("\n").length} lines`;
  state.modified = await state.workspace.modified(path);
  if (!path.endsWith(".py")) { showCode(true); showNotPart(); return null; }
  statusLine(null);
  await syncProject(path);
  return rebuild();
}

/**
 * New source for a file (from a dialog, the sketch editor, the agent, a new part): save it, record it in the history
 * (`label` names the change for Undo), show it and rebuild. The agent's changes are marked in the timeline.
 */
async function applyCode(path: string, code: string, label = "Edit", agent = false): Promise<BuildResult | null> {
  if (!state.workspace) return null;
  const isNew = !state.files.some((f) => f.path === path);
  const before = path === state.path ? editor.text : isNew ? null : await state.workspace.read(path).catch(() => null);
  if (before !== null) history.record(path, before, code, label);
  // The agent's marks: the features whose text this change made. Your own change of the file clears them.
  if (agent && before !== null) {
    const old = new Set(analyzeTexts(before));
    const fresh = analyzeTexts(code).filter((t) => !old.has(t));
    state.agent.set(path, new Set([...(state.agent.get(path) ?? []), ...fresh]));
  } else if (agent) state.agent.set(path, new Set(analyzeTexts(code)));
  else state.agent.delete(path);
  await state.workspace.write(path, code);
  if (isNew) await refreshBrowser();
  else if (agent) files.render();
  if (path !== state.path) return openPart(path);
  clearTimeout(saveTimer); // this version replaces any unsaved typing
  saveTimer = 0;
  editor.setText(code);
  state.saved = code;
  state.modified = await state.workspace.modified(path);
  refreshUndo();
  return rebuild();
}

/** Feature statements' texts, roughly (top-level statements of the part's block): to see what the agent changed. */
function analyzeTexts(src: string): string[] {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => /^with\s+BuildPart\s*\(/.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  let cur: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break;
    if (/^ {4}\S/.test(l) && cur.length && !/^\s*[)\]}]/.test(l)) { out.push(cur.join("\n")); cur = []; }
    if (l.trim()) cur.push(l);
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

/** New project: a docked dialog with the name, the first part and what it will write. */
function newProjectDialog() {
  const ws = state.workspace;
  if (!ws) return;
  if (state.index.projects.some((p) => p.root === "")) { say("This folder is itself a project: open its parent folder to add projects next to it.", true); return; }
  const el = $("project-panel");
  const taken = new Set(state.files.map((f) => f.path.split("/")[0]));
  let name = "my-project";
  for (let i = 2; taken.has(name); i++) name = `my-project-${i}`;
  el.innerHTML = `<header class="dlg-head">${icon("folder")}<b>New project</b><span class="sub">in ${esc(ws.name)}/</span></header>
    <label class="field-label" for="np-name">Name</label><div class="dlg-body"><input type="text" id="np-name" spellcheck="false" value="${esc(name)}"></div>
    <div class="field-msg" id="np-name-msg"></div>
    <label class="field-label" for="np-part">First part</label><div class="dlg-body"><input type="text" id="np-part" spellcheck="false" value="part"></div>
    <div class="field-msg" id="np-part-msg"></div>
    <label class="check-row"><input type="checkbox" id="np-params" checked>Shared parameters (params.py)</label>
    <span class="field-label">Creates</span><div class="preview-tree" id="np-preview"></div>
    <p class="dlg-body muted">A project is a folder with a pyproject.toml; its parts can import params.py.</p>
    <div class="spacer"></div>
    <footer class="dlg-foot"><button class="btn cancel">Cancel <kbd>Esc</kbd></button><button class="btn primary">Create <kbd>↵</kbd></button></footer>`;
  el.hidden = false;
  setTab("files");
  const [nameIn, partIn, params] = [$<HTMLInputElement>("np-name"), $<HTMLInputElement>("np-part"), $<HTMLInputElement>("np-params")];
  const check = () => {
    const n = nameIn.value.trim(), p = partIn.value.trim();
    const nm = !n ? "Type a name." : !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(n) ? "Letters, digits, - and _." : taken.has(n) ? `${n}/ already exists.` : null;
    const pm = !p ? "Type a name." : !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p) ? "A Python name: letters, digits and _ (no -, not starting with a digit)." : null;
    $("np-name-msg").textContent = nm ?? "";
    $("np-name-msg").className = `field-msg${nm ? " bad" : ""}`;
    $("np-part-msg").textContent = pm ?? "";
    $("np-part-msg").className = `field-msg${pm ? " bad" : ""}`;
    $("np-preview").innerHTML = `<b>${esc(n || "…")}/</b>\n ├ <span class="new">pyproject.toml</span>${params.checked ? '\n ├ <span class="new">params.py</span>' : ""}\n └ parts/\n    └ <span class="new">${esc(p || "…")}.py</span>`;
    el.querySelector<HTMLButtonElement>(".primary")!.disabled = !!(nm || pm);
    return !(nm || pm);
  };
  const close = () => { el.hidden = true; el.replaceChildren(); };
  const create = async () => {
    if (!check()) return;
    const n = nameIn.value.trim(), p = partIn.value.trim();
    close();
    await ws.write(`${n}/pyproject.toml`, projectFile(n));
    if (params.checked) await ws.write(`${n}/params.py`, `"""Parameters shared by the parts of ${n}: \`from params import *\` in a part."""\n`);
    await ws.write(`${n}/parts/${p}.py`, newPartSource(p));
    await refreshBrowser();
    await openPart(`${n}/parts/${p}.py`);
    message(`Created project ${n}: press S to sketch`, { action: "Undo", run: async () => { await ws.remove(n); await onMoved(n, null); await refreshBrowser(); } });
  };
  nameIn.oninput = partIn.oninput = params.onchange = check;
  el.onkeydown = (e) => { if (e.key === "Escape") close(); else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") { e.preventDefault(); create(); } };
  el.querySelector<HTMLButtonElement>(".cancel")!.onclick = close;
  el.querySelector<HTMLButtonElement>(".primary")!.onclick = create;
  check();
  nameIn.focus();
  nameIn.select();
}

/** Make a folder of loose build123d files a project: only adds the project file (or its [tool.caad] table). */
async function makeProject(folder: string) {
  const ws = state.workspace;
  if (!ws) return;
  const path = folder ? `${folder}/pyproject.toml` : "pyproject.toml";
  const existing = state.files.find((f) => f.path === path);
  const name = (folder.split("/").pop() || ws.name).replace(/[^A-Za-z0-9_-]/g, "-");
  await ws.write(path, existing ? `${(existing.text ?? "").trimEnd()}\n\n[tool.caad]\nformat = 1\n` : projectFile(name));
  await refreshBrowser();
  say(`${folder || ws.name} is a CAAD project now (${path}).`);
}

// --- Editing features (docs/05-feature-model.md) ---------------------------------------------------------------------

// Where the rollback bar goes when the dialog closes (a new feature moves it one down).
let editReturn: { ok: number | null; cancel: number | null } = { ok: null, cancel: null };

const featureDialog = new FeatureDialog($("feature-panel"), {
  kernel,
  source: () => editor.text,
  async preview(src, upto) {
    if (!featureDialog.open) return null; // never replace the rebuild of the saved code
    const r = await kernel.build(src, state.path!, upto);
    if (!r || !featureDialog.open) return null; // replaced by a newer build, or the dialog closed meanwhile
    state.result = { ...r, preview: true }; // what the view shows, so picking edges for the dialog works
    viewer.setMesh(r.mesh, false, true);
    viewer.setSketches(r.sketches, false);
    viewer.setPlanes(r.planes);
    statusLine(r);
    $("status").insertAdjacentHTML("afterbegin", "<span>Previewing</span>");
    return r.error?.message ?? null;
  },
  async apply(src) {
    endEditing();
    state.upto = editReturn.ok;
    if (state.path) await applyCode(state.path, src, editLabel);
  },
  cancel() {
    endEditing();
    state.upto = editReturn.cancel;
    rebuild();
  },
  selection: selected,
  regions(r, toggle) {
    if (regionPicker) { regionPicker.dispose(); if (viewer.tool === regionPicker) viewer.tool = null; }
    regionPicker = r ? new RegionPicker(viewer, r.regions, toggle) : null;
    if (regionPicker) viewer.tool = regionPicker;
  },
});
let regionPicker: RegionPicker | null = null;
let editLabel = "Edit";

function endEditing() {
  document.body.classList.remove("editing-feature");
  viewer.setPreviewBase(null);
  state.active = null;
  refreshCommands();
}

/** Double-click in the timeline: roll back to just before the feature and open its dialog. */
async function editFeature(f: Feature) {
  if (featureDialog.open || sketcher.active || !state.path) return;
  if (f.kind === "sketch") {
    if (!(await kernel.whenReady(1000))) { say("The CAD kernel is still loading."); return; }
    let src = editor.text;
    if (!f.constrained) { // a plain build123d sketch: convert it (unsaved: Cancel leaves the code as it was)
      const ok = await ask($("ask-panel"), { title: "Convert the sketch?", icon: "sketch", ok: "Convert",
        text: `"${f.label}" is a plain build123d sketch. Convert it to a constrained sketch to edit it here?\n\nIts sizes and positions become dimensions (expressions are kept). It's only saved when you press Finish.` });
      if (!ok) return;
      try { src = await kernel.sketchConvert(src, f.index); }
      catch (e) { say((e as Error).message, true); return; }
    }
    await openSketch(src, f.index, f.name ?? "the sketch", { ok: state.upto, cancel: state.upto }, `${f.name ?? "Sketch"} edited`);
    if (!f.constrained && sketcher.active) say("Converted to a constrained sketch: Finish saves it, Cancel leaves the code as it was.");
    return;
  }
  if (f.tier === "code") {
    showCode(true);
    editor.markFeature([f.line, f.end], true);
    say("This feature is code: edit it in the code panel.");
    return;
  }
  if (!(await kernel.whenReady(1000))) { say("The CAD kernel is still loading."); return; }
  editReturn = { ok: state.upto, cancel: state.upto };
  editLabel = `${f.name ?? f.label} edited`;
  await openDialog(editor.text, f.index);
}

/** Roll back to just before feature `index` of `src` and open its dialog (`src` unsaved: a new feature). */
async function openDialog(src: string, index: number) {
  state.upto = index - 1;
  state.active = index;
  document.body.classList.add("editing-feature");
  setTab("timeline");
  const r = await rebuild(); // the features before it are the same in the saved file
  viewer.setPreviewBase(r?.mesh ?? null);
  let detail;
  try { detail = r ? await kernel.readFeature(src, index) : null; }
  catch (e) { say(`Can't edit this feature: ${(e as Error).message}`, true); }
  if (!detail?.fields) {
    endEditing();
    state.upto = editReturn.cancel;
    rebuild();
    return;
  }
  featureDialog.show(detail, src === editor.text ? undefined : src);
  refreshCommands();
}

/**
 * A new feature at the rollback bar, in its dialog. An extrude uses the faces selected in the view, else the latest
 * sketch before the bar (preferring one nothing uses yet); fillets and chamfers the selected edges.
 */
async function addFeature(kind: AddKind) {
  if (featureDialog.open || sketcher.active || !state.path) return;
  const feats = state.result?.timeline?.features ?? [];
  const last = feats.length - 1;
  const after = state.upto != null && state.upto < last ? state.upto : null;
  let params: Record<string, string>;
  const faces = kind === "extrude" ? selected("face") : null;
  if (faces) {
    params = { to_extrude: faces, amount: "10" };
  } else if (kind === "extrude" || kind === "revolve") {
    const sketches = feats.filter((f) => f.kind === "sketch" && f.name && !f.implicit && f.index <= (after ?? last));
    const unused = sketches.filter((s) => !feats.some((f) => f.index > s.index && f.index <= (after ?? last) && f.refs.includes(s.name!)));
    const sketch = (unused.length ? unused : sketches).at(-1);
    if (!sketch) { say(kind === "extrude" ? "Select faces of the part, or draw a sketch first (S), then extrude it." : "Draw a sketch first (S), then revolve it."); return; }
    params = kind === "extrude" ? { to_extrude: `${sketch.name}.sketch`, amount: "10" } : { profiles: `${sketch.name}.sketch` };
  } else if (kind === "hole") { // at the points of the latest sketch with points (preferring one nothing uses yet)
    const withPoints = feats.filter((f) => f.kind === "sketch" && f.name && f.points && f.index <= (after ?? last));
    const unused = withPoints.filter((s) => !feats.some((f) => f.index > s.index && f.index <= (after ?? last) && f.refs.includes(s.name!)));
    const sketch = (unused.length ? unused : withPoints).at(-1);
    if (!sketch) { say("Draw the hole positions as points in a sketch first (S, then P), then Hole."); return; }
    params = { kind: "Hole", locations: `*points(${sketch.name})`, radius: "2.5" };
  } else if (kind === "mirror") {
    params = { about: "Plane.YZ" };
  } else if (kind === "plane") { // offset from the selected flat face, else from XY
    const face = selectedFlatFace();
    params = { base: face ? `Plane(${face})` : "Plane.XY", offset: "10" };
  } else {
    const edges = selected("edge");
    if (!edges) { say(`Select the edges to ${kind} in the view first (Shift+click for more).`); return; }
    params = { objects: edges, [kind === "fillet" ? "radius" : "length"]: "1" };
  }
  if (!(await kernel.whenReady(1000))) { say("The CAD kernel is still loading."); return; }
  let ins;
  try { ins = await kernel.insertFeature(editor.text, after, kind, params); }
  catch (e) { say((e as Error).message, true); return; }
  editReturn = { ok: after === null ? null : after + 1, cancel: state.upto };
  editLabel = `${kind[0].toUpperCase()}${kind.slice(1)} added`;
  await openDialog(ins.src, ins.index);
}

/** Delete a feature at once (unless a later one uses it), with Undo in the message. */
async function removeFeature(f: Feature) {
  if (featureDialog.open || sketcher.active || !state.path) return;
  let src;
  try { src = await kernel.deleteFeature(editor.text, f.index); }
  catch (e) { say((e as Error).message.replace(/^\w*Error: /, ""), true); return; }
  if (state.upto != null && state.upto >= f.index) state.upto--;
  const label = f.name ?? f.label;
  await applyCode(state.path, src, `${label} deleted`);
  message(`${label} deleted`, { action: "Undo", run: () => undo() });
}

/** Rename a feature in its row: the name in the code and every later use of it (docs/09), with Undo in the message. */
async function renameFeature(f: Feature) {
  if (featureDialog.open || sketcher.active || !state.path || !f.name) return;
  const li = $("timeline").querySelector<HTMLElement>(`li.feature[data-index="${f.index}"]`);
  if (!li || li.classList.contains("editing")) return;
  const others = new Set((state.result?.timeline?.features ?? []).filter((g) => g.index !== f.index && g.name).map((g) => g.name!));
  const name = await inlineName(li, {
    value: f.name,
    check: (n) => !n ? "Type a name." : !PY_NAME.test(n) ? "Names are Python names: letters, digits and _, not starting with a digit." : others.has(n) ? `${n} is another feature's name.` : null,
    hint: (n) => n === f.name ? "Enter keeps the name" : `Enter renames ${f.name} and its uses to ${n}`,
  });
  if (li.isConnected) li.focus({ preventScroll: true }); // back from the name field, so the keys work on the row again
  if (state.timelineStale) showTimeline();
  if (!name || name === f.name || !state.path) return;
  let src;
  try { src = await kernel.renameFeature(editor.text, f.index, name, f.name); }
  catch (e) { say((e as Error).message.replace(/^\w*Error: /, ""), true); return; }
  await applyCode(state.path, src, `Renamed ${f.name} to ${name}`);
  message(`Renamed ${f.name} to ${name}`, { action: "Undo", run: () => undo() });
}

/** The feature the cursor in the code is in, marked in the timeline (docs/09: code and timeline map one to one). */
function cursorAt(line: number | null) {
  state.cursorLine = line;
  const index = featureAtLine(line);
  if (index === state.cursorFeature) return;
  state.cursorFeature = index;
  markCursor($("timeline"), index);
}
const featureAtLine = (line: number | null) => line == null ? null : (state.result?.timeline?.features ?? []).find((x) => x.line <= line && line <= x.end)?.index ?? null;

/** The timeline row with the keyboard focus, and its feature when it has a name (F2). */
const focusedRow = () => focusedFeature($("timeline"));
const focusedNamed = () => { const i = focusedRow(); const f = i === null ? undefined : state.result?.timeline?.features[i]; return f?.name ? f : undefined; };

function timelineMenu(f: Feature, at: { x: number; y: number }) {
  const last = (state.result?.timeline?.features.length ?? 0) - 1;
  menu(at, [{ header: f.name ? `${f.name} · ${f.kind}` : f.label, items: [
    f.tier === "code" ? { label: "Show code", icon: "code", run: () => editFeature(f) } : { label: "Edit", icon: "rename", key: "enter", run: () => editFeature(f) },
    { label: "Roll back to here", icon: "history", run: () => { state.upto = f.index === last ? null : f.index; rebuild(); } },
    { label: "Show code", icon: "code", run: () => { showCode(true); editor.markFeature([f.line, f.end], true); } },
    { label: "Rename", icon: "rename", key: "f2", disabled: !f.name, run: () => renameFeature(f) },
    "-",
    { label: "Delete", icon: "trash", danger: true, run: () => removeFeature(f) },
  ] }]);
}

// --- Undo and redo (docs/09) -------------------------------------------------------------------------------------

async function undo() { await step("undo"); }
async function redo() { await step("redo"); }
async function step(dir: "undo" | "redo") {
  const path = state.path;
  if (!path || !state.workspace || sketcher.active || featureDialog.open) return;
  flushTyping();
  const s = dir === "undo" ? history.undo(path, editor.text) : history.redo(path, editor.text);
  if (!s) return;
  await state.workspace.write(path, s.text);
  editor.setText(s.text);
  state.saved = s.text;
  state.modified = await state.workspace.modified(path);
  state.agent.delete(path);
  refreshUndo();
  await rebuild();
  say(`${dir === "undo" ? "Undid" : "Redid"}: ${s.label}`);
}

function refreshUndo() {
  const p = history.peek(state.path);
  const [u, r] = [$<HTMLButtonElement>("undo"), $<HTMLButtonElement>("redo")];
  u.disabled = !p.undo;
  r.disabled = !p.redo;
  u.title = p.undo ? `Undo: ${p.undo} · Ctrl+Z` : "Nothing to undo · Ctrl+Z";
  r.title = p.redo ? `Redo: ${p.redo} · Ctrl+Y` : "Nothing to redo · Ctrl+Y";
}

// --- Agent ---------------------------------------------------------------------------------------------------------

const agents = new Agents(makeTools({
  kernel, viewer,
  workspace: () => state.workspace,
  index: () => state.index,
  exportPart,
  source: () => editor.text,
  path: () => state.path,
  result: () => state.result,
  selection: () => state.selection,
  openPart,
  applyCode: (path, code) => applyCode(path, code, "Agent edit", true),
  note: (text) => {
    const el = $("agent-note");
    el.hidden = !text;
    el.innerHTML = text ? `${icon("agent")}<span></span>` : "";
    if (text) el.querySelector("span")!.textContent = text;
  },
}));
agents.onCall = (name) => { $("agent-button").title = `Agent: ${name.replace(/_/g, " ")}…`; };
// Look for bridges right away only if that doesn't make the browser ask; otherwise the agent dialog starts it.
localAccess().then((a) => { if (a === "granted" || a === "none") agents.start(); });
setupAgentDialog($<HTMLDialogElement>("agent-dialog"), $<HTMLButtonElement>("agent-button"), agents);

// Typing: saved after a pause, one step in the history per pause.
let saveTimer = 0; // non-zero while an edit is waiting to be saved
async function saveTyping() {
  saveTimer = 0;
  if (!state.workspace || !state.path) return;
  const text = editor.text;
  if (text === state.saved) return;
  history.record(state.path, state.saved, text, "Typing in the code");
  state.saved = text;
  state.agent.delete(state.path);
  await state.workspace.write(state.path, text);
  state.modified = await state.workspace.modified(state.path);
  $("code-lines").textContent = `${text.split("\n").length} lines`;
  refreshUndo();
  rebuild();
}
function flushTyping() { if (saveTimer) { clearTimeout(saveTimer); saveTyping(); } }
editor.onCursor = (line) => cursorAt(line);
editor.onChange = () => {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveTyping, SAVE_DELAY_MS);
};

// Edits from outside (Claude Code, another editor) show up within a second; so do edits to the project's
// shared code, which rebuild the open part.
setInterval(async () => {
  const { workspace: ws, path } = state;
  if (!ws || !path || saveTimer || sketcher.active || featureDialog.open) return;
  try {
    let changed = false;
    for (const [p, t] of state.watched) if ((await ws.modified(p)) !== t) changed = true;
    if (changed) { await syncProject(path); rebuild(); }
    const m = await ws.modified(path);
    if (m === state.modified) return;
    state.modified = m;
    const text = await ws.read(path);
    if (text !== editor.text) {
      history.record(path, editor.text, text, "Changed outside CAAD");
      editor.setText(text);
      state.saved = text;
      refreshUndo();
      rebuild();
    }
  } catch { /* file renamed or deleted: keep what we have */ }
}, POLL_MS);

// --- Sketching ---------------------------------------------------------------------------------------------------------

let sketchLabel = "Sketch added";
const sketcher = new Sketcher(viewer, $("sketch-panel"), {
  kernel, status: (t) => say(t),
  async done(src) {
    closeSketch();
    state.upto = sketchReturn.ok;
    if (state.path) await applyCode(state.path, src, sketchLabel);
  },
  cancel() {
    closeSketch();
    state.upto = sketchReturn.cancel;
    rebuild();
  },
  changed: () => { refreshCommands(); sketchStatus(); },
});

function sketchStatus() {
  const el = $("sketch-status");
  el.hidden = !sketcher.active;
  if (!sketcher.active) return;
  const s = sketcher.status;
  el.innerHTML = `<b>${esc(s.name)}</b><span>on ${esc(s.where)}</span><span class="dof${s.tone === "ok" ? " ok" : s.tone === "bad" ? " bad" : ""}">${esc(s.state)}</span>`;
}

/** Sketch: on the selected flat face, else choose a plane (the standard ones, then the part's plane features). */
function sketchCommand(anchor?: HTMLElement) {
  if (sketcher.active) return;
  const r = state.result;
  if (!state.path || !r?.timeline?.part) { say("Open a part first, or create one with New."); return; }
  const face = selectedFlatFace();
  if (face) { startSketch(face, "the selected face"); return; }
  const planes = (r.timeline.features ?? []).filter((f) => f.kind === "plane" && f.name && f.status === "ok");
  const sections: MenuSection[] = [
    { header: "Sketch on", items: [
      { label: "Top (XY)", icon: "plane", run: () => startSketch("Plane.XY", "Top (XY)") },
      { label: "Front (XZ)", icon: "plane", run: () => startSketch("Plane.XZ", "Front (XZ)") },
      { label: "Right (YZ)", icon: "plane", run: () => startSketch("Plane.YZ", "Right (YZ)") },
    ] },
  ];
  if (planes.length) sections.push({ header: "Planes of the part", items: planes.map((f) => ({ label: f.name!, meta: f.label.replace(/^\w+\s*=\s*/, ""), icon: "plane" as const, run: () => startSketch(f.name!, f.name!) })) });
  sections.push({ items: [{ label: "Or select a flat face first, then S", disabled: true, run: () => {} }] });
  menu(anchor ?? { x: innerWidth / 2 - 110, y: 70 }, sections, { className: "plane-menu" });
}

/** A new sketch: an empty constrained sketch at the rollback bar, opened in the editor; saved only on Finish. */
async function startSketch(planeExpr: string, label: string) {
  if (sketcher.active || featureDialog.open || !state.path) return;
  if (!(await kernel.whenReady(1000))) { say("The CAD kernel is still loading."); return; }
  const upto = state.upto;
  const last = (state.result?.timeline?.features.length ?? 0) - 1;
  const after = upto != null && upto < last ? upto : null;
  let sk;
  try { sk = await kernel.insertFeature(editor.text, after, "sketch", { plane: planeExpr, body: ["with Constrained() as c:", "    pass"] }); }
  catch (e) { say(`Couldn't start the sketch: ${(e as Error).message}`, true); return; }
  await openSketch(sk.src, sk.index, label, { ok: after === null ? null : after + 1, cancel: upto }, "Sketch added");
}

// Where the rollback bar goes when the sketch editor closes.
let sketchReturn: { ok: number | null; cancel: number | null } = { ok: null, cancel: null };

/** Roll back to just before sketch `index` of `src` (unsaved for a new sketch) and edit it. */
async function openSketch(src: string, index: number, label: string, ret: typeof sketchReturn, historyLabel: string) {
  sketchReturn = ret;
  sketchLabel = historyLabel;
  state.upto = index - 1;
  clearSelection();
  await rebuild(); // the part before the sketch (the features before it are the same in the saved file)
  let model, plane;
  try {
    model = await kernel.sketchOpen(src, index);
    plane = await kernel.sketchPlane(model.plane ?? "Plane.XY");
    if (plane.error) throw new Error(plane.error);
  } catch (e) {
    say((e as Error).message, true);
    state.upto = ret.cancel;
    rebuild();
    return;
  }
  const bb = state.result?.summary?.bbox;
  const size = bb ? Math.max(40, Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2])) : 100;
  document.body.classList.add("sketching");
  state.active = index;
  setTab("timeline");
  setMode("sketch");
  sketcher.open(plane, label, size, { src, index, model });
  showTimeline();
}

function closeSketch() {
  document.body.classList.remove("sketching");
  state.active = null;
  setMode("part");
  sketchStatus();
}

// --- Commands, keys and menus (docs/09) -----------------------------------------------------------------------------

const hasPart = () => !!state.path && !!state.result?.timeline?.part && !featureDialog.open && !sketcher.active;
const PART: [AddKind | "sketch", string, string | undefined, string][] = [
  ["sketch", "Sketch", "s", "Sketch on the selected flat face, or on a plane"],
  ["extrude", "Extrude", "e", "Extrude or cut the selected faces, else the latest sketch"],
  ["revolve", "Revolve", "r", "Revolve the latest sketch"],
  ["hole", "Hole", "h", "Holes at the points of the latest sketch with points"],
  ["fillet", "Fillet", undefined, "Round the selected edges"],
  ["chamfer", "Chamfer", undefined, "Bevel the selected edges"],
  ["plane", "Plane", "p", "A plane to sketch or mirror on: from the selected flat face, else from XY"],
  ["mirror", "Mirror", undefined, "Mirror the part so far"],
];
register(...PART.map(([kind, label, key, title]): Command => ({
  id: kind, label, key, title, mode: "part", toolbar: "main", icon: kind, enabled: hasPart,
  run: (anchor) => (kind === "sketch" ? sketchCommand(anchor) : addFeature(kind)),
})));
register({
  id: "export", label: "Export", icon: "download", mode: "part", toolbar: "more", title: "STEP or STL, into the project's exports/",
  enabled: hasPart,
  run: (anchor) => menu(anchor ?? { x: innerWidth / 2, y: 70 }, [{ header: "Export the part", items: [
    { label: "STEP", meta: "exact geometry, for CAD", icon: "download", run: () => runExport("step") },
    { label: "STL", meta: "a mesh, for printing", icon: "download", run: () => runExport("stl") },
  ] }]),
});
register(...TOOLS.map(([tool, label, ic, key, title]): Command => ({
  id: `tool-${tool}`, label, icon: ic, key, title, mode: "sketch", toolbar: tool === "dimension" || tool === "trim" || tool === "use" ? "more" : "main",
  active: () => sketcher.active && sketcher.currentTool === tool, run: () => sketcher.setTool(tool),
})));
register(
  { id: "construction", label: "Construct", icon: "construction", key: "q", mode: "sketch", toolbar: "more", title: "Construction on/off: for the selection, else for what you draw next",
    active: () => sketcher.active && sketcher.construction, run: () => sketcher.toggleConstruction() },
  { id: "finish", label: "Finish", icon: "check", mode: "sketch", toolbar: "primary", title: "Close the sketch and save it (Enter)", enabled: () => sketcher.canFinish, run: () => sketcher.finish() },
  { id: "undo", label: "Undo", key: "ctrl+z", enabled: () => !!history.peek(state.path).undo && !sketcher.active && !featureDialog.open, run: () => undo() },
  { id: "redo", label: "Redo", key: "ctrl+y", enabled: () => !!history.peek(state.path).redo && !sketcher.active && !featureDialog.open, run: () => redo() },
  { id: "redo-alt", label: "Redo", key: "ctrl+shift+z", alias: true, enabled: () => !!history.peek(state.path).redo && !sketcher.active && !featureDialog.open, run: () => redo() },
  { id: "fit", label: "Fit", icon: "fit", key: "f", run: () => { const bb = viewer.bbox; if (bb) viewer.fit(bb, { keep: true, animate: true }); } },
  { id: "normal", label: "View normal to", icon: "target", key: "n", title: "Look straight at the selected flat face, or the sketch", run: () => viewNormal() },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: "keyboard", key: "?", run: () => shortcutSheet() },
  { id: "code", label: "Show or hide the code", icon: "code", key: "ctrl+j", run: () => showCode(document.body.classList.contains("code-hidden")) },
  { id: "escape", label: "Back out: cancel the dialog, clear the selection", key: "escape", mode: "part",
    run: () => { if (featureDialog.open) featureDialog.cancel(); else if (!$("project-panel").hidden) { $("project-panel").hidden = true; } else clearSelection(); } },
  { id: "rename", label: "Rename the file or feature", key: "f2", mode: "part", enabled: () => !!files.focused() || !!focusedNamed(), run: () => {
    const f = focusedNamed();
    if (f) { renameFeature(f); return; }
    const r = files.focused();
    if (r) files.rename(r);
  } },
  { id: "delete", label: "Delete the file or feature", key: "delete", mode: "part", enabled: () => !!files.focused() || focusedRow() !== null, run: () => {
    const i = focusedRow();
    const f = i === null ? undefined : state.result?.timeline?.features[i];
    if (f) { removeFeature(f); return; }
    const r = files.focused();
    if (r?.dataset.path && r.dataset.kind !== "config") files.remove(r.dataset.path);
    else if (r?.dataset.project) files.remove(r.dataset.project);
  } },
);
mountToolbar($("commands"));

function viewNormal() {
  const items = state.selection.flatMap((i) => i.items);
  const picks = viewer.selection.filter((p) => p.kind === "face");
  if (items.length === 1 && items[0].type === "PLANE" && picks.length === 1) viewer.viewNormalToFace(picks[0].index);
  else if (!sketcher.active) say("Select a flat face first, then N.");
}

// Right-click in the view: the commands that fit what is under the pointer.
viewer.onContext = (pick, ev) => {
  const at = { x: ev.clientX, y: ev.clientY };
  if (sketcher.active) {
    const sections = sketcher.menuSections(ev);
    if (sections.length) menu(at, sections);
    return;
  }
  if (featureDialog.open) return;
  if (!pick) {
    const dir = (x: number, y: number, z: number) => () => viewer.viewFrom(new THREE.Vector3(x, y, z));
    menu(at, [{ header: "View", items: [
      { label: "Fit", icon: "fit", key: "f", run: () => run("fit") },
      { label: "Isometric", icon: "cube", run: dir(1, -1.2, 0.9) }, { label: "Front", icon: "cube", run: dir(0, -1, 0) },
      { label: "Top", icon: "cube", run: dir(0, 0, 1) }, { label: "Right", icon: "cube", run: dir(1, 0, 0) },
    ] }, { items: [{ label: "Keyboard shortcuts", icon: "keyboard", key: "?", run: () => shortcutSheet() }] }]);
    return;
  }
  // Right-click selects what is under the pointer (unless it already is), then offers what fits it.
  if (!viewer.selection.some((p) => p.kind === pick.kind && p.index === pick.index)) {
    viewer.setSelection([pick]);
    describeSelection([pick]);
  }
  const flat = pick.kind === "face" && pick.type === "PLANE";
  const copy = { label: "Copy selector", icon: "copy" as const, run: async () => {
    const info = await kernel.select(pick.kind, [pick.index]);
    const expr = info.selectors[0]?.expr;
    if (expr) { await navigator.clipboard?.writeText(expr).catch(() => {}); say(`Copied ${expr}`); }
  } };
  const header = `${pick.kind === "face" ? "Face" : "Edge"} · ${pick.type.toLowerCase()}`;
  const later = (f: () => void) => () => setTimeout(f, 50); // after the selection is described
  menu(at, [{ header, items: pick.kind === "face" ? [
    { label: "Sketch on face", icon: "sketch", key: "s", disabled: !flat || !hasPart(), run: later(() => run("sketch")) },
    { label: "Extrude face", icon: "extrude", key: "e", disabled: !hasPart(), run: later(() => run("extrude")) },
    { label: "Plane from face", icon: "plane", key: "p", disabled: !flat || !hasPart(), run: later(() => run("plane")) },
    "-",
    { label: "View normal to", icon: "target", key: "n", disabled: !flat, run: () => viewer.viewNormalToFace(pick.index) },
    copy,
  ] : [
    { label: "Fillet", icon: "fillet", disabled: !hasPart(), run: later(() => run("fillet")) },
    { label: "Chamfer", icon: "chamfer", disabled: !hasPart(), run: later(() => run("chamfer")) },
    "-",
    copy,
  ] }]);
};

// --- The top bar, the rail and the dock ---------------------------------------------------------------------------------

const remember = (key: string, value?: string): string | null => {
  try { if (value !== undefined) localStorage.setItem(key, value); return localStorage.getItem(key); } catch { return value ?? null; }
};

function setTab(tab: "files" | "timeline") {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".rtabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  $("files-tab").hidden = tab !== "files";
  $("timeline-tab").hidden = tab !== "timeline";
  remember("caad.tab", tab);
}
$("tab-files").innerHTML = `${icon("folder")}Files`;
$("tab-timeline").innerHTML = `${icon("history")}Timeline`;
for (const b of document.querySelectorAll<HTMLButtonElement>(".rtabs button")) b.onclick = () => setTab(b.dataset.tab as "files" | "timeline");
setTab(remember("caad.tab") === "files" ? "files" : "timeline");
$("crumb").onclick = () => { if (document.body.classList.contains("rail-hidden")) showRail(true); setTab("files"); };
$("workspace").onclick = () => files.switcher($("workspace"));
$("new-menu").innerHTML = `${icon("plus")}New`;
$("new-menu").onclick = () => files.newMenu($("new-menu"));

function showRail(on: boolean) { document.body.classList.toggle("rail-hidden", !on); remember("caad.railHidden", on ? "0" : "1"); }
$("collapse-left").innerHTML = icon("chevron");
$("collapse-left").style.transform = "rotate(180deg)";
$("collapse-left").onclick = () => showRail(false);
$("toggle-left").innerHTML = icon("chevron");
$("toggle-left").onclick = () => showRail(true);
showRail(remember("caad.railHidden") !== "1");

function showCode(on: boolean) {
  document.body.classList.toggle("code-hidden", !on);
  $("toggle-code").classList.toggle("on", on);
  $("toggle-code").title = `${on ? "Hide" : "Show"} the code · Ctrl+J`;
  remember("caad.code", on ? "1" : "0");
  if (on) editor.view.requestMeasure();
}
$("toggle-code").innerHTML = icon("code");
$("toggle-code").onclick = () => showCode(document.body.classList.contains("code-hidden"));
$("close-code").innerHTML = icon("x");
$("close-code").onclick = () => showCode(false);
$("code-icon").innerHTML = icon("code");
showCode(remember("caad.code") === "1"); // closed by default (docs/09)
{ // the code pane's width: drag its left edge; remembered
  const w = Number(remember("caad.codeWidth"));
  if (w) document.documentElement.style.setProperty("--code-w", `${w}px`);
  const handle = document.querySelector<HTMLElement>("#code .resize")!;
  handle.onpointerdown = (e) => {
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => document.documentElement.style.setProperty("--code-w", `${Math.max(260, Math.min(innerWidth * 0.6, innerWidth - ev.clientX))}px`);
    const up = () => { handle.removeEventListener("pointermove", move); remember("caad.codeWidth", String(parseInt(getComputedStyle(document.documentElement).getPropertyValue("--code-w")))); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
  };
}

$("undo").innerHTML = icon("undo");
$("redo").innerHTML = icon("redo");
$("undo").onclick = () => undo();
$("redo").onclick = () => redo();
refreshUndo();

$("settings").innerHTML = icon("settings");
$("settings").onclick = () => {
  const choice = themeChoice();
  const el = document.createElement("div");
  el.innerHTML = `<div class="h">Theme</div><div class="seg">${(["system", "light", "dark"] as ThemeChoice[]).map((c) =>
    `<button data-theme-choice="${c}" aria-pressed="${c === choice}">${icon(c === "system" ? "monitor" : c === "light" ? "sun" : "moon")}${c[0].toUpperCase() + c.slice(1)}</button>`).join("")}</div>
    <hr><button class="it" data-sheet>${icon("keyboard")}<span class="l">Keyboard shortcuts</span><kbd>?</kbd></button>`;
  const { el: pop, close } = popover($("settings"), el, "settings-menu");
  pop.style.left = `${Math.min(parseFloat(pop.style.left), innerWidth - pop.offsetWidth - 8)}px`;
  pop.querySelectorAll<HTMLButtonElement>("[data-theme-choice]").forEach((b) => {
    b.onclick = () => { setTheme(b.dataset.themeChoice as ThemeChoice); pop.querySelectorAll("[data-theme-choice]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); };
  });
  pop.querySelector<HTMLButtonElement>("[data-sheet]")!.onclick = () => { close(); shortcutSheet(); };
};

// A dialog in the dock replaces the code while it is open (docs/10).
const docked = () => document.body.classList.toggle("docked", ["feature-panel", "sketch-panel", "ask-panel", "project-panel"].some((id) => !$(id).hidden));
new MutationObserver(docked).observe($("dock"), { subtree: true, attributes: true, attributeFilter: ["hidden"] });

// --- Start-up: the last workspace, the examples, or the start page ---------------------------------------------------------

async function showStart() {
  document.body.classList.add("no-workspace");
  crumb();
  const recents = (await recentFolders()).slice(0, 4);
  const el = $("start");
  el.innerHTML = `<div class="drop"></div><div class="welcome"><h1>Welcome to CAAD</h1><p>Parts are build123d code in a folder on your computer. Pick where to work:</p>
    <div class="choices"><button class="choice primary" data-pick${canOpenFolders() ? "" : " disabled"}>${icon("folderOpen")}<b>Open a folder</b><span>${canOpenFolders()
      ? "A folder with CAAD projects, a single project, or any folder to start one in. You can also drop a folder here." : "Opening folders needs Chrome or Edge, over https:// or on localhost."}</span></button>
    <button class="choice" data-examples>${icon("lock")}<b>Explore the examples</b><span>Bundled parts to look at and change. Edits stay in the page.</span></button></div>
    ${recents.length ? `<div class="recent"><div class="h">Recent</div>${recents.map((r, i) => `<button data-recent="${i}">${icon("folder")}<b>${esc(r.name)}</b>${r.projects ? `<small>${r.projects} project${r.projects === 1 ? "" : "s"}</small>` : ""}<span class="go">Reconnect</span></button>`).join("")}</div>` : ""}</div>`;
  el.hidden = false;
  el.querySelector<HTMLButtonElement>("[data-pick]")!.onclick = () => switchWorkspace({ pick: true });
  el.querySelector<HTMLButtonElement>("[data-examples]")!.onclick = () => switchWorkspace({ examples: true });
  el.querySelectorAll<HTMLButtonElement>("[data-recent]").forEach((b) => { b.onclick = () => switchWorkspace({ recent: recents[Number(b.dataset.recent)] }); });
  showTimeline();
  refreshCommands();
}

// Drop a folder on the page to open it.
$("view").addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); $("start").classList.add("dragging"); } });
$("view").addEventListener("dragleave", () => $("start").classList.remove("dragging"));
$("view").addEventListener("drop", async (e) => {
  $("start").classList.remove("dragging");
  const item = [...(e.dataTransfer?.items ?? [])].find((i) => i.kind === "file");
  if (!item || !("getAsFileSystemHandle" in item)) return;
  e.preventDefault();
  const handle = await (item as DataTransferItem & { getAsFileSystemHandle(): Promise<FileSystemHandle | null> }).getAsFileSystemHandle();
  if (handle?.kind !== "directory") { say("Drop a folder to open it as a workspace.", true); return; }
  const dir = handle as FileSystemDirectoryHandle;
  if ((await dir.requestPermission({ mode: "readwrite" })) !== "granted") return;
  const ws = await reopen(dir);
  if (ws) setWorkspace(ws, dir);
});

async function startUp() {
  const last = remember("caad.last");
  if (last === "examples") return setWorkspace(examples());
  if (last === "folder") {
    const [r] = await recentFolders();
    if (r && (await canReopen(r.handle))) { const ws = await reopen(r.handle); if (ws) return setWorkspace(ws, r.handle); }
  }
  showStart();
}
crumb();
startUp();

// For tests and debugging in the console.
Object.assign(window, { caad: { editor, viewer, kernel, state, rebuild, openPart, applyCode, agents, sketcher, startSketch, editFeature, featureDialog,
  regionPicker: () => regionPicker, files, history, refresh: refreshBrowser, undo, redo, commands: { run, command, currentMode, tooltip }, lastMessage, setWorkspace, examples, setTab } });
