// Client for the kernel worker. Only the latest pending request is kept: when edits come in
// faster than rebuilds, intermediate states are skipped.

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
  times: { build: number; mesh: number };
};

type Pending = {
  src: string; filename: string; upto: number | null;
  resolve: (r: BuildResult | null) => void; reject: (e: Error) => void;
};

export class Kernel {
  private worker = new Worker(new URL("./kernel.worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private inflight: { id: number; resolve: (r: BuildResult | null) => void; reject: (e: Error) => void } | null = null;
  private pending: Pending | null = null;
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
      else if (m.type === "result" && this.inflight?.id === m.id) {
        const done = this.inflight!;
        this.inflight = null;
        if (m.error) done.reject(new Error(m.error)); else done.resolve(m.result);
        this.next();
      }
    };
    this.worker.onerror = (e) => this.onStatus("Kernel error: " + (e.message || "worker failed to start"));
  }

  /** Build a part (up to feature `upto`). Resolves null if a newer request replaced this one. */
  build(src: string, filename: string, upto: number | null = null): Promise<BuildResult | null> {
    return new Promise((resolve, reject) => {
      this.pending?.resolve(null);
      this.pending = { src, filename, upto, resolve, reject };
      if (!this.inflight) this.next();
    });
  }

  private next() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const id = this.nextId++;
    this.inflight = { id, resolve: p.resolve, reject: p.reject };
    this.worker.postMessage({ id, type: "run", src: p.src, filename: p.filename, upto: p.upto });
  }
}
