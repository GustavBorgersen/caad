import "./style.css";
import { Editor } from "./editor";
import { Kernel, type BuildResult } from "./kernel";
import { canOpenFolders, examples, lastFolder, openFolder, reopen, type Project } from "./project";
import { renderTimeline } from "./timeline";
import { Viewer } from "./viewer";

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

async function rebuild() {
  if (!state.path) return;
  if (!kernel.ready) { status("Waiting for the kernel…"); }
  const t = performance.now();
  let r: BuildResult | null;
  try { r = await kernel.build(editor.text, state.path, state.upto); }
  catch (e) { status("Kernel error: " + (e as Error).message); return; }
  if (!r) return; // replaced by a newer build
  state.result = r;
  viewer.setMesh(r.mesh, state.fitNext && !!r.mesh);
  if (r.mesh) state.fitNext = false;
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
}

// --- Files ------------------------------------------------------------------------------------

async function setProject(p: Project) {
  state.project = p;
  state.path = null;
  $("project-name").textContent = p.name + (p.writable ? "" : " (read-only, edits stay in the browser)");
  const parts = await p.list();
  const ul = $("parts");
  ul.replaceChildren(...parts.map((path) => {
    const li = document.createElement("li");
    li.textContent = path;
    li.onclick = () => openPart(path);
    return li;
  }));
  if (!parts.length) ul.innerHTML = `<li class="muted">No build123d files found</li>`;
  else openPart(parts[0]);
}

async function openPart(path: string) {
  if (!state.project) return;
  state.path = path;
  state.upto = null;
  state.fitNext = true;
  for (const li of $("parts").children) li.classList.toggle("active", li.textContent === path);
  $("file-name").textContent = path;
  editor.setText(await state.project.read(path));
  state.modified = await state.project.modified(path);
  rebuild();
}

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

// For tests and debugging in the console.
Object.assign(window, { caad: { editor, viewer, kernel, state, rebuild, openPart } });
