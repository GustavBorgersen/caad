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
  /** type: tailored dialog; call: generic dialog from the signature; code: edited as text (docs/05). */
  tier: "type" | "call" | "code";
  name: string | null; // `with BuildSketch() as name`
  refs: string[]; // names of earlier features it uses
  implicit?: boolean; // a sketch that adds its faces to the pending ones
  pending?: string[]; // the pending sketches an extrude without a sketch uses
  sketch?: { dof?: number; message?: string }; // a constrained sketch: degrees of freedom left (none without a solver)
};

/** A dialog field with the argument's expression (Python's None arrives as undefined) and its value. */
export type FeatureField = {
  name: string; label: string;
  type: "number" | "choice" | "bool" | "sketch" | "edges" | "faces" | "plane" | "expr" | "flip";
  of?: string; template?: string; // flip: the expression is template with {} = field `of`'s expression
  options?: { expr?: string; label: string }[];
  show_if?: Record<string, string | null>;
  extra?: boolean; // not one of the feature type's own fields
  required: boolean;
  default?: string;
  expr?: string;
  value?: string;
  error?: string;
};

export type FeatureDetail = {
  index: number; kind: string; tier: Feature["tier"]; label: string; name?: string; pending: string[];
  sketches: string[]; // named sketches before this feature, for a sketch field
  call?: string; fields?: FeatureField[]; gen: number;
};

export type Value = { value?: string; error?: string };

/** A constrained sketch as the sketch editor sees it (caad_kernel.py: _sketch_model; Python's None arrives as undefined). */
export type SketchEntity = {
  id: string; kind: "point" | "line" | "circle" | "arc";
  ref?: string; // how code refers to it ("rect1.corners[0]"); none: it can't be constrained from the editor
  stmt?: number; // the block statement that made it
  construction: boolean;
  x?: number; y?: number; fixed?: boolean; // point
  p1?: string; p2?: string; // line: point ids
  c?: string; r?: number; s?: string; e?: string; // circle, arc: centre (and ends) as point ids, radius
};
export type SketchConstraint = {
  id: string; type: string; // PlaneGCS type
  method?: string; // the caad call (c.length…); none: built into a shape
  stmt?: number; text: string; builtin: boolean; involves: string[];
  dim?: { expr: string; value: number }; // a dimension: its expression and value (degrees for angles)
};
export type SketchModel = {
  entities: SketchEntity[]; constraints: SketchConstraint[];
  primitives: Record<string, unknown>[]; // PlaneGCS primitives, for solving while dragging
  dof?: number; conflicting: string[]; problem?: string; error?: { line?: number; message: string };
  c: string; statements: { line: number; end: number; text: string }[];
  plane?: string; name?: string; // from sketchOpen
  params?: { name: string; value: number }[]; // from sketchOpen: the part's numeric parameters
};
export type SketchAction =
  | { op: "add"; kind: "point" | "line" | "polyline" | "circle" | "arc" | "rectangle" | "polygon"; args: unknown[]; close?: boolean; construction?: boolean }
  | { op: "constrain"; kind: string; refs: string[]; value?: string | number }
  | { op: "dimension"; constraint: string; expr: string }
  | { op: "move"; points: Record<string, [number, number]>; circles?: Record<string, number> }
  | { op: "delete"; entities: string[]; constraints: string[] };

export type SketchOutline = { name: string; index: number; edges: { points: Float32Array }[] };

export type BuildResult = {
  ok: boolean;
  timeline: { part: string | null; block_line: number | null; features: Feature[] } | null;
  upto: number | null;
  error: { feature: number | null; line: number | null; message: string } | null;
  mesh: Mesh | null;
  /** Named sketches no feature uses yet (up to the rollback bar): drawn as outlines. */
  sketches: SketchOutline[];
  summary: { type: string; faces: number; edges: number; bbox: number[]; volume?: number } | null;
  times: { build: number; mesh: number };
  gen: number;
  preview?: boolean; // set by the page: built from unsaved source for the feature dialog
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

  /** A feature's parameters as expressions, with values in the latest run (roll back to before it first). */
  readFeature(src: string, index: number): Promise<FeatureDetail> {
    return this.call("read_feature", [src, index]);
  }

  /** Source with a feature's arguments changed ({name: expression, or null to remove}); rejects with the reason. */
  async patchFeature(src: string, index: number, kind: string, changes: Record<string, string | null>): Promise<string> {
    return (await this.call<{ value: string }>("patch_feature", [src, index, kind, changes])).value;
  }

  /**
   * Source with a new feature in canonical form after feature `after` (null: at the end, -1: first).
   * A sketch takes {plane, body} and gets the next free name skN; other kinds take the call's arguments.
   */
  insertFeature(src: string, after: number | null, kind: string, params: Record<string, unknown>): Promise<{ src: string; index: number; name?: string }> {
    return this.call("insert_feature", [src, after, kind, params]);
  }

  /** Source without a feature; rejects (with the reason) while a later feature uses it. */
  async deleteFeature(src: string, index: number): Promise<string> {
    return (await this.call<{ value: string }>("delete_feature", [src, index])).value;
  }

  /** Start editing a constrained sketch (feature `index`): its model, plane and name. Rejects if it can't be edited. */
  sketchOpen(src: string, index: number): Promise<SketchModel> {
    return this.call("sketch_open", [src, index]);
  }

  /** Apply sketch editor actions as code edits: the new source, the sketch's model, and the names adds made. */
  sketchAction(src: string, index: number, actions: SketchAction[]): Promise<{ src: string; model: SketchModel; made: string[] }> {
    return this.call("sketch_action", [src, index, actions]);
  }

  /** Values of edited expressions, in the model the last readFeature saw. */
  featureValues(exprs: Record<string, string>): Promise<Record<string, Value>> {
    return this.call("feature_values", [exprs]);
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
