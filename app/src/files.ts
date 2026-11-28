// The Files tab (docs/07 project structure, docs/10 visual system): the workspace's projects, each with its files by
// kind; new, rename, duplicate and delete in the tree (no system popups: names are typed in the row, deletes happen at
// once with Undo in a message), and the workspace switcher.
import { icon, type IconName } from "./icons";
import type { FileKind, ProjectInfo, Recent, Snapshot, Workspace, WorkspaceIndex } from "./project";
import { esc, inlineName, menu, message, popover, type MenuItem } from "./ui";

export type FilesHost = {
  workspace: () => Workspace | null;
  index: () => WorkspaceIndex;
  /** All scanned paths (to check names against). */
  paths: () => string[];
  /** The open file. */
  path: () => string | null;
  /** Parts that failed their last build this session, and files the agent changed that you haven't opened since. */
  failed: () => Set<string>;
  agentChanged: () => Set<string>;
  open: (path: string) => void;
  download: (path: string) => void;
  /** Write a new file and open it. */
  create: (path: string, text: string) => Promise<void>;
  /** Scan the workspace again and redraw. */
  refresh: () => Promise<void>;
  /** A file or folder was renamed (`to`) or deleted (null): follow it (the open file, its history). */
  moved: (from: string, to: string | null) => Promise<void>;
  newProject: () => void;
  makeProject: (folder: string) => void;
  /** The workspace switcher's list: the current one, recent folders, the examples. */
  recents: () => Promise<(Recent & { ready: boolean })[]>;
  switchTo: (choice: { recent?: Recent; examples?: true; pick?: true }) => void;
  forget: (name: string) => void;
  exportPart: (path: string, format: "step" | "stl") => void;
  newPartSource: (name: string) => string;
};

const KINDS: [FileKind | "config", string, string][] = [
  ["part", "Parts", "parts/"], ["shared", "Shared code", ""], ["assembly", "Assemblies", "assemblies/"],
  ["export", "Exports", "exports/"], ["print", "Print", "print/"],
];
const ICON: Record<string, IconName> = { part: "part", shared: "fileCode", assembly: "box", export: "fileDown", print: "fileDown", config: "fileCog" };
const PY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FOLDER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const dirOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const baseOf = (path: string) => path.split("/").pop()!;
const splitExt = (name: string): [string, string] => { const i = name.lastIndexOf("."); return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""]; };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export class FilesPanel {
  private expanded = new Set<string>(); // project roots shown open
  private known = new Set<string>(); // project roots seen (new ones open when they hold the open file)

  constructor(private el: HTMLElement, private host: FilesHost) {}

  /** Redraw the tree from the host's index. */
  render() {
    const idx = this.host.index();
    const open = this.host.path();
    for (const p of idx.projects) {
      if (!this.known.has(p.root)) { this.known.add(p.root); if (idx.projects.length === 1) this.expanded.add(p.root); }
      if (open && (p.root === "" || open.startsWith(p.root + "/"))) this.expanded.add(p.root);
    }
    const rows: string[] = [];
    for (const p of idx.projects) rows.push(...this.projectRows(p));
    const folders = [...new Set(idx.loose.map((f) => dirOf(f.path)))];
    for (const folder of folders) {
      rows.push(this.row({ cls: "project loose dim", icon: "folder", name: folder ? `${folder}/` : this.host.workspace()?.name ?? "", depth: 0, title: "build123d files that are in no CAAD project",
        data: { folder }, chev: undefined, acts: [] }));
      for (const f of idx.loose.filter((x) => dirOf(x.path) === folder)) rows.push(this.fileRow(f.path, f.kind, baseOf(f.path), 1));
    }
    if (!rows.length) rows.push(`<li class="empty-note">No CAAD projects here yet. Use New to start one.</li>`);
    this.el.innerHTML = rows.join("");
    const loose = folders.length ? `<div class="loose-note"><b>${esc(idx.loose.map((f) => baseOf(f.path)).slice(0, 2).join(", "))}${idx.loose.length > 2 ? "…" : ""}</b> ${idx.loose.length === 1 ? "is" : "are"} in no project. ` +
      folders.map((f) => `<button data-make="${esc(f)}">Make ${esc(f || "this folder")} a project</button>`).join(" ") + "</div>" : "";
    this.el.insertAdjacentHTML("beforeend", loose ? `<li class="loose-li" style="display:block;height:auto;cursor:default">${loose}</li>` : "");
    this.bind();
  }

  private projectRows(p: ProjectInfo): string[] {
    const open = this.expanded.has(p.root);
    const parts = p.files.filter((f) => f.kind === "part").length;
    const rows = [this.row({ cls: `project${open ? " open" : ""}`, icon: open ? "folderOpen" : "folder", name: p.name, depth: 0, chev: open, data: { project: p.root },
      title: p.root ? `Project ${p.root}/` : "This folder is a project", meta: open ? "" : plural(parts, "part"), acts: ["plus", "more"] })];
    if (!open) return rows;
    for (const [kind, label, folder] of KINDS) {
      const files = p.files.filter((f) => f.kind === kind);
      if (!files.length && kind !== "part") continue;
      rows.push(this.row({ cls: "group", name: label, depth: 1, meta: String(files.length), data: { group: kind, project: p.root } }));
      for (const f of files) {
        const rel = p.root ? f.path.slice(p.root.length + 1) : f.path;
        rows.push(this.fileRow(f.path, f.kind, folder && rel.startsWith(folder) ? rel.slice(folder.length) : rel, 2));
      }
    }
    const config = `${p.root ? `${p.root}/` : ""}pyproject.toml`;
    if (this.host.paths().includes(config)) rows.push(this.fileRow(config, "config", "pyproject.toml", 1));
    return rows;
  }

  private fileRow(path: string, kind: FileKind | "config", label: string, depth: number): string {
    const [name, ext] = splitExt(label);
    return this.row({ cls: `file ${kind}${path === this.host.path() ? " active" : ""}`, icon: ICON[kind], name, ext, depth, data: { path, kind }, title: path,
      agent: this.host.agentChanged().has(path), err: this.host.failed().has(path), acts: kind === "config" ? ["more"] : ["rename", "more"] });
  }

  private row(o: { cls: string; icon?: IconName; name: string; ext?: string; depth: number; chev?: boolean; data?: Record<string, string>; title?: string;
    meta?: string; agent?: boolean; err?: boolean; acts?: IconName[] }): string {
    const chev = o.chev === undefined ? '<span class="nochev"></span>' : icon("chevron", "chev");
    const data = Object.entries(o.data ?? {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("");
    const focusable = !o.cls.startsWith("group");
    const acts = o.acts?.length ? `<span class="acts">${o.acts.map((a) => `<button data-act="${a}" tabindex="-1" title="${a === "plus" ? "New part" : a === "rename" ? "Rename · F2" : "More"}" aria-label="${a}">${icon(a)}</button>`).join("")}</span>` : "";
    return `<li class="${o.cls}"${data}${focusable ? ' tabindex="0"' : ""}${o.title ? ` title="${esc(o.title)}"` : ""} style="padding-left:${8 + o.depth * 14}px">` +
      `${o.cls.startsWith("group") ? '<span class="nochev"></span>' : chev}${o.icon ? icon(o.icon) : ""}<span class="tn">${esc(o.name)}${o.ext ? `<span class="ext">${esc(o.ext)}</span>` : ""}</span>` +
      `<span class="meta">${o.agent ? '<i class="mark-agent" title="Changed by the agent"></i>' : ""}${o.err ? '<i class="mark-err" title="Fails to build"></i>' : ""}${esc(o.meta ?? "")}</span>${acts}</li>`;
  }

  private bind() {
    for (const li of this.el.querySelectorAll<HTMLElement>("li[tabindex]")) {
      li.onclick = (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "plus") { e.stopPropagation(); this.newFile(li.dataset.project!, "part"); return; }
        if (act === "rename") { e.stopPropagation(); this.rename(li); return; }
        if (act === "more") { e.stopPropagation(); const r = (e.target as HTMLElement).getBoundingClientRect(); this.contextMenu(li, { x: r.left, y: r.bottom + 4 }); return; }
        if (li.classList.contains("editing")) return;
        if (li.dataset.project !== undefined && !li.dataset.path) { this.toggle(li.dataset.project); return; }
        const path = li.dataset.path;
        if (!path) return;
        if (li.dataset.kind === "export" || li.dataset.kind === "print") this.host.download(path);
        else this.host.open(path);
      };
      li.oncontextmenu = (e) => { e.preventDefault(); li.focus(); this.contextMenu(li, { x: e.clientX, y: e.clientY }); };
      li.onkeydown = (e) => {
        if (li.classList.contains("editing")) return;
        if (e.key === "Enter") { e.preventDefault(); li.click(); }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const all = [...this.el.querySelectorAll<HTMLElement>("li[tabindex]")];
          all[all.indexOf(li) + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
        } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && li.dataset.project !== undefined && !li.dataset.path) {
          e.preventDefault();
          if (this.expanded.has(li.dataset.project) !== (e.key === "ArrowRight")) this.toggle(li.dataset.project);
        }
      };
    }
    for (const b of this.el.querySelectorAll<HTMLButtonElement>("[data-make]")) b.onclick = () => this.host.makeProject(b.dataset.make!);
  }

  private toggle(root: string) {
    if (this.expanded.has(root)) this.expanded.delete(root); else this.expanded.add(root);
    this.render();
    this.el.querySelector<HTMLElement>(`li.project[data-project="${CSS.escape(root)}"]`)?.focus();
  }

  /** The focused row, for F2 and Delete. */
  focused(): HTMLElement | null {
    const a = document.activeElement as HTMLElement | null;
    return a && this.el.contains(a) && a.matches("li[tabindex]") ? a : null;
  }

  // --- Menus ------------------------------------------------------------------------------------------------

  private contextMenu(li: HTMLElement, at: { x: number; y: number }) {
    const ws = this.host.workspace();
    if (!ws) return;
    const path = li.dataset.path;
    if (path) {
      const kind = li.dataset.kind!;
      const items: MenuItem[] = [];
      if (kind === "export" || kind === "print") items.push({ label: "Download", icon: "download", run: () => this.host.download(path) });
      else items.push({ label: "Open", icon: kind === "part" ? "part" : "code", run: () => this.host.open(path) });
      if (kind === "part") items.push({ label: "Export STEP", icon: "download", run: () => this.host.exportPart(path, "step") }, { label: "Export STL", icon: "download", run: () => this.host.exportPart(path, "stl") });
      items.push("-");
      if (kind !== "config") items.push({ label: "Rename", icon: "rename", key: "f2", run: () => this.rename(li) }, { label: "Duplicate", icon: "copy", run: () => this.duplicate(path) });
      items.push({ label: "Copy path", icon: "copy", run: () => navigator.clipboard?.writeText(path) }, "-",
        { label: "Delete", icon: "trash", key: "delete", danger: true, run: () => this.remove(path) });
      menu(at, [{ header: baseOf(path), items }]);
    } else if (li.dataset.project !== undefined) {
      const root = li.dataset.project;
      const p = this.host.index().projects.find((x) => x.root === root);
      const n = this.host.paths().filter((x) => root === "" || x.startsWith(root + "/")).length;
      menu(at, [{ header: p?.name ?? root, items: [
        { label: "New part", icon: "part", meta: "parts/", run: () => this.newFile(root, "part") },
        { label: "New shared code", icon: "fileCode", meta: ".py", run: () => this.newFile(root, "shared") },
        "-",
        { label: "Rename", icon: "rename", key: "f2", disabled: root === "", run: () => this.rename(li) },
        { label: "Duplicate", icon: "copy", disabled: root === "", run: () => this.duplicate(root) },
        "-",
        { label: "Delete project", icon: "trash", danger: true, disabled: root === "", meta: plural(n, "file"), run: () => this.remove(root) },
      ] }]);
    }
  }

  /** The New menu (the tree's header): what can be made where you are. */
  newMenu(anchor: HTMLElement) {
    const idx = this.host.index();
    const open = this.host.path();
    const project = idx.projects.find((p) => open && (p.root === "" || open.startsWith(p.root + "/"))) ?? idx.projects[0];
    const sections = [];
    if (project) sections.push({ header: `In ${project.name}`, items: [
      { label: "New part", icon: "part" as IconName, meta: "parts/", run: () => this.newFile(project.root, "part") },
      { label: "New shared code", icon: "fileCode" as IconName, meta: ".py", run: () => this.newFile(project.root, "shared") },
    ] });
    sections.push({ header: "In the workspace", items: [{ label: "New project…", icon: "folder" as IconName, run: () => this.host.newProject(),
      disabled: idx.projects.some((p) => p.root === "") }] });
    menu(anchor, sections, { className: "new-menu" });
  }

  // --- New, rename, duplicate, delete ---------------------------------------------------------------------------

  /** A new part (in parts/) or shared code file (in the project's folder): a row in the tree to type its name in. */
  async newFile(root: string, kind: "part" | "shared") {
    if (!this.host.workspace()) return;
    this.expanded.add(root);
    this.render();
    const folder = `${root ? `${root}/` : ""}${kind === "part" ? "parts/" : ""}`;
    const group = this.el.querySelector<HTMLElement>(`li.group[data-project="${CSS.escape(root)}"][data-group="${kind}"]`);
    const proj = this.el.querySelector<HTMLElement>(`li.project[data-project="${CSS.escape(root)}"]`);
    const temp = document.createElement("li");
    temp.className = "file new";
    temp.style.paddingLeft = `${8 + 2 * 14}px`;
    temp.innerHTML = `<span class="nochev"></span>${icon(ICON[kind])}<span class="tn"></span>`;
    if (group) {
      let last: Element = group;
      while (last.nextElementSibling?.matches("li.file") && (last.nextElementSibling as HTMLElement).dataset.path?.startsWith(folder)) last = last.nextElementSibling;
      last.after(temp);
    } else (proj ?? this.el.lastElementChild ?? this.el).after(temp);
    const taken = new Set(this.host.paths());
    let base = kind === "part" ? "part" : "shared";
    for (let i = 2; taken.has(`${folder}${base}.py`); i++) base = `${kind === "part" ? "part" : "shared"}${i}`;
    const name = await inlineName(temp, {
      value: base, suffix: ".py",
      check: (n) => !n ? "Type a name." : !PY_NAME.test(n) ? "Names of Python files are Python names: letters, digits and _ (no - or spaces, not starting with a digit), so other files can import them."
        : taken.has(`${folder}${n}.py`) ? `${folder}${n}.py already exists.` : null,
      hint: (n) => `Enter creates ${folder}${n}.py`,
    });
    temp.remove();
    if (!name) return;
    const text = kind === "part" ? this.host.newPartSource(name) : `"""Shared code for the parts of this project: import it with \`from ${name} import ...\`."""\n`;
    await this.host.create(`${folder}${name}.py`, text);
    message(`Created ${folder}${name}.py${kind === "part" ? ": press S to sketch" : ""}`);
  }

  /** Rename a file or a project in its row. */
  async rename(li: HTMLElement) {
    const ws = this.host.workspace();
    if (!ws || li.classList.contains("editing")) return;
    const path = li.dataset.path ?? li.dataset.project;
    if (!path || li.dataset.kind === "config") return;
    const isProject = !li.dataset.path;
    const [stem, ext] = isProject ? [baseOf(path), ""] : splitExt(baseOf(path));
    const dir = dirOf(path);
    const taken = new Set(this.host.paths().map((p) => isProject ? p.split("/").slice(0, dir ? dir.split("/").length + 1 : 1).join("/") : p));
    const py = ext === ".py";
    const name = await inlineName(li, {
      value: stem, suffix: ext,
      check: (n) => !n ? "Type a name." : isProject ? (!FOLDER_NAME.test(n) ? "Project names use letters, digits, - and _." : null)
        : py && !PY_NAME.test(n) ? "Names of Python files are Python names: letters, digits and _ (no - or spaces, not starting with a digit), so other files can import them." : null,
      hint: (n) => n === stem ? "Enter keeps the name" : `Enter renames it to ${n}${ext}`,
    });
    if (!name || name === stem) return;
    const to = `${dir ? `${dir}/` : ""}${name}${ext}`;
    if (taken.has(to) || (await ws.exists(to))) { message(`${to} already exists.`, { error: true }); return; }
    try { await ws.rename(path, to); }
    catch (e) { message(`Couldn't rename: ${(e as Error).message}`, { error: true }); return; }
    const fixed = py && li.dataset.kind === "part" ? await this.fixImports(path, to) : 0;
    await this.host.moved(path, to);
    await this.host.refresh();
    message(`Renamed to ${name}${ext}${fixed ? ` · ${plural(fixed, "import")} updated` : ""}`, { action: "Undo", run: async () => {
      await ws.rename(to, path);
      if (fixed) await this.fixImports(to, path);
      await this.host.moved(to, path);
      await this.host.refresh();
      message(`Renamed back to ${baseOf(path)}`); // also tells that the Undo is done: the tree is drawn for good
    } });
  }

  /** After renaming a part: `from parts.old import …` / `import parts.old` in the project's files follow it. */
  private async fixImports(from: string, to: string): Promise<number> {
    const ws = this.host.workspace()!;
    const idx = this.host.index();
    const p = idx.projects.find((x) => x.root === "" || from.startsWith(x.root + "/"));
    if (!p) return 0;
    const mod = (path: string) => (p.root ? path.slice(p.root.length + 1) : path).replace(/\.py$/, "").replace(/\//g, ".");
    const [a, b] = [mod(from), mod(to)];
    const re = new RegExp(`^(\\s*(?:from|import)\\s+)${a.replace(/\./g, "\\.")}(?=[\\s.,]|$)`, "gm");
    let n = 0;
    for (const f of p.files) {
      if (!f.path.endsWith(".py") || f.path === from) continue;
      const text = await ws.read(f.path).catch(() => null);
      if (text === null) continue;
      const out = text.replace(re, (_, lead) => { n++; return lead + b; });
      if (out !== text) await ws.write(f.path, out);
    }
    return n;
  }

  /** A copy next to the original (name_2.py, project-copy), then its name to type. */
  async duplicate(path: string) {
    const ws = this.host.workspace();
    if (!ws) return;
    const isFile = /\.\w+$/.test(path) && this.host.paths().includes(path);
    const [stem, ext] = isFile ? splitExt(path) : [path, ""];
    let to = "";
    for (let i = 2; !to || (await ws.exists(to)); i++) to = isFile ? `${stem}_${i}${ext}` : `${stem}-${i === 2 ? "copy" : `copy${i - 1}`}`;
    const snap = await ws.snapshot(path);
    await ws.restore({ path: to, files: snap.files.map((f) => ({ ...f, path: to + f.path.slice(path.length) })) });
    await this.host.refresh();
    const li = this.el.querySelector<HTMLElement>(isFile ? `li[data-path="${CSS.escape(to)}"]` : `li.project[data-project="${CSS.escape(to)}"]`);
    if (li) this.rename(li);
  }

  /** Delete at once, with Undo in the message (the files are kept in memory until the page closes). */
  async remove(path: string) {
    const ws = this.host.workspace();
    if (!ws) return;
    let snap: Snapshot;
    try { snap = await ws.remove(path); }
    catch (e) { message(`Couldn't delete: ${(e as Error).message}`, { error: true }); return; }
    await this.host.moved(path, null);
    await this.host.refresh();
    const what = snap.files.length > 1 ? `${baseOf(path)} (${plural(snap.files.length, "file")})` : baseOf(path);
    message(`${what} deleted`, { action: "Undo", run: async () => { await ws.restore(snap); await this.host.refresh(); message(`${baseOf(path)} is back`); } });
  }

  // --- The workspace switcher -------------------------------------------------------------------------------------

  async switcher(anchor: HTMLElement) {
    const ws = this.host.workspace();
    const recents = await this.host.recents();
    const ago = (t: number) => {
      if (!t) return "";
      const d = (Date.now() - t) / 86_400_000;
      return d < 1 ? "today" : d < 2 ? "yesterday" : d < 7 ? "this week" : d < 31 ? `${Math.round(d / 7)} weeks ago` : new Date(t).toLocaleDateString(undefined, { month: "long" });
    };
    const el = document.createElement("div");
    el.innerHTML = `<div class="h">Workspaces</div>` +
      recents.map((r, i) => `<div class="row-x"><button class="it${ws?.name === r.name && ws.writable ? " current" : ""}" data-recent="${i}">${icon("folder")}<span class="two">${esc(r.name)}` +
        `<small>${[r.projects ? plural(r.projects, "project") : "", ws?.name === r.name && ws.writable ? "open" : ago(r.t)].filter(Boolean).join(" · ")}</small></span>` +
        `${!r.ready && !(ws?.name === r.name && ws.writable) ? '<span class="tag-warn">click to reconnect</span>' : ws?.name === r.name && ws.writable ? icon("check") : ""}</button>` +
        `<button class="x" data-forget="${esc(r.name)}" title="Remove from this list (nothing on disk changes)">${icon("x")}</button></div>`).join("") +
      `<button class="it${ws && !ws.writable ? " current" : ""}" data-examples>${icon("lock")}<span class="two">Examples<small>bundled · edits stay in this page</small></span></button><hr>` +
      `<button class="it" data-pick>${icon("folderOpen")}<span class="two">Open folder…<small>a folder with projects, or one project</small></span></button>` +
      `<div class="note">The browser's folder picker opens. Pages only learn a folder's name, and after a restart the browser asks once before CAAD may use it again.</div>`;
    const { el: pop, close } = popover(anchor, el, "switcher");
    pop.querySelectorAll<HTMLButtonElement>("[data-recent]").forEach((b) => { b.onclick = () => { close(); this.host.switchTo({ recent: recents[Number(b.dataset.recent)] }); }; });
    pop.querySelectorAll<HTMLButtonElement>("[data-forget]").forEach((b) => { b.onclick = () => { this.host.forget(b.dataset.forget!); b.parentElement!.remove(); }; });
    pop.querySelector<HTMLButtonElement>("[data-examples]")!.onclick = () => { close(); this.host.switchTo({ examples: true }); };
    pop.querySelector<HTMLButtonElement>("[data-pick]")!.onclick = () => { close(); this.host.switchTo({ pick: true }); };
    pop.querySelector<HTMLButtonElement>("button.it")?.focus();
  }
}
