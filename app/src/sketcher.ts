// Sketch editor (docs/06-sketches.md): edits a constrained sketch. Every action is a code edit done by the
// kernel (sketch_action), which returns the sketch's new model; dragging solves in the page with PlaneGCS.
// Done hands back the edited source. No grid snapping: the cursor snaps to existing points instead.
import * as THREE from "three";
import gcsWasm from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import { loadSolver } from "./gcs-solve";
import type { Kernel, SketchAction, SketchEntity, SketchModel } from "./kernel";
import { num } from "./sketch-code";
import type { PointerTool, SketchPlane, Viewer } from "./viewer";

type Tool = "select" | "line" | "rect" | "circle" | "arc" | "point";
const TOOLS: [Tool, string, string][] = [
  ["select", "↖", "Select and drag"], ["line", "╱", "Line"], ["rect", "▭", "Rectangle"],
  ["circle", "◯", "Circle"], ["arc", "◠", "Arc"], ["point", "•", "Point"],
];
const HINTS: Record<Tool, string> = {
  select: "Click to select (Shift: more), drag to move, Delete to remove.",
  line: "Click points; lines join up. Esc, or a click on an existing point, ends the chain.",
  rect: "Click one corner, then the opposite corner.",
  circle: "Click the centre, then a point on the circle.",
  arc: "Click the centre, the start, then the end (counter-clockwise).",
  point: "Click to place a point.",
};
const COLOR = {
  free: 0x1f6feb, constrained: 0x1d2228, construction: 0x8a96a3, selected: 0xe06000, hover: 0xf0a040,
  conflict: 0xc62828, preview: 0xe67e22, grid: 0xdfe4ea, axis: 0xb0bac5,
};
// Constraints shown as small glyphs in the view (not the ones built into shapes).
const GLYPHS: Record<string, string> = {
  horizontal: "H", vertical: "V", parallel: "∥", perpendicular: "⊥", tangent: "⌒", equal: "=",
  coincident: "●", on: "∈", midpoint: "M", symmetric: "⇋", fix: "⚓",
};
const SNAP_PX = 10; // the cursor snaps to points this close
const PICK_PX = 7; // lines and circles are picked this close
const HV_DEGREES = 4; // a new line this close to horizontal or vertical gets that constraint
const PULL = 1000; // while dragging, the cursor's pull weighs this much more than other points staying put (small enough an error to round away)

type XY = [number, number];
/** A cursor position, snapped to an existing point when close: `ref` is how code refers to that point. */
type Snap = { at: XY; ref?: string; id?: string };
export type SketchSession = { src: string; index: number; model: SketchModel };
/** A constraint or dimension the selection allows. */
type Option = { icon: string; title: string; action: SketchAction; dim: boolean };
export type SketchHost = {
  kernel: Kernel;
  done: (src: string) => void; // Done: the part's source with the edited sketch
  cancel: () => void;
  status: (text: string) => void;
};

export class Sketcher implements PointerTool {
  active = false;
  private group = new THREE.Group(); // in the sketch plane's coordinates
  private gridGroup = new THREE.Group();
  private plane!: SketchPlane;
  private label = "";
  private session!: SketchSession;
  private tool: Tool = "select";
  private construction = false;
  private pending: Snap[] = []; // clicks of the shape being drawn
  private chain: string | null = null; // line tool: where the next line starts (the last line's end)
  private cursor: Snap | null = null;
  private selected = new Set<string>(); // entity and constraint ids
  private hover: string | null = null;
  private dragging: { id: string; from: XY; moved: boolean } | null = null;
  private busy = false; // a kernel action is running
  private solver: ReturnType<typeof loadSolver> | null = null;
  private labels = document.createElement("div"); // dimension labels and constraint glyphs over the view
  private params: { name: string; value: number }[] = []; // the part's parameters, offered in dimensions
  private editing: string | null = null; // the dimension whose expression is being typed
  private input = document.createElement("input"); // that expression (kept while the labels redraw)

  constructor(private viewer: Viewer, private panel: HTMLElement, private host: SketchHost) {
    this.group.matrixAutoUpdate = false;
    this.group.renderOrder = 2;
    this.labels.className = "sketch-labels";
    this.input.className = "dim-input";
    this.input.spellcheck = false;
    this.input.setAttribute("list", "sketch-params");
    this.input.onkeydown = (e) => {
      if (e.key === "Enter") this.commitDimension();
      else if (e.key === "Escape") { this.editing = null; this.placeLabels(); }
      e.stopPropagation();
    };
    window.addEventListener("keydown", (e) => {
      if (!this.active || (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "Escape") this.escape();
      else if ((e.key === "Delete" || e.key === "Backspace") && this.selected.size) { e.preventDefault(); this.deleteSelected(); }
    });
  }

  get model(): SketchModel { return this.session.model; }
  get src(): string { return this.session.src; }
  /** For tests: no kernel action running. */
  get idle(): boolean { return !this.busy; }

  /** For tests: where a sketch point is on the screen (client coordinates). */
  screen(at: XY): { x: number; y: number } {
    const p = this.viewer.toScreen(new THREE.Vector3(at[0], at[1], 0).applyMatrix4(this.group.matrix));
    const r = this.viewer.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }

  /** Open the editor on a sketch session (from kernel.sketchOpen). `label` says where it is drawn. */
  open(plane: SketchPlane, label: string, size: number, session: SketchSession) {
    this.plane = plane;
    this.label = label;
    this.session = session;
    this.params = session.model.params ?? [];
    this.editing = null;
    this.tool = session.model.entities.some((e) => this.drawn(e)) ? "select" : "rect";
    this.pending = [];
    this.chain = null;
    this.selected.clear();
    this.active = true;
    this.solver ??= loadSolver(gcsWasm);
    const [x, y, z, o] = [plane.x, plane.y, plane.z, plane.origin].map((v) => new THREE.Vector3(...v));
    this.group.matrix.makeBasis(x, y, z).setPosition(o);
    this.group.matrixWorldNeedsUpdate = true;
    this.group.add(this.gridGroup);
    this.viewer.lookAtPlane(plane, size);
    this.viewer.setFacesFaded(true);
    this.viewer.tool = this;
    this.viewer.onCameraChange = () => { this.updateGrid(); this.placeLabels(); };
    this.viewer.add(this.group);
    this.panel.parentElement!.append(this.labels);
    this.updateGrid();
    this.renderPanel();
    this.redraw();
  }

  stop() {
    this.active = false;
    this.viewer.tool = null;
    this.viewer.onCameraChange = () => {};
    this.viewer.remove(this.group);
    this.viewer.setFacesFaded(false);
    this.viewer.resetUp();
    this.panel.hidden = true;
    this.labels.remove();
  }

  /** Run editor actions as code edits in the kernel; the names adds made. For tests too. */
  async act(actions: SketchAction[]): Promise<string[]> {
    this.busy = true;
    try {
      const r = await this.host.kernel.sketchAction(this.session.src, this.session.index, actions);
      this.session = { ...this.session, src: r.src, model: r.model };
      const ids = new Set([...r.model.entities.map((e) => e.id), ...r.model.constraints.map((c) => c.id)]);
      for (const id of [...this.selected]) if (!ids.has(id)) this.selected.delete(id);
      return r.made;
    } catch (e) {
      this.host.status((e as Error).message);
      return [];
    } finally {
      this.busy = false;
      this.renderPanel();
      this.redraw();
    }
  }

  // --- Geometry helpers ---------------------------------------------------------------------------

  private entity(id: string | undefined): SketchEntity | undefined {
    return id ? this.model.entities.find((e) => e.id === id) : undefined;
  }

  private xy(id: string | undefined): XY {
    const p = this.entity(id);
    return [p?.x ?? 0, p?.y ?? 0];
  }

  /** The sketch's origin, selectable for dimensions and constraints (code makes it when first used). */
  private get origin(): SketchEntity {
    const ref = `${this.model.c}.origin`;
    return this.model.entities.find((e) => e.ref === ref) ?? { id: "origin", kind: "point", ref, x: 0, y: 0, fixed: true, construction: true };
  }

  /** Entities drawn in the view: not the origin and its axes (the grid's axes show them). */
  private drawn(e: SketchEntity): boolean {
    const c = this.model.c;
    return !(e.fixed || e.ref?.startsWith(`${c}.x_axis`) || e.ref?.startsWith(`${c}.y_axis`));
  }

  private local(ev: PointerEvent): XY | null {
    const p = this.viewer.hitPlane(ev, this.plane);
    if (!p) return null;
    const d = p.sub(new THREE.Vector3(...this.plane.origin));
    return [d.dot(new THREE.Vector3(...this.plane.x)), d.dot(new THREE.Vector3(...this.plane.y))];
  }

  private px(): number { return this.viewer.pixelSize(new THREE.Vector3(...this.plane.origin)); }

  /** The cursor, snapped to the nearest point (or the origin) when close. */
  private snap(at: XY): Snap {
    const tol = SNAP_PX * this.px();
    let best: Snap = { at };
    let bestD = tol;
    const c = this.model.c;
    const candidates: Snap[] = [{ at: [0, 0], ref: `${c}.origin` }];
    for (const e of this.model.entities) if (e.kind === "point" && this.drawn(e)) candidates.push({ at: [e.x!, e.y!], ref: e.ref, id: e.id });
    for (const s of candidates) {
      const d = Math.hypot(s.at[0] - at[0], s.at[1] - at[1]);
      if (d < bestD) { best = s; bestD = d; }
    }
    return best;
  }

  /** The entity under the cursor: points first, then lines, circles and arcs. */
  private pick(at: XY): string | null {
    const px = this.px();
    let best: string | null = null;
    let bestD = SNAP_PX * px;
    for (const e of [...this.model.entities.filter((x) => this.drawn(x)), this.origin]) {
      if (e.kind !== "point") continue;
      const d = Math.hypot(e.x! - at[0], e.y! - at[1]);
      if (d < bestD) { best = e.id; bestD = d; }
    }
    if (best) return best;
    bestD = PICK_PX * px;
    for (const e of this.model.entities) {
      if (!this.drawn(e)) continue;
      let d = Infinity;
      if (e.kind === "line") d = segmentDistance(at, this.xy(e.p1), this.xy(e.p2));
      else if (e.kind === "circle") d = Math.abs(Math.hypot(at[0] - this.xy(e.c)[0], at[1] - this.xy(e.c)[1]) - e.r!);
      else if (e.kind === "arc") {
        const [c, s, t] = [this.xy(e.c), this.xy(e.s), this.xy(e.e)];
        if (onArc(at, c, s, t)) d = Math.abs(Math.hypot(at[0] - c[0], at[1] - c[1]) - e.r!);
      }
      if (d < bestD) { best = e.id; bestD = d; }
    }
    return best;
  }

  // --- Pointer ------------------------------------------------------------------------------------

  move(ev: PointerEvent) {
    const at = this.local(ev);
    if (!at) return;
    this.cursor = this.tool === "select" ? { at } : this.snap(at);
    this.hover = this.tool === "select" ? this.pick(at) : null;
    this.viewer.canvas.style.cursor = this.hover ? "pointer" : "";
    this.redraw();
  }

  down(ev: PointerEvent): boolean {
    if (this.tool !== "select" || this.busy) return false;
    const at = this.local(ev);
    const id = at && this.pick(at);
    if (!id || !at) return false;
    this.dragging = { id, from: at, moved: false };
    this.dragStart = null;
    return true;
  }

  drag(ev: PointerEvent) {
    const d = this.dragging;
    const at = this.local(ev);
    if (!d || !at) return;
    if (!d.moved && Math.hypot(at[0] - d.from[0], at[1] - d.from[1]) < 3 * this.px()) return;
    d.moved = true;
    this.solveDrag(d.id, d.from, at);
  }

  up(ev: PointerEvent) {
    const d = this.dragging;
    this.dragging = null;
    if (!d) return;
    if (!d.moved) { this.select(d.id, ev.shiftKey || ev.ctrlKey || ev.metaKey); return; }
    // Write the dragged geometry back: the numbers in the code follow the solved positions.
    const points: Record<string, XY> = {};
    const circles: Record<string, number> = {};
    for (const e of this.model.entities) {
      if (e.kind === "point") points[e.id] = [e.x!, e.y!];
      if (e.kind === "circle") circles[e.id] = e.r!;
    }
    this.act([{ op: "move", points, circles }]);
  }

  click(ev: PointerEvent) {
    const at = this.local(ev);
    if (!at || this.busy) return;
    if (this.tool === "select") {
      const id = this.pick(at);
      if (id) this.select(id, ev.shiftKey || ev.ctrlKey || ev.metaKey);
      else { this.selected.clear(); this.renderPanel(); this.redraw(); }
      return;
    }
    this.place(this.snap(at));
  }

  private select(id: string, add: boolean) {
    if (!add) {
      const only = this.selected.size === 1 && this.selected.has(id);
      this.selected.clear();
      if (!only) this.selected.add(id);
    } else if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.renderPanel();
    this.redraw();
  }

  /**
   * Solve with the dragged point (or a line's points, or a circle's radius) pulled to the cursor, and every other
   * point asked to stay where it is. Both are temporary constraints, which PlaneGCS satisfies as far as the
   * sketch's own constraints allow; the pull weighs 1000 times more. So the point follows the cursor in the
   * directions it is free to move (a corner fixed in x still follows in y), and only what has to move moves.
   */
  private async solveDrag(id: string, from: XY, to: XY) {
    const e = this.entity(id);
    if (!e || !this.solver) return;
    const prims = this.model.primitives.map((p) => ({ ...p }));
    const pulled = new Set<string>();
    const set = (pid: string, x: number, y: number, scale: number) => prims.push(
      { id: `drag_x_${pid}`, type: "coordinate_x", p_id: pid, x, temporary: true, scale },
      { id: `drag_y_${pid}`, type: "coordinate_y", p_id: pid, y, temporary: true, scale });
    const pull = (pid: string, x: number, y: number) => { pulled.add(pid); set(pid, x, y, PULL); };
    const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
    const start = this.dragStart ??= Object.fromEntries(this.model.entities.filter((p) => p.kind === "point").map((p) => [p.id, [p.x!, p.y!] as XY]));
    if (e.kind === "point") pull(e.id, to[0], to[1]);
    else if (e.kind === "line") for (const pid of [e.p1!, e.p2!]) pull(pid, start[pid][0] + dx, start[pid][1] + dy);
    else if (e.kind === "circle" || e.kind === "arc") {
      const c = this.xy(e.c);
      prims.push({ id: "drag_r", type: e.kind === "circle" ? "circle_radius" : "arc_radius", [e.kind === "circle" ? "c_id" : "a_id"]: e.id,
        radius: Math.max(1e-3, Math.hypot(to[0] - c[0], to[1] - c[1])), temporary: true, scale: PULL });
    }
    // Points of the drawn geometry stay, and points on their own; not ones derived from others (a rectangle's
    // centre must follow its corners: a stay there would hold the other corner back).
    const ofCurves = new Set(this.model.entities.flatMap((x) => [x.p1, x.p2, x.c, x.s, x.e]).filter(Boolean));
    const constrained = new Set(this.model.constraints.flatMap((c) => c.involves));
    for (const p of this.model.entities) {
      if (p.kind === "point" && !p.fixed && !pulled.has(p.id) && (ofCurves.has(p.id) || !constrained.has(p.id))) set(p.id, start[p.id][0], start[p.id][1], 1);
    }
    const solver = await this.solver;
    const r = JSON.parse(solver.solve(JSON.stringify(prims)));
    if (r.status !== 0 && r.status !== 1) return; // can't follow (fully constrained): stay
    const byId = new Map<string, Record<string, number>>(r.primitives.map((p: { id: string }) => [p.id, p]));
    for (const ent of this.model.entities) {
      const p = byId.get(ent.id);
      if (!p) continue;
      if (ent.kind === "point") { ent.x = p.x; ent.y = p.y; }
      else if (ent.kind === "circle" || ent.kind === "arc") ent.r = p.radius;
    }
    for (const p of this.model.primitives) { // the next drag step starts from here
      const q = byId.get(p.id as string);
      if (q && p.type === "point") { p.x = q.x; p.y = q.y; }
      if (q && (p.type === "circle" || p.type === "arc")) p.radius = q.radius;
    }
    this.redraw();
  }

  private dragStart: Record<string, XY> | null = null;

  // --- Drawing tools --------------------------------------------------------------------------------

  private arg(s: Snap): string | XY { return s.ref ?? s.at; }

  private async place(s: Snap) {
    const cons = this.construction || undefined;
    if (this.tool === "point") {
      if (!s.ref) await this.act([{ op: "add", kind: "point", args: s.at }]);
      return;
    }
    if (this.tool === "line") {
      const start: Snap | undefined = this.chain ? { at: this.cursor?.at ?? s.at, ref: this.chain } : this.pending[0];
      if (!start) { this.pending = [s]; this.redraw(); return; }
      if (start.ref && start.ref === s.ref) { this.endChain(); return; }
      const from = this.chain ? this.chainAt() : start.at;
      const actions: SketchAction[] = [{ op: "add", kind: "line", args: [this.arg(start), this.arg(s)], construction: cons }];
      const angle = Math.abs(Math.atan2(s.at[1] - from[1], s.at[0] - from[0]) * 180 / Math.PI);
      if (Math.min(angle, 180 - angle) < HV_DEGREES) actions.push({ op: "constrain", kind: "horizontal", refs: ["$0"] });
      else if (Math.abs(angle - 90) < HV_DEGREES) actions.push({ op: "constrain", kind: "vertical", refs: ["$0"] });
      const [made] = await this.act(actions);
      this.pending = [];
      this.chain = made && !s.ref ? `${made}.end` : null; // ending on an existing point closes the chain
      this.redraw();
      return;
    }
    this.pending.push(s);
    const [a, b, c] = this.pending;
    if (this.tool === "rect" && b) {
      this.pending = [];
      const [x0, x1] = [Math.min(a.at[0], b.at[0]), Math.max(a.at[0], b.at[0])];
      const [y0, y1] = [Math.min(a.at[1], b.at[1]), Math.max(a.at[1], b.at[1])];
      if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6) { this.redraw(); return; }
      const corner = (p: XY) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].findIndex(([x, y]) => Math.abs(x - p[0]) < 1e-9 && Math.abs(y - p[1]) < 1e-9);
      const actions: SketchAction[] = [{ op: "add", kind: "rectangle", args: [[x0, y0], [x1, y1]], construction: cons }];
      for (const p of [a, b]) if (p.ref) actions.push({ op: "constrain", kind: "coincident", refs: [`$0.corners[${corner(p.at)}]`, p.ref] });
      await this.act(actions);
    } else if (this.tool === "circle" && b) {
      this.pending = [];
      const r = Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]);
      if (r > 1e-6) await this.act([{ op: "add", kind: "circle", args: [this.arg(a), r], construction: cons }]);
    } else if (this.tool === "arc" && c) {
      this.pending = [];
      const r = Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]);
      const t = Math.atan2(c.at[1] - a.at[1], c.at[0] - a.at[0]);
      const end: string | XY = c.ref ?? [a.at[0] + r * Math.cos(t), a.at[1] + r * Math.sin(t)];
      if (r > 1e-6) await this.act([{ op: "add", kind: "arc", args: [this.arg(a), this.arg(b), end], construction: cons }]);
    }
    this.redraw();
  }

  /** Where the line chain continues: the last line's end. */
  private chainAt(): XY {
    const e = this.model.entities.find((x) => x.ref === this.chain);
    return [e?.x ?? 0, e?.y ?? 0];
  }

  private endChain() { this.chain = null; this.pending = []; this.redraw(); }

  private escape() {
    if (this.pending.length || this.chain) this.endChain();
    else if (this.tool !== "select") this.setTool("select");
    else if (this.selected.size) { this.selected.clear(); this.renderPanel(); this.redraw(); }
  }

  private setTool(t: Tool) {
    this.tool = t;
    this.pending = [];
    this.chain = null;
    this.hover = null;
    this.renderPanel();
    this.redraw();
  }

  /**
   * The constraints and dimensions the selection allows, in the order things were selected (a distance goes
   * from the first point to the second); all selected entities need an expression in code.
   */
  private options(): Option[] {
    const origin = this.origin;
    const sel = [...this.selected].map((id) => (id === origin.id ? origin : this.entity(id))).filter((e): e is SketchEntity => !!e);
    if (!sel.length || sel.some((e) => !e.ref)) return [];
    const of = (k: string) => sel.filter((e) => e.kind === k);
    const [P, L, C, A] = [of("point"), of("line"), of("circle"), of("arc")];
    const n = sel.length, round = [...C, ...A];
    const out: Option[] = [];
    const add = (icon: string, title: string, kind: string, es: SketchEntity[], value?: number) =>
      out.push({ icon, title, dim: value !== undefined, action: { op: "constrain", kind, refs: es.map((e) => e.ref!), value: value === undefined ? undefined : num(value) } });
    const xy = (e: SketchEntity): XY => [e.x!, e.y!];
    const ends = (l: SketchEntity): [XY, XY] => [this.xy(l.p1), this.xy(l.p2)];
    if (P.length === 2 && n === 2) add("●", "Coincident", "coincident", P);
    if ((L.length && n === L.length) || (P.length === 2 && n === 2)) { add("H", "Horizontal", "horizontal", sel); add("V", "Vertical", "vertical", sel); }
    if (L.length === 2 && n === 2) { add("∥", "Parallel", "parallel", L); add("⊥", "Perpendicular", "perpendicular", L); }
    if ((L.length >= 2 && n === L.length) || (round.length >= 2 && n === round.length)) add("=", "Equal", "equal", sel);
    if (n === 2 && round.length >= 1 && !P.length) add("⌒", "Tangent", "tangent", sel);
    if (P.length === 1 && n === 2 && L.length + round.length === 1) add("∈", "Point on it", "on", [P[0], ...L, ...round]);
    if (P.length === 1 && L.length === 1 && n === 2) add("M", "Midpoint", "midpoint", [P[0], L[0]]);
    if (P.length === 2 && L.length === 1 && n === 3) add("⇋", "Symmetric about the line", "symmetric", [...P, L[0]]);
    if (P.length && n === P.length) add("⚓", "Fix where they are", "fix", P);
    // Dimensions start at what they measure now.
    if (L.length === 1 && n === 1) { const [a, b] = ends(L[0]); add("⟷", "Length", "length", L, Math.hypot(b[0] - a[0], b[1] - a[1])); }
    if (P.length === 2 && n === 2) {
      const [a, b] = P.map(xy);
      add("⟷", "Distance", "distance", P, Math.hypot(b[0] - a[0], b[1] - a[1]));
      add("↔", "Horizontal distance", "hdistance", P, b[0] - a[0]);
      add("↕", "Vertical distance", "vdistance", P, b[1] - a[1]);
    }
    if (P.length === 1 && L.length === 1 && n === 2) {
      const [a, b] = ends(L[0]);
      const p = xy(P[0]);
      add("⟷", "Distance to the line", "distance", [P[0], L[0]], Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1));
    }
    if (L.length === 2 && n === 2) {
      const [d1, d2] = L.map((l) => { const [a, b] = ends(l); return [b[0] - a[0], b[1] - a[1]]; });
      add("∠", "Angle (counter-clockwise from the first line)", "angle", L, Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]) * 180 / Math.PI);
    }
    if (C.length === 1 && n === 1) add("⌀", "Diameter", "diameter", C, 2 * C[0].r!);
    if (A.length === 1 && n === 1) add("R", "Radius", "radius", A, A[0].r!);
    return out;
  }

  private async apply(o: Option) {
    const before = new Set(this.model.constraints.map((c) => c.id));
    this.selected.clear();
    await this.act([o.action]);
    const added = this.model.constraints.find((c) => !before.has(c.id) && c.dim);
    if (o.dim && added) this.editDimension(added.id); // type its expression right away
  }

  /** Type a dimension's expression (parameters are offered); Enter applies it, Esc leaves it. */
  editDimension(id: string) {
    const c = this.model.constraints.find((x) => x.id === id);
    if (!c?.dim) return;
    this.editing = id;
    this.input.value = c.dim.expr;
    this.placeLabels();
    this.input.focus();
    this.input.select();
  }

  private async commitDimension() {
    const id = this.editing;
    const expr = this.input.value.trim();
    this.editing = null;
    const c = this.model.constraints.find((x) => x.id === id);
    if (!id || !c?.dim || !expr || expr === c.dim.expr) { this.placeLabels(); return; }
    await this.act([{ op: "dimension", constraint: id, expr }]);
  }

  private deleteSelected() {
    const ents = this.model.entities.filter((e) => !e.fixed).map((e) => e.id).filter((id) => this.selected.has(id));
    const cons = this.model.constraints.map((c) => c.id).filter((id) => this.selected.has(id));
    this.selected.clear();
    this.act([{ op: "delete", entities: ents, constraints: cons }]);
  }

  // --- Rendering ------------------------------------------------------------------------------------

  private color(e: SketchEntity): number {
    if (this.selected.has(e.id)) return COLOR.selected;
    if (this.hover === e.id) return COLOR.hover;
    const conflicting = new Set(this.model.conflicting);
    if (this.model.constraints.some((c) => conflicting.has(c.id) && c.involves.includes(e.id))) return COLOR.conflict;
    if (e.construction && e.kind !== "point") return COLOR.construction;
    return this.model.dof === 0 ? COLOR.constrained : COLOR.free;
  }

  private outline(e: SketchEntity): XY[] {
    if (e.kind === "line") return [this.xy(e.p1), this.xy(e.p2)];
    const c = this.xy(e.c);
    if (e.kind === "circle") return Array.from({ length: 73 }, (_, i) => polar(c, e.r!, (i / 72) * 2 * Math.PI));
    const [a0, a1] = arcAngles(c, this.xy(e.s), this.xy(e.e));
    return Array.from({ length: 49 }, (_, i) => polar(c, e.r!, a0 + ((a1 - a0) * i) / 48));
  }

  private polyline(pts: XY[], color: number, dashed = false) {
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x, y, 0)));
    const px = this.px();
    const material = dashed
      ? new THREE.LineDashedMaterial({ color, depthTest: false, dashSize: 4 * px, gapSize: 3 * px })
      : new THREE.LineBasicMaterial({ color, depthTest: false });
    const line = new THREE.Line(geo, material);
    if (dashed) line.computeLineDistances();
    return line;
  }

  private redraw() {
    if (!this.active) return;
    for (const c of [...this.group.children]) {
      if (c === this.gridGroup) continue;
      this.group.remove(c);
      (c as THREE.Line).geometry.dispose();
    }
    const points: number[] = [], colors: number[] = [];
    for (const e of this.model.entities) {
      if (!this.drawn(e)) continue;
      if (e.kind === "point") {
        points.push(e.x!, e.y!, 0);
        colors.push(...new THREE.Color(this.color(e)).toArray());
      } else this.group.add(this.polyline(this.outline(e), this.color(e), e.construction));
    }
    const o = this.origin; // drawn as a dot: selectable for dimensions
    points.push(0, 0, 0);
    colors.push(...new THREE.Color(this.selected.has(o.id) ? COLOR.selected : this.hover === o.id ? COLOR.hover : COLOR.constrained).toArray());
    const s = this.cursor;
    if (s && this.tool !== "select") {
      const from = this.chain ? this.chainAt() : this.pending[0]?.at;
      const [a, b] = [this.pending[0]?.at, this.pending[1]?.at];
      if (this.tool === "line" && from) this.group.add(this.polyline([from, s.at], COLOR.preview));
      if (this.tool === "rect" && a) this.group.add(this.polyline([a, [s.at[0], a[1]], s.at, [a[0], s.at[1]], a], COLOR.preview));
      if (this.tool === "circle" && a) this.group.add(this.polyline(Array.from({ length: 73 }, (_, i) => polar(a, Math.hypot(s.at[0] - a[0], s.at[1] - a[1]), (i / 72) * 2 * Math.PI)), COLOR.preview));
      if (this.tool === "arc" && a && !b) this.group.add(this.polyline([a, s.at], COLOR.preview));
      if (this.tool === "arc" && a && b) {
        const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const [a0, a1] = arcAngles(a, b, polar(a, r, Math.atan2(s.at[1] - a[1], s.at[0] - a[0])));
        this.group.add(this.polyline(Array.from({ length: 49 }, (_, i) => polar(a, r, a0 + ((a1 - a0) * i) / 48)), COLOR.preview));
      }
      points.push(s.at[0], s.at[1], 0);
      colors.push(...new THREE.Color(s.ref ? COLOR.selected : COLOR.preview).toArray());
    }
    if (points.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      const dots = new THREE.Points(geo, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthTest: false }));
      dots.renderOrder = 3;
      this.group.add(dots);
    }
    const pos = this.panel.querySelector(".cursor");
    if (pos) pos.textContent = s ? `(${num(s.at[0])}, ${num(s.at[1])})` : "";
    this.placeLabels();
    this.viewer.render();
  }

  /**
   * Over the view: dimension labels (the expression, and its value when that differs; click selects, double-click
   * edits) and a glyph per constraint statement (H, V, ∥…; click selects it, Delete removes it).
   */
  private placeLabels() {
    if (!this.active) return;
    const list = document.createElement("datalist");
    list.id = "sketch-params";
    for (const p of this.params) list.append(Object.assign(document.createElement("option"), { value: p.name, label: `= ${num(p.value)}` }));
    this.labels.replaceChildren(list);
    const conflicting = new Set(this.model.conflicting);
    const screen = (ids: string[], dy = 0, dx = 0) => {
      const a = this.anchor(ids);
      if (!a) return null;
      const p = this.viewer.toScreen(new THREE.Vector3(a[0], a[1], 0).applyMatrix4(this.group.matrix));
      return `translate(${p.x + dx}px, ${p.y + dy}px) translate(-50%, -50%)`;
    };
    const glyphs = new Map<number, typeof this.model.constraints>();
    for (const c of this.model.constraints) {
      if (c.dim) {
        // A horizontal and a vertical distance between the same points would overlap: nudge them apart.
        const at = screen(c.involves, c.method === "hdistance" ? -11 : 0, c.method === "vdistance" ? 22 : 0);
        if (!at) continue;
        if (this.editing === c.id) {
          this.input.style.transform = at;
          this.labels.append(this.input);
          continue;
        }
        const el = document.createElement("div");
        el.className = `dim${this.selected.has(c.id) ? " selected" : ""}${conflicting.has(c.id) ? " conflict" : ""}`;
        const value = num(c.dim.value);
        el.textContent = c.dim.expr === value ? value : `${c.dim.expr} = ${value}`;
        el.title = `${c.text} — double-click to change`;
        el.style.transform = at;
        el.onclick = (e) => this.select(c.id, e.shiftKey);
        el.ondblclick = () => this.editDimension(c.id);
        this.labels.append(el);
      } else if (!c.builtin && c.method && GLYPHS[c.method] && c.stmt !== undefined) {
        glyphs.set(c.stmt, [...(glyphs.get(c.stmt) ?? []), c]);
      }
    }
    for (const group of glyphs.values()) {
      const c = group[0];
      const at = screen(c.involves, 16);
      if (!at) continue;
      const ids = group.map((g) => g.id);
      const el = document.createElement("div");
      el.className = `glyph${ids.some((i) => this.selected.has(i)) ? " selected" : ""}${ids.some((i) => conflicting.has(i)) ? " conflict" : ""}`;
      el.textContent = GLYPHS[c.method!];
      el.title = c.text;
      el.style.transform = at;
      el.onclick = (e) => {
        if (!e.shiftKey) this.selected.clear();
        for (const i of ids) this.selected.add(i);
        this.renderPanel();
        this.redraw();
      };
      this.labels.append(el);
    }
  }

  private anchor(ids: string[]): XY | null {
    const pts: XY[] = [];
    for (const id of ids) {
      const e = this.entity(id);
      if (!e) continue;
      if (e.kind === "point") pts.push([e.x!, e.y!]);
      else if (e.kind === "line") { const [a, b] = [this.xy(e.p1), this.xy(e.p2)]; pts.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); }
      else pts.push(polar(this.xy(e.c), e.r!, Math.PI / 4));
    }
    if (!pts.length) return null;
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  }

  private updateGrid() {
    // A faint grid for orientation only: nothing snaps to it.
    const px = this.px();
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => s / px >= 24) ?? 500;
    this.gridGroup.clear();
    const half = Math.ceil((px * 1200) / step) * step;
    const pts: number[] = [];
    for (let v = -half; v <= half + 1e-9; v += step) pts.push(-half, v, 0, half, v, 0, v, -half, 0, v, half, 0);
    const grid = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pts, 3)),
      new THREE.LineBasicMaterial({ color: COLOR.grid, transparent: true, opacity: 0.5, depthTest: false }));
    const axes = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([-half, 0, 0, half, 0, 0, 0, -half, 0, 0, half, 0], 3)),
      new THREE.LineBasicMaterial({ color: COLOR.axis, depthTest: false }));
    this.gridGroup.add(grid, axes);
  }

  // --- Panel ----------------------------------------------------------------------------------------

  private renderPanel() {
    if (!this.active) return;
    const p = this.panel;
    p.hidden = false;
    const el = <T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}) => Object.assign(document.createElement(tag), props) as T;
    const row = el("div", { className: "row" });
    const tools = el("span", { className: "group tools" });
    tools.append(el("b", { textContent: `Sketch${this.model.name ? ` ${this.model.name}` : ""}`, title: `Sketching on ${this.label}` }));
    for (const [t, icon, name] of TOOLS) {
      const b = el("button", { textContent: icon, title: name });
      b.dataset.tool = t;
      b.classList.toggle("on", this.tool === t);
      b.onclick = () => this.setTool(t);
      tools.append(b);
    }
    const cons = el("label", { title: "New geometry only guides: it is no part of the sketch's regions" });
    const box = el<HTMLInputElement>("input", { type: "checkbox", checked: this.construction });
    box.onchange = () => { this.construction = box.checked; };
    cons.append(box, " construction");
    tools.append(el("span", { className: "sep" }), cons);
    row.append(tools);
    const m = this.model;
    const state = el("span", { className: `state${m.problem || m.error ? " bad" : m.dof === 0 ? " ok" : ""}` });
    state.textContent = m.error ? `Line ${m.error.line ?? "?"}: ${m.error.message}` : m.problem ? m.problem
      : m.dof === undefined ? "" : m.dof === 0 ? "Fully constrained" : `${m.dof} degree${m.dof === 1 ? "" : "s"} of freedom`;
    row.append(state);
    const actions = el("span", { className: "group actions" });
    const done = el<HTMLButtonElement>("button", { textContent: "Done", className: "primary", title: "Close the sketch and save it" });
    done.disabled = !m.entities.some((e) => this.drawn(e) && e.kind !== "point");
    done.onclick = () => { const src = this.session.src; this.stop(); this.host.done(src); };
    const cancel = el("button", { textContent: "Cancel", title: "Leave the sketch without saving" });
    cancel.onclick = () => { this.stop(); this.host.cancel(); };
    actions.append(done, cancel);
    row.append(actions);
    const sub = el("div", { className: "sub" });
    const options = this.options();
    sub.append(el("span", { className: "hint muted", textContent: this.selected.size ? (options.length ? "Constrain or dimension:" : "") : HINTS[this.tool] }));
    for (const o of options) {
      const b = el<HTMLButtonElement>("button", { textContent: o.icon, title: o.title, className: o.dim ? "option dim" : "option" });
      b.dataset.option = o.action.op === "constrain" ? o.action.kind : "";
      b.onclick = () => this.apply(o);
      sub.append(b);
    }
    if (this.selected.size) {
      const del = el("button", { textContent: `Delete ${this.selected.size}`, title: "Delete the selection and what depends on it (Delete)" });
      del.onclick = () => this.deleteSelected();
      sub.append(del);
    }
    sub.append(el("span", { className: "spacer" }), el("span", { className: "muted cursor" }));
    p.replaceChildren(row, sub);
  }
}

function polar(c: XY, r: number, a: number): XY { return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]; }

/** Start and end angle of a counter-clockwise arc, end > start. */
function arcAngles(c: XY, s: XY, e: XY): [number, number] {
  const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
  let a1 = Math.atan2(e[1] - c[1], e[0] - c[0]);
  if (a1 <= a0) a1 += 2 * Math.PI;
  return [a0, a1];
}

function onArc(p: XY, c: XY, s: XY, e: XY): boolean {
  const [a0, a1] = arcAngles(c, s, e);
  let a = Math.atan2(p[1] - c[1], p[0] - c[0]);
  while (a < a0) a += 2 * Math.PI;
  return a <= a1;
}

function segmentDistance(p: XY, a: XY, b: XY): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
