import "./style.css";
import { Agents, localAccess } from "./agent";
import { setupAgentDialog } from "./agent-dialog";
import { Editor } from "./editor";
import { FeatureDialog } from "./feature-dialog";
import { RegionPicker } from "./regions";
import { Kernel, type BuildResult, type Feature, type Kind, type SelectInfo } from "./kernel";
import { canOpenFolders, examples, indexWorkspace, lastFolder, openFolder, projectFile, projectOf, reopen,
  type FileKind, type ScannedFile, type Workspace, type WorkspaceIndex } from "./project";
import { renderSelection } from "./selection";
import { newPartSource } from "./sketch-code";
import { Sketcher } from "./sketcher";
import { renderTimeline, type AddKind } from "./timeline";
import { makeTools } from "./tools";
import { Viewer, type Pick } from "./viewer";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const POLL_MS = 1000;
const SAVE_DELAY_MS = 500;

const kernel = new Kernel();
const viewer = new Viewer($("view"));
const editor = new Editor($("editor"));

const state = {
  workspace: null as Workspace | null,
  files: [] as ScannedFile[], // the workspace's last scan
  index: { projects: [], loose: [] } as WorkspaceIndex,
  watched: new Map<string, number>(), // the open project's other .py files: their last-modified times
  path: null as string | null,
  upto: null as number | null,
  modified: 0, // last-modified time of the open file as we last saw or wrote it
  result: null as BuildResult | null,
  fitNext: true,
  // The current selection, as the best selector per kind: re-resolved after every rebuild.
  selection: [] as SelectInfo[],
};

// --- Status -----------------------------------------------------------------------------------

const status = (text: string) => { $("status").textContent = text; };
kernel.onStatus = (text) => { $("overlay").textContent = text; $("overlay").hidden = false; };
kernel.onReady = (s) => {
  $("overlay").hidden = true;
  status(`Kernel ready in ${s.toFixed(0)} s`);
  if (state.path) rebuild();
};

// --- Building ---------------------------------------------------------------------------------

async function rebuild(): Promise<BuildResult | null> {
  if (!state.path) return null;
  if (!kernel.ready) { status("Waiting for the kernel…"); }
  const t = performance.now();
  let r: BuildResult | null;
  try { r = await kernel.build(editor.text, state.path, state.upto); }
  catch (e) { status("Kernel error: " + (e as Error).message); return null; }
  if (!r) return null; // replaced by a newer build
  state.result = r;
  viewer.setMesh(r.mesh, state.fitNext && !!r.mesh);
  viewer.setSketches(r.sketches, state.fitNext && !r.mesh); // a part with only sketches: frame those
  viewer.setPlanes(r.planes);
  if (r.mesh || r.sketches.length) state.fitNext = false;
  restoreSelection(r.gen);
  renderTimeline($("timeline"), r, {
    rollback: (upto) => { if (!featureDialog.open) { state.upto = upto; rebuild(); } },
    hover: (f) => editor.markFeature(f ? [f.line, f.end] : null, !!f),
    edit: (f) => editFeature(f),
    remove: (f) => removeFeature(f),
    add: (kind) => addFeature(kind),
  });
  editor.markError(r.error?.line ?? null);
  const err = $("error");
  err.hidden = !r.error;
  err.textContent = r.error ? `Line ${r.error.line ?? "?"}: ${r.error.message}` : "";
  const ms = (performance.now() - t).toFixed(0);
  status(`${r.ok ? "Built" : "Failed"} in ${ms} ms (Python ${r.times.build} s, mesh ${r.times.mesh} s)`);
  return r;
}

// --- Selection ------------------------------------------------------------------------------

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
}

viewer.onSelect = (picks: Pick[]) => {
  $("agent-note").hidden = true; // a click replaces the agent's highlight
  if (!picks.length) { state.selection = []; renderSelection($("selection"), []); return; }
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

// --- Workspace and projects (docs/07-project-structure.md) ---------------------------------------

async function setWorkspace(ws: Workspace) {
  state.workspace = ws;
  state.path = null;
  $("project-name").textContent = ws.name + (ws.writable ? "" : " (read-only)");
  $("project-name").title = ws.writable ? ws.name : "The bundled examples: edits stay in this browser tab";
  await refreshBrowser();
  const first = state.index.projects.flatMap((p) => p.files).find((f) => f.kind === "part") ?? state.index.loose[0];
  if (first) openPart(first.path);
}

/** Scan the workspace: its projects and their files by kind. */
async function refreshBrowser() {
  const ws = state.workspace;
  state.files = ws ? await ws.scan() : [];
  state.index = indexWorkspace(state.files, ws?.name ?? "");
  renderBrowser();
}

const KINDS: [FileKind, string, string][] = [
  ["part", "Parts", "parts/"], ["shared", "Shared code", ""], ["assembly", "Assemblies", "assemblies/"],
  ["export", "Exports", "exports/"], ["print", "Print", "print/"],
];
const dirOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

function renderBrowser() {
  const items: HTMLElement[] = [];
  const li = (cls: string, text: string, title = "") => Object.assign(document.createElement("li"), { className: cls, textContent: text, title });
  const fileItem = (f: { path: string; kind: FileKind }, label: string) => {
    const item = li(`file ${f.kind}`, label, f.path);
    item.dataset.path = f.path;
    item.classList.toggle("active", f.path === state.path);
    item.onclick = () => (f.kind === "export" || f.kind === "print" ? download(f.path) : openPart(f.path));
    return item;
  };
  for (const p of state.index.projects) {
    items.push(li("project", p.name, p.root ? `Project ${p.root}/` : "This folder is a project"));
    for (const [kind, label, folder] of KINDS) {
      const files = p.files.filter((f) => f.kind === kind);
      if (!files.length) continue;
      items.push(li("group", label));
      for (const f of files) {
        const rel = p.root ? f.path.slice(p.root.length + 1) : f.path;
        items.push(fileItem(f, folder && rel.startsWith(folder) ? rel.slice(folder.length) : rel));
      }
    }
  }
  const folders = [...new Set(state.index.loose.map((f) => dirOf(f.path)))];
  for (const folder of folders) {
    const head = li("project loose", folder ? `${folder}/` : state.workspace?.name ?? "", "build123d files that are in no CAAD project");
    const make = Object.assign(document.createElement("button"), { className: "small", textContent: "Make a project", title: "Add a pyproject.toml here, so this folder is a CAAD project (nothing is moved)" });
    make.onclick = (e) => { e.stopPropagation(); makeProject(folder); };
    head.append(" ", make);
    items.push(head);
    for (const f of state.index.loose.filter((x) => dirOf(x.path) === folder)) items.push(fileItem(f, f.path.slice(folder ? folder.length + 1 : 0)));
  }
  if (!items.length) items.push(li("muted", "No CAAD projects or build123d files here. Use New project to start one."));
  $("parts").replaceChildren(...items);
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
  state.path = path;
  state.upto = rollback;
  state.fitNext = true;
  state.selection = [];
  for (const el of $("parts").querySelectorAll<HTMLElement>("li.file")) el.classList.toggle("active", el.dataset.path === path);
  $("file-name").textContent = path;
  editor.setText(await state.workspace.read(path));
  state.modified = await state.workspace.modified(path);
  await syncProject(path);
  return rebuild();
}

/** New source for a file (from the agent, or a new part): save, show and rebuild. */
async function applyCode(path: string, code: string): Promise<BuildResult | null> {
  if (!state.workspace) return null;
  const isNew = !state.files.some((f) => f.path === path);
  await state.workspace.write(path, code);
  if (isNew) await refreshBrowser();
  if (path !== state.path) return openPart(path);
  clearTimeout(saveTimer); // the agent's version replaces any unsaved typing
  saveTimer = 0;
  editor.setText(code);
  state.modified = await state.workspace.modified(path);
  return rebuild();
}

/** New project: a folder in the workspace with a pyproject.toml and an empty part. */
async function newProject() {
  const ws = state.workspace;
  if (!ws) return;
  if (state.index.projects.some((p) => p.root === "")) { status("This folder is itself a project: open its parent folder to add projects next to it."); return; }
  const raw = prompt("Name of the new project (letters, digits, - and _):", "my-project");
  const name = raw?.trim().replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  if (!name) return;
  if (state.files.some((f) => f.path.startsWith(name + "/"))) { status(`${name}/ already exists.`); return; }
  await ws.write(`${name}/pyproject.toml`, projectFile(name));
  await ws.write(`${name}/parts/part.py`, newPartSource("part"));
  await refreshBrowser();
  await openPart(`${name}/parts/part.py`);
  status(`Created project ${name}. Click ✎ Sketch to start modelling.`);
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
  status(`${folder || ws.name} is a CAAD project now (${path}).`);
}

// --- Editing features (docs/05-feature-model.md) ---------------------------------------------

// Where the rollback bar goes when the dialog closes (a new feature moves it one down).
let editReturn: { ok: number | null; cancel: number | null } = { ok: null, cancel: null };

/** Best selector for the selection, when everything selected is of this kind. */
function selected(kind: Kind): string | null {
  const [info, ...more] = state.selection;
  return info && !more.length && info.items[0]?.kind === kind ? info.selectors[0]?.expr ?? null : null;
}

const featureDialog = new FeatureDialog($("feature-panel"), {
  kernel,
  source: () => editor.text,
  async preview(src, upto) {
    if (!featureDialog.open) return null; // never replace the rebuild of the saved code
    const r = await kernel.build(src, state.path!, upto);
    if (!r || !featureDialog.open) return null; // replaced by a newer build, or the dialog closed meanwhile
    state.result = { ...r, preview: true }; // what the view shows, so picking edges for the dialog works
    viewer.setMesh(r.mesh, false);
    viewer.setSketches(r.sketches, false);
    viewer.setPlanes(r.planes);
    return r.error?.message ?? null;
  },
  async apply(src) {
    document.body.classList.remove("editing-feature");
    state.upto = editReturn.ok;
    if (state.path) await applyCode(state.path, src);
  },
  cancel() {
    document.body.classList.remove("editing-feature");
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

/** Double-click in the timeline: roll back to just before the feature and open its dialog. */
async function editFeature(f: Feature) {
  if (featureDialog.open || sketcher.active || !state.path) return;
  if (f.kind === "sketch") {
    if (!(await kernel.whenReady(1000))) { status("The CAD kernel is still loading."); return; }
    let src = editor.text;
    if (!f.constrained) { // a plain build123d sketch: convert it (unsaved: Cancel leaves the code as it was)
      if (!confirm(`"${f.label}" is a plain build123d sketch. Convert it to a constrained sketch to edit it here?\n\n` +
        "Its sizes and positions become dimensions (expressions are kept). It's only saved when you press Done.")) return;
      try { src = await kernel.sketchConvert(src, f.index); }
      catch (e) { alert((e as Error).message); return; }
    }
    await openSketch(src, f.index, f.name ?? "the sketch", { ok: state.upto, cancel: state.upto });
    if (!f.constrained && sketcher.active) status("Converted to a constrained sketch: Done saves it, Cancel leaves the code as it was.");
    return;
  }
  if (f.tier === "code") {
    editor.markFeature([f.line, f.end], true);
    status("This feature is code: edit it in the code panel.");
    return;
  }
  if (!(await kernel.whenReady(1000))) { status("The CAD kernel is still loading."); return; }
  editReturn = { ok: state.upto, cancel: state.upto };
  await openDialog(editor.text, f.index);
}

/** Roll back to just before feature `index` of `src` and open its dialog (`src` unsaved: a new feature). */
async function openDialog(src: string, index: number) {
  state.upto = index - 1;
  document.body.classList.add("editing-feature");
  const r = await rebuild(); // the features before it are the same in the saved file
  let detail;
  try { detail = r ? await kernel.readFeature(src, index) : null; }
  catch (e) { status(`Can't edit this feature: ${(e as Error).message}`); }
  if (!detail?.fields) {
    document.body.classList.remove("editing-feature");
    state.upto = editReturn.cancel;
    rebuild();
    return;
  }
  featureDialog.show(detail, src === editor.text ? undefined : src);
}

/**
 * "+ Extrude" / "+ Fillet" / "+ Chamfer" at the rollback bar: a new feature in its dialog. An extrude uses the
 * faces selected in the view, else the latest sketch before the bar (preferring one nothing uses yet); fillets and
 * chamfers the selected edges.
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
    if (!sketch) { status(kind === "extrude" ? "Select faces of the part, or draw a sketch first (✎ Sketch), then extrude it." : "Draw a sketch first (✎ Sketch), then revolve it."); return; }
    params = kind === "extrude" ? { to_extrude: `${sketch.name}.sketch`, amount: "10" } : { profiles: `${sketch.name}.sketch` };
  } else if (kind === "hole") { // at the points of the latest sketch with points (preferring one nothing uses yet)
    const withPoints = feats.filter((f) => f.kind === "sketch" && f.name && f.points && f.index <= (after ?? last));
    const unused = withPoints.filter((s) => !feats.some((f) => f.index > s.index && f.index <= (after ?? last) && f.refs.includes(s.name!)));
    const sketch = (unused.length ? unused : withPoints).at(-1);
    if (!sketch) { status("Draw the hole positions as points in a sketch first (✎ Sketch, the • tool), then + Hole."); return; }
    params = { kind: "Hole", locations: `*points(${sketch.name})`, radius: "2.5" };
  } else if (kind === "mirror") {
    params = { about: "Plane.YZ" };
  } else if (kind === "plane") { // offset from the selected flat face, else from XY
    const items = state.selection.flatMap((i) => i.items);
    const face = items.length === 1 && items[0].type === "PLANE" ? selected("face") : null;
    params = { base: face ? `Plane(${face})` : "Plane.XY", offset: "10" };
  } else {
    const edges = selected("edge");
    if (!edges) { status(`Select the edges to ${kind} in the view first (Shift+click for more).`); return; }
    params = { objects: edges, [kind === "fillet" ? "radius" : "length"]: "1" };
  }
  if (!(await kernel.whenReady(1000))) { status("The CAD kernel is still loading."); return; }
  let ins;
  try { ins = await kernel.insertFeature(editor.text, after, kind, params); }
  catch (e) { status((e as Error).message); return; }
  editReturn = { ok: after === null ? null : after + 1, cancel: state.upto };
  await openDialog(ins.src, ins.index);
}

/** The × in the timeline: delete a feature, unless a later one uses it. */
async function removeFeature(f: Feature) {
  if (featureDialog.open || sketcher.active || !state.path) return;
  if (!confirm(`Delete feature ${f.index + 1}, "${f.label}"?`)) return;
  let src;
  try { src = await kernel.deleteFeature(editor.text, f.index); }
  catch (e) { alert((e as Error).message); return; }
  if (state.upto != null && state.upto >= f.index) state.upto--;
  await applyCode(state.path, src);
}

// --- Agent ------------------------------------------------------------------------------------

const agents = new Agents(makeTools({
  kernel, viewer,
  workspace: () => state.workspace,
  index: () => state.index,
  exportPart,
  source: () => editor.text,
  path: () => state.path,
  result: () => state.result,
  selection: () => state.selection,
  openPart, applyCode,
  note: (message) => { const el = $("agent-note"); el.hidden = !message; el.textContent = message ? `Agent: ${message}` : ""; },
}));
agents.onCall = (name) => status(`Agent: ${name.replace(/_/g, " ")}…`);
// Look for bridges right away only if that doesn't make the browser ask; otherwise the agent dialog starts it.
localAccess().then((a) => { if (a === "granted" || a === "none") agents.start(); });
setupAgentDialog($<HTMLDialogElement>("agent-dialog"), $<HTMLButtonElement>("agent-button"), agents);

let saveTimer = 0; // non-zero while an edit is waiting to be saved
editor.onChange = () => {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    if (state.workspace && state.path) {
      await state.workspace.write(state.path, editor.text);
      state.modified = await state.workspace.modified(state.path);
      rebuild();
    }
    saveTimer = 0;
  }, SAVE_DELAY_MS);
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
    if (text !== editor.text) { editor.setText(text); rebuild(); }
  } catch { /* file renamed or deleted: keep what we have */ }
}, POLL_MS);

// --- Header buttons ---------------------------------------------------------------------------

$("examples").onclick = () => setWorkspace(examples());
$("export-button").onclick = () => { if (state.path) $("export-choice").hidden = !$("export-choice").hidden; };
document.querySelectorAll<HTMLButtonElement>("#export-choice [data-format]").forEach((b) => {
  b.onclick = async () => {
    $("export-choice").hidden = true;
    status(`Exporting ${b.textContent}…`);
    try {
      const r = await exportPart(b.dataset.format as "step" | "stl");
      status(r.path ? `Exported ${r.path} (${Math.ceil(r.bytes / 1000)} kB): click it under Exports to download.` : `Downloaded the ${b.textContent} file.`);
    } catch (e) { status((e as Error).message); }
  };
});
$("new-project").onclick = () => newProject();
if (!canOpenFolders()) {
  $<HTMLButtonElement>("open-folder").disabled = true;
  $("open-folder").title = isSecureContext
    ? "Opening folders needs Chrome or Edge (File System Access API)"
    : "Opening folders needs the page over https:// (or on localhost): browsers allow folder access only there";
} else {
  $("open-folder").onclick = async () => {
    try { await setWorkspace(await openFolder()); } catch (e) { if ((e as Error).name !== "AbortError") status(String(e)); }
  };
  lastFolder().then((handle) => {
    if (!handle) return;
    const btn = $<HTMLButtonElement>("reopen");
    btn.textContent = `Reopen ${handle.name}`;
    btn.hidden = false;
    btn.onclick = async () => {
      const p = await reopen(handle);
      if (p) { btn.hidden = true; await setWorkspace(p); }
    };
  });
}

setWorkspace(examples());

// --- Panels ------------------------------------------------------------------------------------

const remember = (key: string, value?: boolean): boolean => {
  try {
    if (value !== undefined) localStorage.setItem(key, value ? "1" : "0");
    return localStorage.getItem(key) === "1";
  } catch { return false; }
};
function panelToggle(button: HTMLElement, cls: string, key: string, titles: [string, string], icons: [string, string]) {
  const apply = (on: boolean) => {
    document.body.classList.toggle(cls, on);
    button.textContent = on ? icons[1] : icons[0];
    button.title = on ? titles[1] : titles[0];
  };
  apply(remember(key));
  button.onclick = () => apply(remember(key, !document.body.classList.contains(cls)));
}
panelToggle($("toggle-left"), "left-compact", "caad.leftCompact", ["Compact timeline", "Show parts and full timeline"], ["«", "»"]);
panelToggle($("toggle-code"), "code-hidden", "caad.codeHidden", ["Hide the code", "Show the code"], ["»", "‹"]);

// --- Sketching -----------------------------------------------------------------------------------

const sketcher = new Sketcher(viewer, $("sketch-panel"), {
  kernel, status,
  async done(src) {
    closeSketch();
    state.upto = sketchReturn.ok;
    if (state.path) await applyCode(state.path, src);
  },
  cancel() {
    closeSketch();
    state.upto = sketchReturn.cancel;
    rebuild();
  },
});

$("sketch-button").onclick = async () => {
  if (sketcher.active) return;
  const r = state.result;
  if (!state.path || !r?.timeline?.part) { status("Open a part first (or create one with + New part)."); return; }
  const items = state.selection.flatMap((i) => i.items);
  if (items.length === 1 && items[0].kind === "face" && items[0].type === "PLANE") {
    startSketch(state.selection[0].selectors[0].expr, "the selected face");
  } else {
    // The plane features before the rollback bar, after the standard planes.
    const planes = (r.timeline.features ?? []).filter((f) => f.kind === "plane" && f.name && f.status === "ok");
    $("plane-features").replaceChildren(...planes.map((f) => {
      const b = document.createElement("button");
      b.textContent = f.name!;
      b.title = f.label;
      b.onclick = () => { $("plane-choice").hidden = true; startSketch(f.name!, f.name!); };
      return b;
    }));
    $("plane-choice").hidden = !$("plane-choice").hidden;
  }
};
document.querySelectorAll<HTMLButtonElement>("#plane-choice [data-plane]").forEach((b) => {
  b.onclick = () => { $("plane-choice").hidden = true; startSketch(b.dataset.plane!, b.textContent!); };
});

/** A new sketch: an empty constrained sketch at the rollback bar, opened in the editor; saved only on Done. */
async function startSketch(planeExpr: string, label: string) {
  if (sketcher.active || featureDialog.open || !state.path) return;
  if (!(await kernel.whenReady(1000))) { status("The CAD kernel is still loading."); return; }
  $("plane-choice").hidden = true;
  const upto = state.upto;
  const last = (state.result?.timeline?.features.length ?? 0) - 1;
  const after = upto != null && upto < last ? upto : null;
  let sk;
  try { sk = await kernel.insertFeature(editor.text, after, "sketch", { plane: planeExpr, body: ["with Constrained() as c:", "    pass"] }); }
  catch (e) { status(`Couldn't start the sketch: ${(e as Error).message}`); return; }
  await openSketch(sk.src, sk.index, label, { ok: after === null ? null : after + 1, cancel: upto });
}

// Where the rollback bar goes when the sketch editor closes.
let sketchReturn: { ok: number | null; cancel: number | null } = { ok: null, cancel: null };

/** Roll back to just before sketch `index` of `src` (unsaved for a new sketch) and edit it. */
async function openSketch(src: string, index: number, label: string, ret: typeof sketchReturn) {
  sketchReturn = ret;
  state.upto = index - 1;
  viewer.setSelection([]);
  state.selection = [];
  await rebuild(); // the part before the sketch (the features before it are the same in the saved file)
  let model, plane;
  try {
    model = await kernel.sketchOpen(src, index);
    plane = await kernel.sketchPlane(model.plane ?? "Plane.XY");
    if (plane.error) throw new Error(plane.error);
  } catch (e) {
    status((e as Error).message);
    state.upto = ret.cancel;
    rebuild();
    return;
  }
  const bb = state.result?.summary?.bbox;
  const size = bb ? Math.max(40, Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2])) : 100;
  document.body.classList.add("sketching");
  sketcher.open(plane, label, size, { src, index, model });
}

function closeSketch() { document.body.classList.remove("sketching"); }

/** + Part: a new part file in the open project's parts/ (or next to the open file if it's in no project). */
$("new-part").onclick = async () => {
  if (!state.workspace) return;
  const raw = prompt("Name of the new part (letters, digits, _):", "part");
  const name = raw?.trim().replace(/\.py$/, "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1");
  if (!name) return;
  const project = state.path ? projectOf(state.index, state.path) : state.index.projects[0];
  const folder = project ? (project.root ? `${project.root}/parts` : "parts") : dirOf(state.path ?? "");
  const path = folder ? `${folder}/${name}.py` : `${name}.py`;
  if (state.files.some((f) => f.path === path)) { status(`${path} already exists.`); return; }
  await applyCode(path, newPartSource(name));
  status(`Created ${path}. Click ✎ Sketch to start modelling.`);
};

// For tests and debugging in the console.
Object.assign(window, { caad: { editor, viewer, kernel, state, rebuild, openPart, applyCode, agents, sketcher, startSketch, editFeature, featureDialog, regionPicker: () => regionPicker } });
