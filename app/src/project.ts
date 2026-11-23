// A project is a folder of build123d part files: a local folder (File System Access API, Chrome/Edge)
// or the bundled examples (in memory, so the site works without opening anything).

export interface Project {
  readonly name: string;
  readonly writable: boolean;
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  /** Last-modified time, used to notice edits from outside (the agent, another editor). */
  modified(path: string): Promise<number>;
}

const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".mypy_cache"]);
const MAX_DEPTH = 5;
const isPart = (text: string) => /^\s*(from build123d import|import build123d)/m.test(text);

class FolderProject implements Project {
  readonly writable = true;
  constructor(private root: FileSystemDirectoryHandle) {}
  get name() { return this.root.name; }

  async list() {
    const out: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string, depth: number) => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "directory") {
          if (!SKIP.has(name) && !name.startsWith(".") && depth < MAX_DEPTH) await walk(handle, prefix + name + "/", depth + 1);
        } else if (name.endsWith(".py") && isPart(await (await handle.getFile()).text())) out.push(prefix + name);
      }
    };
    await walk(this.root, "", 0);
    return out.sort();
  }

  private async file(path: string, create = false) {
    const parts = path.split("/");
    let dir = this.root;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
    return dir.getFileHandle(parts[parts.length - 1], { create });
  }

  async read(path: string) { return (await (await this.file(path)).getFile()).text(); }
  async modified(path: string) { return (await (await this.file(path)).getFile()).lastModified; }
  async write(path: string, text: string) {
    const w = await (await this.file(path, true)).createWritable();
    await w.write(text);
    await w.close();
  }
}

class ExamplesProject implements Project {
  readonly name = "Examples";
  readonly writable = false; // edits stay in memory
  private files = new Map<string, { text: string; t: number }>();
  constructor(files: Record<string, string>) {
    for (const [path, text] of Object.entries(files)) this.files.set(path.split("/").pop()!, { text, t: 0 });
  }
  async list() { return [...this.files.keys()].sort(); }
  async read(path: string) { return this.files.get(path)?.text ?? ""; }
  async modified(path: string) { return this.files.get(path)?.t ?? 0; }
  async write(path: string, text: string) { this.files.set(path, { text, t: Date.now() }); }
}

export function examples(): Project {
  const files = import.meta.glob("../../examples/*.py", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  return new ExamplesProject(files);
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

export async function openFolder(): Promise<Project> {
  const root = await window.showDirectoryPicker({ mode: "readwrite", id: "caad-project" });
  await idb("readwrite", (s) => s.put(root, KEY)).catch(() => {});
  return new FolderProject(root);
}

export async function lastFolder(): Promise<FileSystemDirectoryHandle | null> {
  try { return (await idb<FileSystemDirectoryHandle | undefined>("readonly", (s) => s.get(KEY))) ?? null; }
  catch { return null; }
}

/** Reopen the remembered folder; must be called from a click (the browser asks for permission). */
export async function reopen(handle: FileSystemDirectoryHandle): Promise<Project | null> {
  const ok = (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  return ok ? new FolderProject(handle) : null;
}
