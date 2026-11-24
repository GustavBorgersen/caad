import "./style.css";
import { Agents } from "./agent";
import { setupAgentDialog } from "./agent-dialog";
import { Editor } from "./editor";
import { Kernel, type BuildResult, type Kind, type SelectInfo } from "./kernel";
import { canOpenFolders, examples, lastFolder, openFolder, reopen, type Project } from "./project";
import { renderSelection } from "./selection";
import { insertFeatures, newPartSource, sketchLines } from "./sketch-code";
import { Sketcher } from "./sketcher";
import { renderTimeline } from "./timeline";
import { makeTools } from "./tools";
import { Viewer, type Pick } from "./viewer";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const POLL_MS = 1000;
const SAVE_DELAY_MS = 500;

const kernel = new Kernel();
const viewer = new Viewer($("view"));
const editor = new Editor($("editor"));

const state = {
  project: null as Project | null,
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
  if (r.mesh) state.fitNext = false;
  restoreSelection(r.gen);
  renderTimeline($("timeline"), r, {
    rollback: (upto) => { state.upto = upto; rebuild(); },
    hover: (f) => editor.markFeature(f ? [f.line, f.end] : null, !!f),
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

// --- Files ------------------------------------------------------------------------------------

async function setProject(p: Project) {
  state.project = p;
  state.path = null;
  $("project-name").textContent = p.name + (p.writable ? "" : " (read-only)");
  $("project-name").title = p.writable ? p.name : "The bundled examples: edits stay in this browser tab";
  const parts = await refreshParts();
  if (parts.length) openPart(parts[0]);
}

async function refreshParts() {
  const parts = state.project ? await state.project.list() : [];
  const ul = $("parts");
  ul.replaceChildren(...parts.map((path) => {
    const li = document.createElement("li");
    li.textContent = path;
    li.classList.toggle("active", path === state.path);
    li.onclick = () => openPart(path);
    return li;
  }));
  if (!parts.length) ul.innerHTML = `<li class="muted">No build123d files found</li>`;
  return parts;
}

async function openPart(path: string, rollback: number | null = null): Promise<BuildResult | null> {
  if (!state.project) return null;
  state.path = path;
  state.upto = rollback;
  state.fitNext = true;
  state.selection = [];
  for (const li of $("parts").children) li.classList.toggle("active", li.textContent === path);
  $("file-name").textContent = path;
  editor.setText(await state.project.read(path));
  state.modified = await state.project.modified(path);
  return rebuild();
}

/** New source for a part (from the agent): save, show and rebuild. */
async function applyCode(path: string, code: string): Promise<BuildResult | null> {
  if (!state.project) return null;
  const isNew = !(await state.project.list()).includes(path);
  await state.project.write(path, code);
  if (isNew) await refreshParts();
  if (path !== state.path) return openPart(path);
  clearTimeout(saveTimer); // the agent's version replaces any unsaved typing
  saveTimer = 0;
  editor.setText(code);
  state.modified = await state.project.modified(path);
  return rebuild();
}

// --- Agent ------------------------------------------------------------------------------------

const agents = new Agents(makeTools({
  kernel, viewer,
  project: () => state.project,
  path: () => state.path,
  result: () => state.result,
  selection: () => state.selection,
  openPart, applyCode,
  note: (message) => { const el = $("agent-note"); el.hidden = !message; el.textContent = message ? `Agent: ${message}` : ""; },
}));
agents.onCall = (name) => status(`Agent: ${name.replace(/_/g, " ")}…`);
setupAgentDialog($<HTMLDialogElement>("agent-dialog"), $<HTMLButtonElement>("agent-button"), agents);

let saveTimer = 0; // non-zero while an edit is waiting to be saved
editor.onChange = () => {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    if (state.project && state.path) {
      await state.project.write(state.path, editor.text);
      state.modified = await state.project.modified(state.path);
      rebuild();
    }
    saveTimer = 0;
  }, SAVE_DELAY_MS);
};

// Edits from outside (Claude Code, another editor) show up within a second.
setInterval(async () => {
  const { project, path } = state;
  if (!project?.writable || !path || saveTimer) return;
  try {
    const m = await project.modified(path);
    if (m === state.modified) return;
    state.modified = m;
    const text = await project.read(path);
    if (text !== editor.text) { editor.setText(text); rebuild(); }
  } catch { /* file renamed or deleted: keep what we have */ }
}, POLL_MS);

// --- Header buttons ---------------------------------------------------------------------------

$("examples").onclick = () => setProject(examples());
if (!canOpenFolders()) {
  $<HTMLButtonElement>("open-folder").disabled = true;
  $("open-folder").title = "Opening folders needs Chrome or Edge (File System Access API)";
} else {
  $("open-folder").onclick = async () => {
    try { await setProject(await openFolder()); } catch (e) { if ((e as Error).name !== "AbortError") status(String(e)); }
  };
  lastFolder().then((handle) => {
    if (!handle) return;
    const btn = $<HTMLButtonElement>("reopen");
    btn.textContent = `Reopen ${handle.name}`;
    btn.hidden = false;
    btn.onclick = async () => {
      const p = await reopen(handle);
      if (p) { btn.hidden = true; await setProject(p); }
    };
  });
}

setProject(examples());

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

const sketcher = new Sketcher(viewer, $("sketch-panel"));

$("sketch-button").onclick = async () => {
  if (sketcher.active) return;
  const r = state.result;
  if (!state.path || !r?.timeline?.part) { status("Open a part first (or create one with + New part)."); return; }
  const items = state.selection.flatMap((i) => i.items);
  if (items.length === 1 && items[0].kind === "face" && items[0].type === "PLANE") {
    startSketch(state.selection[0].selectors[0].expr, "the selected face");
  } else $("plane-choice").hidden = !$("plane-choice").hidden;
};
document.querySelectorAll<HTMLButtonElement>("#plane-choice [data-plane]").forEach((b) => {
  b.onclick = () => { $("plane-choice").hidden = true; startSketch(b.dataset.plane!, b.textContent!); };
});

async function startSketch(planeExpr: string, label: string) {
  if (!(await kernel.whenReady(1000))) { status("The CAD kernel is still loading."); return; }
  const plane = await kernel.sketchPlane(planeExpr);
  if (plane.error) { status(plane.error); return; }
  const bb = state.result?.summary?.bbox;
  const size = bb ? Math.max(40, Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2])) : 100;
  const upto = state.upto, path = state.path!;
  $("plane-choice").hidden = true;
  document.body.classList.add("sketching");
  sketcher.start(plane, label, size, async (shapes, op) => {
    document.body.classList.remove("sketching");
    const feats = state.result?.timeline?.features ?? [];
    const last = feats.length - 1;
    const src = insertFeatures(editor.text, feats, upto, sketchLines(planeExpr, shapes, op));
    // Stay rolled back if we were, but include the two new features.
    state.upto = upto != null && upto < last ? upto + 2 : null;
    viewer.setSelection([]);
    state.selection = [];
    const res = await applyCode(path, src);
    if (res && !res.ok) status(`The new feature failed: ${res.error?.message ?? ""}`);
  }, () => { document.body.classList.remove("sketching"); });
}

$("new-part").onclick = async () => {
  if (!state.project) return;
  const raw = prompt("Name of the new part (letters, digits, _):", "part");
  const name = raw?.trim().replace(/\.py$/, "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1");
  if (!name) return;
  const path = `${name}.py`;
  if ((await state.project.list()).includes(path)) { status(`${path} already exists.`); return; }
  await applyCode(path, newPartSource(name));
  status(`Created ${path}. Click ✎ Sketch to start modelling.`);
};

// For tests and debugging in the console.
Object.assign(window, { caad: { editor, viewer, kernel, state, rebuild, openPart, applyCode, agents, sketcher, startSketch } });
