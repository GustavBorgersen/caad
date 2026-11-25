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
  /** Last-modified time, used to notice edits from outside (the agent, another editor). */
  modified(path: string): Promise<number>;
}

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
  constructor(private root: FileSystemDirectoryHandle) {}
  get name() { return this.root.name; }

  async scan() {
    const out: ScannedFile[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string, depth: number) => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "directory") {
          if (!SKIP.has(name) && !name.startsWith(".") && depth < MAX_DEPTH) await walk(handle, prefix + name + "/", depth + 1);
        } else if (name.endsWith(".py") || name === "pyproject.toml") {
          out.push({ path: prefix + name, text: await (await handle.getFile()).text() });
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

  async read(path: string) { return (await (await this.file(path)).getFile()).text(); }
  async blob(path: string) { return (await this.file(path)).getFile(); }
  async modified(path: string) { return (await (await this.file(path)).getFile()).lastModified; }
  async write(path: string, text: string) {
    const w = await (await this.file(path, true)).createWritable();
    await w.write(text);
    await w.close();
  }
}

class ExamplesWorkspace implements Workspace {
  readonly name = "Examples";
  readonly writable = false; // edits stay in memory
  private files = new Map<string, { text: string; t: number }>();
  constructor(files: Record<string, string>) {
    for (const [path, text] of Object.entries(files)) this.files.set(path.replace(/^(\.\.\/)*examples\//, ""), { text, t: 0 });
  }
  async scan() { return [...this.files].map(([path, f]) => ({ path, text: f.text })).sort((a, b) => a.path.localeCompare(b.path)); }
  async read(path: string) { return this.files.get(path)?.text ?? ""; }
  async blob(path: string) { return new Blob([this.files.get(path)?.text ?? ""]); }
  async modified(path: string) { return this.files.get(path)?.t ?? 0; }
  async write(path: string, text: string) { this.files.set(path, { text, t: Date.now() }); }
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

export async function openFolder(): Promise<Workspace> {
  const root = await window.showDirectoryPicker({ mode: "readwrite", id: "caad-project" });
  await idb("readwrite", (s) => s.put(root, KEY)).catch(() => {});
  return new FolderWorkspace(root);
}

export async function lastFolder(): Promise<FileSystemDirectoryHandle | null> {
  try { return (await idb<FileSystemDirectoryHandle | undefined>("readonly", (s) => s.get(KEY))) ?? null; }
  catch { return null; }
}

/** Reopen the remembered folder; must be called from a click (the browser asks for permission). */
export async function reopen(handle: FileSystemDirectoryHandle): Promise<Workspace | null> {
  const ok = (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  return ok ? new FolderWorkspace(handle) : null;
}
