// The folder you open is a workspace: a local folder (File System Access API, Chrome/Edge) or the bundled
// examples (in memory, so the site works without opening anything). Projects are folders in it with a
// pyproject.toml that has a [tool.caad] table; each has parts/, assemblies/, exports/, print/ (docs/07).

export interface Workspace {
  readonly name: string;
  readonly writable: boolean;
  /** The files CAAD cares about: .py and pyproject.toml with their text, exports and print files without. */
  scan(): Promise<ScannedFile[]>;
  read(path: string): Promise<string>;
  /** The file as it is on disk, for downloads (exports). */
  blob(path: string): Promise<Blob>;
  write(path: string, text: string): Promise<void>;
  /** A binary file (exports). */
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  /** Last-modified time, used to notice edits from outside (the agent, another editor). */
  modified(path: string): Promise<number>;
  /** Whether a file or folder exists. */
  exists(path: string): Promise<boolean>;
  /** Delete a file or a folder with everything in it; returns what it held, so Undo can put it back. */
  remove(path: string): Promise<Snapshot>;
  /** Every file under a path (or the file itself) with its bytes, nothing changed: for copies. */
  snapshot(path: string): Promise<Snapshot>;
  /** Put deleted files back. */
  restore(snapshot: Snapshot): Promise<void>;
  /** Rename or move a file or a folder (with everything in it). */
  rename(from: string, to: string): Promise<void>;
}

/** Deleted files, kept in memory until the page closes: every file under the deleted path, with its bytes. */
export type Snapshot = { path: string; files: { path: string; data: Uint8Array }[] };

export type ScannedFile = { path: string; text?: string };
export type FileKind = "part" | "shared" | "assembly" | "export" | "print";
export type ProjectFile = { path: string; kind: FileKind };
export type ProjectInfo = { root: string; name: string; files: ProjectFile[] };
/** The workspace's projects, and build123d parts that are in none (`loose`). */
export type WorkspaceIndex = { projects: ProjectInfo[]; loose: ProjectFile[] };

const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".mypy_cache"]);
const MAX_DEPTH = 6;
const EXPORTS = /\.(step|stp|stl|3mf)$/i;
const PRINT = /\.(gcode|bgcode)$/i;
const isProjectFile = (text: string) => /^\s*\[tool\.caad\]/m.test(text);
const usesBuild123d = (text: string) => /^\s*(from build123d import|import build123d)/m.test(text);
const hasPart = (text: string) => /^\s*with\s+BuildPart\s*\(/m.test(text);
const dirOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/** Projects and their files by kind: a part has a `BuildPart` block, other .py files in a project are shared code. */
export function indexWorkspace(files: ScannedFile[], workspaceName: string): WorkspaceIndex {
  const roots = files.filter((f) => f.path.split("/").pop() === "pyproject.toml" && isProjectFile(f.text ?? "")).map((f) => dirOf(f.path));
  const rootOf = (path: string) => roots.filter((r) => r === "" || path.startsWith(r + "/")).sort((a, b) => b.length - a.length)[0];
  const projects = new Map<string, ProjectInfo>(roots.sort().map((r) => [r, { root: r, name: r.split("/").pop() || workspaceName, files: [] }]));
  const loose: ProjectFile[] = [];
  for (const f of files) {
    const root = rootOf(f.path);
    const rel = root === undefined ? f.path : root === "" ? f.path : f.path.slice(root.length + 1);
    let kind: FileKind | null = null;
    if (f.path.endsWith(".py")) {
      const text = f.text ?? "";
      if (root === undefined) kind = usesBuild123d(text) && hasPart(text) ? "part" : null;
      else kind = rel.startsWith("assemblies/") ? "assembly" : hasPart(text) ? "part" : "shared";
    } else if (EXPORTS.test(f.path)) kind = "export";
    else if (PRINT.test(f.path) || rel.startsWith("print/")) kind = root === undefined ? null : "print";
    if (!kind) continue;
    if (root === undefined) loose.push({ path: f.path, kind });
    else projects.get(root)!.files.push({ path: f.path, kind });
  }
  for (const p of projects.values()) p.files.sort((a, b) => a.path.localeCompare(b.path));
  return { projects: [...projects.values()], loose: loose.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** The project a file belongs to, if any. */
export function projectOf(index: WorkspaceIndex, path: string): ProjectInfo | undefined {
  return index.projects.filter((p) => p.root === "" || path.startsWith(p.root + "/")).sort((a, b) => b.root.length - a.root.length)[0];
}

/** pyproject.toml for a new project. */
export function projectFile(name: string): string {
  return `[project]\nname = "${name}"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = ["build123d==0.13.*"]   # the version CAAD runs\n\n[tool.caad]\nformat = 1\n`;
}

class FolderWorkspace implements Workspace {
  readonly writable = true;
  // Files with Windows line endings (\r\n): CAAD works on their text with \n, and writes them back with \r\n.
  private crlf = new Set<string>();
  constructor(private root: FileSystemDirectoryHandle) {}
  get name() { return this.root.name; }

  /** A file's text with \n line endings, remembering whether it had \r\n. */
  private lf(path: string, text: string) {
    if (text.includes("\r\n")) this.crlf.add(path);
    else this.crlf.delete(path);
    return text.replace(/\r\n/g, "\n");
  }

  async scan() {
    const out: ScannedFile[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string, depth: number) => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "directory") {
          if (!SKIP.has(name) && !name.startsWith(".") && depth < MAX_DEPTH) await walk(handle, prefix + name + "/", depth + 1);
        } else if (name.endsWith(".py") || name === "pyproject.toml") {
          out.push({ path: prefix + name, text: this.lf(prefix + name, await (await handle.getFile()).text()) });
        } else if (EXPORTS.test(name) || PRINT.test(name)) out.push({ path: prefix + name });
      }
    };
    await walk(this.root, "", 0);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async file(path: string, create = false) {
    const parts = path.split("/");
    let dir = this.root;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
    return dir.getFileHandle(parts[parts.length - 1], { create });
  }

  async read(path: string) { return this.lf(path, await (await this.file(path)).getFile().then((f) => f.text())); }
  async blob(path: string) { return (await this.file(path)).getFile(); }
  async modified(path: string) { return (await (await this.file(path)).getFile()).lastModified; }
  async write(path: string, text: string) {
    text = text.replace(/\r\n/g, "\n");
    const w = await (await this.file(path, true)).createWritable();
    await w.write(this.crlf.has(path) ? text.replace(/\n/g, "\r\n") : text);
    await w.close();
  }
  async writeBytes(path: string, data: Uint8Array) {
    const w = await (await this.file(path, true)).createWritable();
    await w.write(data as Uint8Array<ArrayBuffer>);
    await w.close();
  }

  /** The folder holding `path`, and `path`'s own name in it. */
  private async parent(path: string, create = false): Promise<[FileSystemDirectoryHandle, string]> {
    const parts = path.split("/");
    let dir = this.root;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
    return [dir, parts[parts.length - 1]];
  }

  private async handle(path: string): Promise<FileSystemHandle | null> {
    try {
      const [dir, name] = await this.parent(path);
      try { return await dir.getFileHandle(name); } catch { return await dir.getDirectoryHandle(name); }
    } catch { return null; }
  }

  async exists(path: string) { return !!(await this.handle(path)); }

  /** Every file under `path` (or the file itself), with its bytes. */
  private async collect(path: string): Promise<Snapshot["files"]> {
    const h = await this.handle(path);
    if (!h) return [];
    const out: Snapshot["files"] = [];
    const walk = async (handle: FileSystemHandle, at: string) => {
      if (handle.kind === "file") out.push({ path: at, data: new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer()) });
      else for await (const [name, child] of (handle as FileSystemDirectoryHandle).entries()) await walk(child, `${at}/${name}`);
    };
    await walk(h, path);
    return out;
  }

  async snapshot(path: string) { return { path, files: await this.collect(path) }; }

  async remove(path: string) {
    const files = await this.collect(path);
    const [dir, name] = await this.parent(path);
    await dir.removeEntry(name, { recursive: true });
    return { path, files };
  }

  async restore(s: Snapshot) {
    for (const f of s.files) await this.writeBytes(f.path, f.data);
    if (!s.files.length) await this.parent(`${s.path}/x`, true); // an empty folder
  }

  async rename(from: string, to: string) {
    if (await this.exists(to)) throw new Error(`${to} already exists.`);
    const files = await this.collect(from);
    for (const f of files) {
      await this.writeBytes(to + f.path.slice(from.length), f.data);
      if (this.crlf.has(f.path)) this.crlf.add(to + f.path.slice(from.length));
    }
    const [dir, name] = await this.parent(from);
    await dir.removeEntry(name, { recursive: true });
  }
}

class ExamplesWorkspace implements Workspace {
  readonly name = "Examples";
  readonly writable = false; // edits stay in memory
  private files = new Map<string, { text: string; t: number }>();
  private binaries = new Map<string, { data: Uint8Array; t: number }>(); // exports, kept in memory like the edits
  constructor(files: Record<string, string>) {
    for (const [path, text] of Object.entries(files)) this.files.set(path.replace(/^(\.\.\/)*examples\//, ""), { text, t: 0 });
  }
  async scan() {
    return [...[...this.files].map(([path, f]) => ({ path, text: f.text })), ...[...this.binaries.keys()].map((path) => ({ path }))]
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  async read(path: string) { return this.files.get(path)?.text ?? ""; }
  async blob(path: string) {
    const b = this.binaries.get(path);
    return new Blob([b ? (b.data as Uint8Array<ArrayBuffer>) : this.files.get(path)?.text ?? ""]);
  }
  async modified(path: string) { return this.files.get(path)?.t ?? this.binaries.get(path)?.t ?? 0; }
  async write(path: string, text: string) { this.files.set(path, { text, t: Date.now() }); }
  async writeBytes(path: string, data: Uint8Array) { this.binaries.set(path, { data, t: Date.now() }); }

  private under(path: string): string[] {
    return [...this.files.keys(), ...this.binaries.keys(), ...this.folders].filter((p) => p === path || p.startsWith(path + "/"));
  }
  private folders = new Set<string>(); // empty folders made by restoring one
  async exists(path: string) { return this.under(path).length > 0; }
  async snapshot(path: string) {
    const enc = new TextEncoder();
    return { path, files: this.under(path).filter((p) => !this.folders.has(p))
      .map((p) => ({ path: p, data: this.binaries.get(p)?.data ?? enc.encode(this.files.get(p)!.text) })) };
  }
  async remove(path: string) {
    const { files } = await this.snapshot(path);
    for (const p of this.under(path)) { this.files.delete(p); this.binaries.delete(p); this.folders.delete(p); }
    return { path, files };
  }
  async restore(s: Snapshot) {
    const dec = new TextDecoder();
    for (const f of s.files) {
      if (/\.(py|toml|txt|md)$/.test(f.path)) this.files.set(f.path, { text: dec.decode(f.data), t: Date.now() });
      else this.binaries.set(f.path, { data: f.data, t: Date.now() });
    }
    if (!s.files.length) this.folders.add(s.path);
  }
  async rename(from: string, to: string) {
    if (await this.exists(to)) throw new Error(`${to} already exists.`);
    for (const p of this.under(from)) {
      const q = to + p.slice(from.length);
      const f = this.files.get(p), b = this.binaries.get(p);
      if (f) { this.files.set(q, { ...f, t: Date.now() }); this.files.delete(p); }
      if (b) { this.binaries.set(q, { ...b, t: Date.now() }); this.binaries.delete(p); }
      if (this.folders.delete(p)) this.folders.add(q);
    }
  }
}

export function examples(): Workspace {
  const files = import.meta.glob(["../../examples/**/*.py", "../../examples/**/pyproject.toml"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  return new ExamplesWorkspace(files);
}

// --- Remember the last folder (the browser keeps the handle; permission is asked again on reopen)

const DB = "caad", STORE = "handles", KEY = "last-folder";
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = fn(open.result.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

export const canOpenFolders = () => "showDirectoryPicker" in window;

/** A workspace opened before: the browser keeps its handle, and asks for permission again after a restart. */
export type Recent = { handle: FileSystemDirectoryHandle; name: string; projects: number; t: number };
const RECENT = "recent", MAX_RECENT = 6;

export async function recentFolders(): Promise<Recent[]> {
  try {
    const list = (await idb<Recent[] | undefined>("readonly", (s) => s.get(RECENT))) ?? [];
    const old = await idb<FileSystemDirectoryHandle | undefined>("readonly", (s) => s.get(KEY)); // before the list existed
    if (old && !list.some((r) => r.name === old.name)) list.push({ handle: old, name: old.name, projects: 0, t: 0 });
    return list.sort((a, b) => b.t - a.t);
  } catch { return []; }
}

/** Remember a folder as the most recent workspace (with its number of projects, shown in the lists). */
export async function rememberFolder(handle: FileSystemDirectoryHandle, projects: number) {
  const list = (await recentFolders()).filter((r) => r.handle !== handle && r.name !== handle.name);
  list.unshift({ handle, name: handle.name, projects, t: Date.now() });
  await idb("readwrite", (s) => s.put(list.slice(0, MAX_RECENT), RECENT)).catch(() => {});
  await idb("readwrite", (s) => s.delete(KEY)).catch(() => {});
}

/** Forget a folder (the lists only: nothing on disk changes). */
export async function forgetFolder(name: string) {
  const list = (await recentFolders()).filter((r) => r.name !== name);
  await idb("readwrite", (s) => s.put(list, RECENT)).catch(() => {});
  await idb("readwrite", (s) => s.delete(KEY)).catch(() => {});
}

export async function openFolder(): Promise<{ workspace: Workspace; handle: FileSystemDirectoryHandle }> {
  const root = await window.showDirectoryPicker({ mode: "readwrite", id: "caad-project" });
  return { workspace: new FolderWorkspace(root), handle: root };
}

/** Whether a remembered folder can be opened without asking (the browser kept the permission). */
export async function canReopen(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try { return (await handle.queryPermission({ mode: "readwrite" })) === "granted"; } catch { return false; }
}

/** Reopen a remembered folder; from a click, unless canReopen (the browser may ask for permission). */
export async function reopen(handle: FileSystemDirectoryHandle): Promise<Workspace | null> {
  const ok = (await canReopen(handle)) || (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  return ok ? new FolderWorkspace(handle) : null;
}
