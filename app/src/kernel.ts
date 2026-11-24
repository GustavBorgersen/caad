// Client for the kernel worker. Builds: only the latest pending one is kept, so when edits come in
// faster than rebuilds, intermediate states are skipped. Calls (selection queries) run in order.
// Every answer carries `gen`, the number of builds done, so answers about an older model can be ignored.

export type Mesh = {
  positions: Float32Array;
  indices: Uint32Array;
  faces: [number, number][]; // [first index, index count] per face
  face_types: string[];
  edges: { points: Float32Array; type: string }[];
  bbox: number[];
};

export type Feature = {
  index: number; line: number; end: number; label: string; kind: string;
  status: "ok" | "error" | "skipped" | "rolled-back";
};

export type BuildResult = {
  ok: boolean;
  timeline: { part: string | null; block_line: number | null; features: Feature[] } | null;
  upto: number | null;
  error: { feature: number | null; line: number | null; message: string } | null;
  mesh: Mesh | null;
  summary: { type: string; faces: number; edges: number; bbox: number[]; volume?: number } | null;
  times: { build: number; mesh: number };
  gen: number;
};

export type Kind = "face" | "edge";
export type SelectedItem = { kind: Kind; index: number; type: string; [prop: string]: unknown };
export type Selector = { expr: string; fragile: boolean };
export type SelectInfo = { items: SelectedItem[]; selectors: Selector[]; gen: number };

type Waiter = { resolve: (r: any) => void; reject: (e: Error) => void };
type PendingBuild = Waiter & { src: string; filename: string; upto: number | null };

export class Kernel {
  private worker = new Worker(new URL("./kernel.worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private waiting = new Map<number, Waiter>();
  private buildInflight = false;
  private pendingBuild: PendingBuild | null = null;
  ready = false;
  onStatus: (text: string) => void = () => {};
  onReady: (seconds: number) => void = () => {};
  onLog: (text: string) => void = (t) => console.log("[python]", t);

  constructor() {
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "status") this.onStatus(m.text);
      else if (m.type === "log") this.onLog(m.text);
      else if (m.type === "failed") this.onStatus("Kernel failed to start: " + m.text);
      else if (m.type === "ready") { this.ready = true; this.onReady(m.seconds); }
      else if (m.type === "result") {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) w?.reject(new Error(m.error));
        else w?.resolve(m.result && typeof m.result === "object" && !Array.isArray(m.result) ? { ...m.result, gen: m.gen } : { value: m.result, gen: m.gen });
      }
    };
    this.worker.onerror = (e) => this.onStatus("Kernel error: " + (e.message || "worker failed to start"));
  }

  /** Build a part (up to feature `upto`). Resolves null if a newer request replaced this one. */
  build(src: string, filename: string, upto: number | null = null): Promise<BuildResult | null> {
    return new Promise((resolve, reject) => {
      this.pendingBuild?.resolve(null);
      this.pendingBuild = { src, filename, upto, resolve, reject };
      if (!this.buildInflight) this.sendBuild();
    });
  }

  /** Describe selected faces or edges of the current model, with verified selectors. */
  select(kind: Kind, indices: number[]): Promise<SelectInfo> {
    return this.call("select", [kind, indices]);
  }

  /** Indices a selector picks in the current model (to keep a selection across rebuilds). */
  resolve(kind: Kind, expr: string): Promise<{ value: number[]; gen: number }> {
    return this.call("resolve", [kind, expr]);
  }

  /** Run code against a copy of the open part's namespace (for the agent). */
  snippet(code: string): Promise<{ output: string; value: unknown; error: string | null; gen: number }> {
    return this.call("snippet", [code]);
  }

  /** Signature and docs of a build123d name, from the page's own build123d. */
  apiHelp(name: string): Promise<{ value: string; gen: number }> {
    return this.call("api_help", [name]);
  }

  /** Face and edge indices a selector picks (or an error). */
  highlightIndices(expr: string): Promise<{ faces?: number[]; edges?: number[]; error?: string; gen: number }> {
    return this.call("highlight_indices", [expr]);
  }

  /** The plane a sketch on a Plane expression or flat-face selector uses. */
  sketchPlane(expr: string): Promise<{ origin: number[]; x: number[]; y: number[]; z: number[]; error?: string; gen: number }> {
    return this.call("sketch_plane", [expr]);
  }

  /** Resolves when the kernel has loaded. */
  whenReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const start = Date.now();
      const t = setInterval(() => {
        if (this.ready || Date.now() - start > timeoutMs) { clearInterval(t); resolve(this.ready); }
      }, 250);
    });
  }

  private call<T>(fn: string, args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, type: "call", fn, args });
    });
  }

  private sendBuild() {
    const p = this.pendingBuild;
    if (!p) return;
    this.pendingBuild = null;
    this.buildInflight = true;
    const id = this.nextId++;
    const done = () => { this.buildInflight = false; this.sendBuild(); };
    this.waiting.set(id, { resolve: (r) => { done(); p.resolve(r); }, reject: (e) => { done(); p.reject(e); } });
    this.worker.postMessage({ id, type: "run", src: p.src, filename: p.filename, upto: p.upto });
  }
}
