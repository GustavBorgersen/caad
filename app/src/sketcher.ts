// Sketch editor (docs/06-sketches.md): edits a constrained sketch. Every action is a code edit done by the
// kernel (sketch_action), which returns the sketch's new model; dragging solves in the page with PlaneGCS.
// Done hands back the edited source. No grid snapping: the cursor snaps to existing points instead.
import * as THREE from "three";
import gcsWasm from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import { loadSolver } from "./gcs-solve";
import type { Kernel, SketchAction, SketchConstraint, SketchEntity, SketchModel, SketchStatement } from "./kernel";
import { num } from "./sketch-code";
import type { IconName } from "./icons";
import { onThemeChange, token } from "./theme";
import { esc, type MenuSection } from "./ui";
import type { PointerTool, SketchPlane, Viewer } from "./viewer";

export type Tool = "select" | "line" | "rect" | "circle" | "arc" | "point" | "dimension" | "trim" | "use";
/** The sketch tools, for the top bar: [tool, label, icon, key, description]. */
export const TOOLS: [Tool, string, IconName, string | undefined, string][] = [
  ["select", "Select", "select", undefined, "Select and drag (Esc ends any tool)"], ["line", "Line", "line", "l", "Lines that join up"],
  ["rect", "Rectangle", "rect", "r", "A rectangle from two corners"], ["circle", "Circle", "circle", "c", "A circle from its centre"],
  ["arc", "Arc", "arc", "a", "An arc from its centre, start and end"], ["point", "Point", "point", "p", "A point (holes go at points)"],
  ["dimension", "Dimension", "dimension", "d", "A length, distance, angle, radius or diameter"],
  ["trim", "Trim", "trim", "t", "Cut a curve back to where it crosses others"],
  ["use", "Use edges", "useEdges", undefined, "Bring edges of the part into the sketch to constrain to"],
];
const HINTS: Record<Tool, string> = {
  select: "Click to select (Shift: more), drag to move, Delete to remove.",
  line: "Click points; lines join up. Esc, or a click on an existing point, ends the chain.",
  rect: "Click one corner, then the opposite corner.",
  circle: "Click the centre, then a point on the circle.",
  arc: "Click the centre, the start, then the end (counter-clockwise).",
  point: "Click to place a point (construction: a guide point, not a hole position).",
  dimension: "Click a line, circle or arc, then beside it: its length, diameter or radius. Or click two of points, lines and circles: "
    + "the distance or angle between them (two points: place it above or below for a horizontal distance, left or right for a vertical one). "
    + "Then type its value.",
  trim: "Click the piece of a line, circle or arc to cut away: it goes up to the nearest crossings (with none, the whole curve).",
  use: "Click an edge of the part: it comes into the sketch as fixed guide geometry to constrain to (construction=False in the code makes it part of the regions).",
};
// Colours from the theme's tokens (docs/10-visual-system.md: the same states as the 3D view and the panels).
const colors = () => ({
  free: token("--sk-free"), constrained: token("--sk"), construction: token("--cons"), selected: token("--accent"), hover: token("--hov-lo"),
  conflict: token("--err"), preview: token("--pre-lo"), grid: token("--grid"), axis: token("--faint"), reference: token("--muted"),
  dimension: token("--dim"), xAxis: token("--axis-x"), yAxis: token("--axis-y"),
});
let COLOR = colors();
// Points made on their own (the point tool, and their mirrored or patterned copies) are drawn as rings, unlike
// line ends, centres and reference points (the origin, a rectangle's centre).
const OWN_POINTS = new Set(["point", "mirror", "linear_pattern", "circular_pattern"]);
const ARROW_PX = 8; // dimension arrows' length on screen
const AXIS_PX = 48; // the sketch's X and Y arrows' length on screen
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
/** A dimension the dimension tool would make, and a constraint-like description of it to draw (dimShape). */
type Measure = { kind: string; refs: SketchEntity[]; value: number; shape: Pick<SketchConstraint, "type" | "method" | "involves"> };
/** A constraint or dimension the selection allows. */
type Option = { icon: string; title: string; action: SketchAction; dim: boolean; op?: boolean };
export type SketchHost = {
  kernel: Kernel;
  done: (src: string) => void; // Finish: the part's source with the edited sketch
  cancel: () => void;
  status: (text: string) => void;
  /** The tool, the selection or the sketch changed: the top bar and the sketch status follow. */
  changed: () => void;
};

export class Sketcher implements PointerTool {
  active = false;
  private group = new THREE.Group(); // in the sketch plane's coordinates
  private gridGroup = new THREE.Group();
  private dimGroup = new THREE.Group(); // dimension and extension lines, arrows: rebuilt with the labels (sized in pixels)
  private plane!: SketchPlane;
  private label = "";
  private session!: SketchSession;
  private tool: Tool = "select";
  /** New geometry is construction (guides only, no part of the sketch's regions). */
  construction = false;
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
  private measuring: string[] = []; // dimension tool: what has been clicked
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
      if (!this.active || /^(INPUT|SELECT|TEXTAREA)$/.test((e.target as HTMLElement).tagName) || (e.target as HTMLElement).closest?.(".cm-editor, .menu")) return;
      if (e.key === "Escape") this.escape();
      else if (e.key === "Enter" && !(e.target as HTMLElement).closest?.("button")) { e.preventDefault(); this.finish(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && this.selected.size) { e.preventDefault(); this.deleteSelected(); }
    });
    onThemeChange(() => { COLOR = colors(); if (this.active) { this.updateGrid(); this.redraw(); } });
  }

  /** The current tool (the top bar shows it on). */
  get currentTool(): Tool { return this.tool; }

  /** Finish: close the editor and hand back the edited source (only with something drawn). */
  get canFinish(): boolean { return this.active && this.model.entities.some((e) => this.drawn(e)); }
  finish() { if (!this.canFinish) return; const src = this.session.src; this.stop(); this.host.done(src); }
  cancel() { if (!this.active) return; this.stop(); this.host.cancel(); }

  /** Construction on or off: for the selected geometry if any (the code's construction=…), else for what you draw next. */
  async toggleConstruction() {
    const sel = this.model.entities.filter((e) => this.selected.has(e.id) && e.stmt !== undefined && this.drawn(e) && !e.reference);
    if (!sel.length) { this.construction = !this.construction; this.renderPanel(); return; }
    const on = !sel.every((e) => e.construction);
    await this.act([...new Set(sel.map((e) => e.stmt!))].map((stmt) => ({ op: "arg" as const, stmt, arg: "construction", expr: on ? "True" : "False" })));
  }

  /** Right-click in the sketch: what fits the geometry under the pointer (selected first, if it wasn't). */
  menuSections(ev: MouseEvent): MenuSection[] {
    const at = this.local(ev as PointerEvent);
    const id = at && this.pick(at);
    if (id && !this.selected.has(id)) { this.selected.clear(); this.selected.add(id); this.renderPanel(); this.redraw(); }
    if (!this.selected.size) return [];
    const options = this.options();
    const n = this.selected.size;
    return [
      { header: `${n} selected`, items: options.map((o) => ({ label: o.title.split(":")[0], meta: o.icon, run: () => this.apply(o) })) },
      { items: [
        { label: "Construction on/off", icon: "construction", key: "q", run: () => this.toggleConstruction() },
        { label: `Delete ${n}`, icon: "trash", key: "delete", danger: true, run: () => this.deleteSelected() },
      ] },
    ];
  }

  get model(): SketchModel { return this.session.model; }
  get src(): string { return this.session.src; }
  /** For tests: no kernel action running. */
  get idle(): boolean { return !this.busy; }

  /** For tests: how many points are drawn as dots and as rings, and how many arrows the dimensions have. */
  get drawing(): { dots: number; rings: number; arrows: number } {
    const count = (o?: THREE.Object3D) => (o as THREE.Mesh | undefined)?.geometry.getAttribute("position").count ?? 0;
    const clouds = this.group.children.filter((o): o is THREE.Points => o instanceof THREE.Points);
    const ringed = (p: THREE.Points) => !!(p.material as THREE.PointsMaterial).map;
    const arrows = this.dimGroup.children.filter((o) => o instanceof THREE.Mesh).reduce((n, m) => n + count(m) / 3, 0);
    return { dots: count(clouds.find((p) => !ringed(p))), rings: count(clouds.find(ringed)), arrows };
  }

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
    this.group.add(this.gridGroup, this.dimGroup);
    this.viewer.lookAtPlane(plane, size);
    this.viewer.setFacesFaded(true);
    this.viewer.tool = this;
    this.viewer.onCameraChange = () => { this.updateGrid(); this.placeLabels(); };
    this.viewer.add(this.group);
    this.viewer.canvas.parentElement!.append(this.labels);
    this.updateGrid();
    this.renderPanel();
    this.redraw();
  }

  stop() {
    this.active = false;
    this.viewer.hoverPick(null);
    this.viewer.tool = null;
    this.viewer.onCameraChange = () => {};
    this.viewer.remove(this.group);
    this.viewer.setFacesFaded(false);
    this.viewer.resetUp();
    this.panel.hidden = true;
    this.labels.remove();
    this.host.changed();
  }

  /** Run editor actions as code edits in the kernel; the names adds made. For tests too. */
  async act(actions: SketchAction[]): Promise<string[]> {
    this.busy = true;
    try {
      const r = await this.host.kernel.sketchAction(this.session.src, this.session.index, actions);
      const { name, plane, params } = this.session.model; // only sketch_open says these
      this.session = { ...this.session, src: r.src, model: { name, plane, params, ...r.model } };
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
    if (!id) return undefined;
    return this.model.entities.find((e) => e.id === id) ?? (id === "origin" ? this.origin : undefined);
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

  /** Entities drawn in the view: not the origin and its axes (the grid's axes show them), nor operations' helpers; references are. */
  private drawn(e: SketchEntity): boolean {
    const c = this.model.c;
    return !((e.fixed && !e.reference) || e.hidden || e.ref?.startsWith(`${c}.x_axis`) || e.ref?.startsWith(`${c}.y_axis`));
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

  /** The entity under the cursor: points first (unless only curves), then lines, circles and arcs. */
  private pick(at: XY, curves = false): string | null {
    const px = this.px();
    let best: string | null = null;
    let bestD = SNAP_PX * px;
    for (const e of curves ? [] : [...this.model.entities.filter((x) => this.drawn(x)), this.origin]) {
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
    if (this.tool === "use") {
      const edge = this.viewer.pickEdge(ev);
      this.viewer.hoverPick(edge);
      this.viewer.canvas.style.cursor = edge ? "pointer" : "";
      return;
    }
    const at = this.local(ev);
    if (!at) return;
    const trim = this.tool === "trim", picking = this.tool === "select" || this.tool === "dimension";
    this.cursor = picking ? { at } : trim ? null : this.snap(at);
    this.hover = picking || trim ? this.pick(at, trim) : null;
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
    this.dragSkip = null;
    return true;
  }

  drag(ev: PointerEvent) {
    const d = this.dragging;
    const at = this.local(ev);
    if (!d || !at) return;
    if (this.entity(d.id)?.reference) return; // part geometry stays put (released, it's a click: selected)
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
    if (this.tool === "use") { if (!this.busy) this.use(ev); return; }
    const at = this.local(ev);
    if (!at || this.busy) return;
    if (this.tool === "trim") {
      const id = this.pick(at, true);
      if (id) this.act([{ op: "trim", entity: id, at }]);
      return;
    }
    if (this.tool === "dimension") { this.measureClick(at); return; }
    if (this.tool === "select") {
      const id = this.pick(at);
      if (id) this.select(id, ev.shiftKey || ev.ctrlKey || ev.metaKey);
      else { this.selected.clear(); this.renderPanel(); this.redraw(); }
      return;
    }
    this.place(this.snap(at));
  }

  /**
   * Dimension tool: a click on something picks it (two at most); a click beside one line, circle or arc, or any
   * click after two, makes the dimension previewed (measure) and opens its value.
   */
  private measureClick(at: XY) {
    const id = this.pick(at);
    if (this.measuring.length < 2 && id && !this.measuring.includes(id)) {
      if (this.measuring.length === 1 && !this.measure([...this.measuring, id], at)) this.host.status("No dimension between those: pick points, lines, circles or arcs.");
      else this.measuring.push(id);
      this.redraw();
      return;
    }
    const m = this.measuring.length ? this.measure(this.measuring, at) : null;
    this.measuring = [];
    if (!m) { this.redraw(); return; }
    this.apply({ icon: "", title: "", dim: true, action: { op: "constrain", kind: m.kind, refs: m.refs.map((e) => e.ref!), value: num(m.value) } });
  }

  /**
   * The dimension of what was picked (`ids`), at its current value: a line's length, a circle's diameter, an arc's
   * radius; between two things (a circle or arc: its centre) the angle of two lines, a point's distance to a line
   * (parallel lines: one's start to the other), and between points the distance, or with the cursor `at` above
   * or below them a horizontal one, left or right a vertical one (both from left to right, bottom to top: positive).
   */
  private measure(ids: string[], at: XY | null): Measure | null {
    const origin = this.origin;
    const ents = ids.map((id) => (id === origin.id ? origin : this.entity(id)));
    if (!ents.length || ents.some((e) => !e?.ref)) return null;
    const ends = (l: SketchEntity): [XY, XY] => [this.xy(l.p1), this.xy(l.p2)];
    if (ents.length === 1) {
      const e = ents[0]!;
      if (e.kind === "line") return { kind: "length", refs: [e], value: dist(...ends(e)), shape: { type: "p2p_distance", method: "length", involves: [e.p1!, e.p2!] } };
      if (e.kind === "circle") return { kind: "diameter", refs: [e], value: 2 * e.r!, shape: { type: "circle_diameter", method: "diameter", involves: [e.id] } };
      if (e.kind === "arc") return { kind: "radius", refs: [e], value: e.r!, shape: { type: "arc_radius", method: "radius", involves: [e.id] } };
      return null;
    }
    let [a, b] = ents.map((e) => (e!.kind === "circle" || e!.kind === "arc" ? this.entity(e!.c) : e));
    if (!a?.ref || !b?.ref || a.id === b.id) return null;
    if (a.kind === "line" && b.kind === "line") {
      const c = corner(...ends(a), ...ends(b));
      if (c.O) return { kind: "angle", refs: [a, b], value: Math.acos(Math.max(-1, Math.min(1, dot(c.r1, c.r2)))) * 180 / Math.PI, shape: { type: "l2l_angle_ll", method: "angle", involves: [a.id, b.id] } };
      a = this.entity(a.p1);
      if (!a?.ref) return null;
    }
    if (a.kind === "line") [a, b] = [b, a];
    const P: XY = [a.x!, a.y!];
    if (b.kind === "line") {
      const [A, B] = ends(b);
      const value = Math.abs(cross(sub(P, A), sub(B, A))) / (dist(A, B) || 1);
      return { kind: "distance", refs: [a, b], value, shape: { type: "p2l_distance", method: "distance", involves: [a.id, b.id] } };
    }
    const Q: XY = [b.x!, b.y!];
    const beside = (k: number) => at !== null && (at[k] < Math.min(P[k], Q[k]) || at[k] > Math.max(P[k], Q[k]));
    const kind = beside(1) && !beside(0) ? "hdistance" : beside(0) && !beside(1) ? "vdistance" : "distance";
    const k = kind === "vdistance" ? 1 : 0;
    if (kind !== "distance" && P[k] > Q[k]) [a, b] = [b, a];
    const value = kind === "distance" ? dist(P, Q) : Math.abs(Q[k] - P[k]);
    return { kind, refs: [a, b], value, shape: { type: kind === "distance" ? "p2p_distance" : "difference", method: kind, involves: [a.id, b.id] } };
  }

  /** The dimension tool's preview: what was picked, with what the cursor is on (else beside it). */
  private measurePreview(): Measure | null {
    if (this.tool !== "dimension" || !this.measuring.length) return null;
    const at = this.cursor?.at ?? null;
    const h = this.hover;
    if (this.measuring.length === 1 && h && h !== this.measuring[0]) {
      const m = this.measure([...this.measuring, h], at);
      if (m) return m;
    }
    return this.measure(this.measuring, at);
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
    // Constraints implied by others (a perpendicular to a vertical line on a horizontal one) leave the sketch
    // solvable, but with the temporary ones PlaneGCS calls them conflicting and moves nothing: leave them out.
    const skip = this.dragSkip ??= new Set(JSON.parse(solver.solve(JSON.stringify(this.model.primitives))).redundant);
    const r = JSON.parse(solver.solve(JSON.stringify(prims.filter((p) => !skip.has(p.id as string)))));
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
  private dragSkip: Set<string> | null = null;

  // --- Drawing tools --------------------------------------------------------------------------------

  private arg(s: Snap): string | XY { return s.ref ?? s.at; }

  /** Use: the part's edge under the cursor into the sketch, as `c.project(<its selector>)`. The view shows the part
   * as it is before the sketch, which is what the sketch's code sees, so the selector picks the same edge. */
  private async use(ev: PointerEvent) {
    const edge = this.viewer.pickEdge(ev);
    if (!edge) { this.host.status("Click an edge of the part to use it in the sketch."); return; }
    this.busy = true;
    let expr: string | undefined;
    try { expr = (await this.host.kernel.select("edge", [edge.index])).selectors[0]?.expr; }
    catch (e) { this.host.status((e as Error).message); }
    finally { this.busy = false; }
    if (!expr) { this.host.status("No selector found for that edge."); return; }
    const before = this.session;
    await this.act([{ op: "add", kind: "project", args: [expr] }]);
    const error = this.model.error;
    if (error && !before.model.error) { // e.g. a circle seen from the side: leave the sketch as it was
      this.session = before;
      this.renderPanel();
      this.redraw();
      this.host.status(`Can't use that edge: ${error.message.replace(/^\w+Error: /, "")}`);
      return;
    }
    this.host.status(`Using ${expr}`);
  }

  private async place(s: Snap) {
    const cons = this.construction || undefined;
    if (this.tool === "point") {
      // On an existing point (the origin, a rectangle's centre…): a new point there, tied to it.
      const actions: SketchAction[] = [{ op: "add", kind: "point", args: s.at, construction: cons }];
      if (s.ref) actions.push({ op: "constrain", kind: "coincident", refs: ["$0", s.ref] });
      await this.act(actions);
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
    if (this.measuring.length) { this.measuring = []; this.redraw(); }
    else if (this.pending.length || this.chain) this.endChain();
    else if (this.tool !== "select") this.setTool("select");
    else if (this.selected.size) { this.selected.clear(); this.renderPanel(); this.redraw(); }
  }

  setTool(t: Tool) {
    if (this.tool === "use") this.viewer.hoverPick(null);
    this.tool = t;
    this.pending = [];
    this.measuring = [];
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
      const c = corner(...ends(L[0]), ...ends(L[1]));
      add("∠", "Angle between the lines", "angle", L, Math.acos(Math.max(-1, Math.min(1, dot(c.r1, c.r2)))) * 180 / Math.PI);
    }
    if (C.length === 1 && n === 1) add("⌀", "Diameter", "diameter", C, 2 * C[0].r!);
    if (A.length === 1 && n === 1) add("R", "Radius", "radius", A, A[0].r!);
    // Operations: fillet a corner, mirror, patterns (code like c.fillet(…); their numbers are fields after).
    const op = (icon: string, title: string, action: SketchAction, dim = false) => out.push({ icon, title, action, dim, op: true });
    const lines = this.model.entities.filter((e) => e.kind === "line" && this.drawn(e));
    if (P.length === 1 && n === 1) {
      const at = lines.filter((l) => l.p1 === P[0].id || l.p2 === P[0].id);
      if (at.length === 2) {
        const short = Math.min(...at.map((l) => { const [a, b] = ends(l); return Math.hypot(b[0] - a[0], b[1] - a[1]); }));
        op("◜", "Fillet the corner", { op: "add", kind: "fillet", args: [P[0].ref!, +(0.2 * short).toPrecision(2)] }, true);
      }
    }
    const last = sel[n - 1], rest = sel.slice(0, -1).filter((e) => e.id !== origin.id);
    if (n >= 2 && last.kind === "line" && rest.length === n - 1) op("⇆", "Mirror about the last selected line", { op: "add", kind: "mirror", args: [last.ref!, ...rest.map((e) => e.ref!)] });
    const items = sel.filter((e) => e.id !== origin.id);
    if (items.length === n) {
      const xs = items.flatMap((e) => this.outline2(e).map((p) => p[0]));
      const step = +((Math.max(...xs) - Math.min(...xs)) * 1.25 || 10).toPrecision(2);
      op("⋯", "Linear pattern: copies in a row (count and spacing after)", { op: "add", kind: "linear_pattern", args: [items.map((e) => e.ref!), 3, step, 0] });
    }
    if (n >= 2 && last.kind === "point" && rest.length === n - 1)
      op("⟳", "Circular pattern around the last selected point (count and angle after)", { op: "add", kind: "circular_pattern", args: [rest.map((e) => e.ref!), 4, last.ref!], angle: 360 });
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
    const ents = this.model.entities.filter((e) => !e.fixed || e.reference).map((e) => e.id).filter((id) => this.selected.has(id));
    const cons = this.model.constraints.map((c) => c.id).filter((id) => this.selected.has(id));
    this.selected.clear();
    this.act([{ op: "delete", entities: ents, constraints: cons }]);
  }

  /** The pattern statement the selection came from, for its fields (count, spacing, angle). */
  private pattern(): { stmt: number; call: NonNullable<SketchStatement["call"]> } | null {
    for (const id of this.selected) {
      const stmt = this.entity(id)?.stmt;
      const call = stmt === undefined ? undefined : this.model.statements[stmt]?.call;
      if (call && (call.method === "linear_pattern" || call.method === "circular_pattern")) return { stmt: stmt!, call };
    }
    return null;
  }

  // --- Rendering ------------------------------------------------------------------------------------

  private color(e: SketchEntity): number {
    if (this.selected.has(e.id) || this.measuring.includes(e.id)) return COLOR.selected;
    if (this.hover === e.id) return COLOR.hover;
    const conflicting = new Set(this.model.conflicting);
    if (this.model.constraints.some((c) => conflicting.has(c.id) && c.involves.includes(e.id))) return COLOR.conflict;
    if (e.reference) return COLOR.reference;
    if (e.construction && e.kind !== "point") return COLOR.construction;
    return this.model.dof === 0 ? COLOR.constrained : COLOR.free;
  }

  /** A point made on its own (drawn as a ring), not a line's end, a centre or a shape's reference point. */
  private ownPoint(e: SketchEntity): boolean {
    const method = e.stmt === undefined ? undefined : this.model.statements[e.stmt]?.call?.method;
    if (e.reference || !method || !OWN_POINTS.has(method)) return false;
    return !this.model.entities.some((o) => o.kind !== "point" && [o.p1, o.p2, o.c, o.s, o.e].includes(e.id));
  }

  /** Where an entity is drawn, points too. */
  private outline2(e: SketchEntity): XY[] {
    return e.kind === "point" ? [[e.x!, e.y!]] : this.outline(e);
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
      if (c === this.gridGroup || c === this.dimGroup) continue;
      this.group.remove(c);
      (c as THREE.Line).geometry.dispose();
    }
    const points: number[] = [], colors: number[] = [], rings: number[] = [], ringColors: number[] = [];
    for (const e of this.model.entities) {
      if (!this.drawn(e)) continue;
      if (e.kind === "point") {
        const own = this.ownPoint(e);
        (own ? rings : points).push(e.x!, e.y!, 0);
        (own ? ringColors : colors).push(...new THREE.Color(this.color(e)).toArray());
      } else this.group.add(this.polyline(this.outline(e), this.color(e), e.construction));
    }
    const o = this.origin; // drawn as a dot: selectable for dimensions
    points.push(0, 0, 0);
    colors.push(...new THREE.Color(this.selected.has(o.id) || this.measuring.includes(o.id) ? COLOR.selected : this.hover === o.id ? COLOR.hover : COLOR.constrained).toArray());
    const s = this.cursor;
    if (s && this.tool !== "select" && this.tool !== "dimension") {
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
    if (points.length) this.group.add(pointCloud(points, colors, 7));
    if (rings.length) this.group.add(pointCloud(rings, ringColors, 11, ringTexture()));
    const pos = this.panel.querySelector(".cursor");
    if (pos) pos.textContent = s ? `x ${num(s.at[0])}   y ${num(s.at[1])}` : "";
    this.placeLabels();
    this.viewer.render();
  }

  /**
   * Over the view: dimension labels (the expression, and its value when that differs; click selects, double-click
   * edits) and a glyph per constraint statement (H, V, ∥…; click selects it, Delete removes it).
   */
  private placeLabels() {
    if (!this.active) return;
    // The input being typed in (and its parameter list) stays put: moving it would take its focus away.
    const editing = this.editing && this.input.isConnected;
    for (const el of [...this.labels.children]) if (!editing || (el !== this.input && el.id !== "sketch-params")) el.remove();
    if (!editing) {
      const list = document.createElement("datalist");
      list.id = "sketch-params";
      for (const p of this.params) list.append(Object.assign(document.createElement("option"), { value: p.name, label: `= ${num(p.value)}` }));
      this.labels.append(list);
    }
    for (const o of [...this.dimGroup.children]) {
      this.dimGroup.remove(o);
      (o as THREE.Mesh).geometry.dispose();
      ((o as THREE.Mesh).material as THREE.Material).dispose();
    }
    const px = this.px();
    const conflicting = new Set(this.model.conflicting);
    const place = (a: XY, dy = 0) => {
      const p = this.viewer.toScreen(new THREE.Vector3(a[0], a[1], 0).applyMatrix4(this.group.matrix));
      return `translate(${p.x}px, ${p.y + dy}px) translate(-50%, -50%)`;
    };
    const screen = (ids: string[], dy = 0) => {
      const a = this.anchor(ids);
      return a ? place(a, dy) : null;
    };
    for (const [axis, at] of [["X", [(AXIS_PX + 10) * px, 0]], ["Y", [0, (AXIS_PX + 10) * px]]] as [string, XY][]) {
      const el = document.createElement("div");
      el.className = `axis-label ${axis.toLowerCase()}`;
      el.textContent = axis;
      el.style.transform = place(at);
      this.labels.append(el);
    }
    const glyphs = new Map<number, typeof this.model.constraints>();
    for (const c of this.model.constraints) {
      if (c.dim) {
        const shape = this.dimShape(c, px);
        if (!shape) continue;
        const color = conflicting.has(c.id) ? COLOR.conflict : this.selected.has(c.id) ? COLOR.selected : COLOR.dimension;
        for (const o of dimObjects(shape, color, px)) this.dimGroup.add(o);
        const at = place(shape.at);
        if (this.editing === c.id) {
          this.input.style.transform = at;
          if (!this.input.isConnected) this.labels.append(this.input);
          continue;
        }
        const el = document.createElement("div");
        el.className = `dim${this.selected.has(c.id) ? " selected" : ""}${conflicting.has(c.id) ? " conflict" : ""}`;
        const value = num(c.dim.value);
        el.textContent = Number.isFinite(Number(c.dim.expr)) ? value : `${c.dim.expr} = ${value}`; // a number: as solved (an angle's -30 is 30)
        if (shape.prefix) el.dataset.prefix = shape.prefix;
        if (shape.suffix) el.dataset.suffix = shape.suffix;
        el.title = `${c.text} — double-click to change`;
        el.style.transform = at;
        el.onclick = (e) => this.select(c.id, e.shiftKey);
        el.ondblclick = () => this.editDimension(c.id);
        this.labels.append(el);
      } else if (!c.builtin && c.method && GLYPHS[c.method] && c.stmt !== undefined) {
        glyphs.set(c.stmt, [...(glyphs.get(c.stmt) ?? []), c]);
      }
    }
    const preview = this.measurePreview();
    const shape = preview && this.dimShape(preview.shape as SketchConstraint, px);
    if (preview && shape) {
      for (const o of dimObjects(shape, COLOR.preview, px)) this.dimGroup.add(o);
      const el = document.createElement("div");
      el.className = "dim preview";
      el.textContent = num(preview.value);
      if (shape.prefix) el.dataset.prefix = shape.prefix;
      if (shape.suffix) el.dataset.suffix = shape.suffix;
      el.style.transform = place(shape.at);
      this.labels.append(el);
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

  /**
   * How a dimension is drawn, Onshape-like (sketch coordinates; `px` is a pixel): a line's length is a label on
   * it; other distances get a dimension line with arrows to what they measure and extension lines out to it
   * (horizontal and vertical ones above or right of their points); radii and diameters a leader through the
   * circle; angles the arc between the two lines, from where they meet.
   */
  private dimShape(c: SketchConstraint, px: number): DimShape | null {
    const es = c.involves.map((id) => this.entity(id));
    const at = this.anchor(c.involves);
    if (!at || es.some((e) => !e)) return null;
    const out: DimShape = { at, segs: [], arrows: [] };
    const [a, b] = es as SketchEntity[];
    const pt = (e: SketchEntity): XY => [e.x!, e.y!];
    if ((c.method === "hdistance" || c.method === "vdistance") && a && b) {
      const [p, q] = [pt(a), pt(b)];
      const k = c.method === "hdistance" ? 1 : 0; // the coordinate the dimension line keeps: y for a horizontal one
      const level = Math.max(p[k], q[k]) + 24 * px;
      const to = (r: XY, d = 0): XY => (k ? [r[0], level + d] : [level + d, r[1]]);
      out.segs.push(p, to(p, 4 * px), q, to(q, 4 * px));
      dimLine(out, to(p), to(q), px);
    } else if (c.type === "p2p_distance" && a && b) {
      const ids = new Set([a.id, b.id]);
      if (!this.model.entities.some((l) => l.kind === "line" && ids.has(l.p1!) && ids.has(l.p2!))) dimLine(out, pt(a), pt(b), px);
    } else if (c.type === "p2l_distance" && a && b) {
      const [p, l] = a.kind === "point" ? [a, b] : [b, a];
      const [P, A, B] = [pt(p), this.xy(l.p1), this.xy(l.p2)];
      const len = dist(A, B);
      if (len < 1e-12) return out;
      const u: XY = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
      const t = dot(sub(P, A), u);
      const F = along(A, u, t);
      if (t < 0) out.segs.push(A, along(F, u, -4 * px)); // the line extended to the foot of the dimension
      if (t > len) out.segs.push(B, along(F, u, 4 * px));
      dimLine(out, P, F, px);
    } else if (/_(radius|diameter)$/.test(c.type) && a && (a.kind === "circle" || a.kind === "arc")) {
      const diameter = c.type.endsWith("diameter"); // c.radius, c.diameter, and a fillet's radius
      const C = this.xy(a.c), r = a.r!;
      const [a0, a1] = a.kind === "arc" ? arcAngles(C, this.xy(a.s), this.xy(a.e)) : [Math.PI / 4, Math.PI / 4];
      const th = (a0 + a1) / 2;
      const u: XY = [Math.cos(th), Math.sin(th)];
      const back = polar(C, r, th + Math.PI);
      out.segs.push(diameter ? back : C, polar(C, r + 12 * px, th));
      out.arrows.push([polar(C, r, th), u]);
      if (diameter) out.arrows.push([back, [-u[0], -u[1]]]);
      out.at = polar(C, r + 30 * px, th);
      out.prefix = diameter ? "Ø" : "R";
    } else if (c.method === "angle" && a?.kind === "line" && b?.kind === "line") {
      out.suffix = "°";
      const [A1, B1, A2, B2] = [this.xy(a.p1), this.xy(a.p2), this.xy(b.p1), this.xy(b.p2)];
      const { O, r1, r2 } = corner(A1, B1, A2, B2);
      if (!O) return out; // parallel: no corner to draw the arc at
      const reach = (r: XY, A: XY, B: XY): [number, number] => {
        const [ta, tb] = [dot(sub(A, O), r), dot(sub(B, O), r)];
        return [Math.min(ta, tb), Math.max(ta, tb)];
      };
      let rays: [XY, [number, number]][] = [[r1, reach(r1, A1, B1)], [r2, reach(r2, A2, B2)]]; // each ray, and where its line is along it
      let span = Math.atan2(r2[1], r2[0]) - Math.atan2(r1[1], r1[0]);
      span = ((span % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (span > Math.PI) { rays = [rays[1], rays[0]]; span = 2 * Math.PI - span; } // the angle as seen: under 180°
      const t0 = Math.atan2(rays[0][0][1], rays[0][0][0]), t1 = t0 + span;
      const R = Math.min(Math.max(0.6 * Math.min(rays[0][1][1], rays[1][1][1]), 32 * px), 90 * px);
      const n = Math.max(8, Math.ceil(span / (Math.PI / 48)));
      for (let i = 0; i < n; i++) out.segs.push(polar(O, R, t0 + (span * i) / n), polar(O, R, t0 + (span * (i + 1)) / n));
      out.arrows.push([polar(O, R, t0), [Math.sin(t0), -Math.cos(t0)]], [polar(O, R, t1), [-Math.sin(t1), Math.cos(t1)]]);
      const top = R + 6 * px;
      for (const [r, [lo, hi]] of rays) { // extension lines where a line stops short of the arc
        if (lo > 0) out.segs.push(O, along(O, r, Math.min(lo, top)));
        if (hi < top) out.segs.push(along(O, r, Math.max(hi, 0)), along(O, r, top));
      }
      out.at = polar(O, R, t0 + span / 2);
    }
    return out;
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
    const arrows = ([dx, dy]: XY, color: number) => {
      const [L, A] = [AXIS_PX * px, ARROW_PX * px];
      const tip: XY = [dx * L, dy * L];
      const wing = (side: number): number[] => [tip[0], tip[1], 0, tip[0] - dx * A - dy * A * 0.45 * side, tip[1] - dy * A + dx * A * 0.45 * side, 0];
      const seg = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, tip[0], tip[1], 0, ...wing(1), ...wing(-1)], 3)),
        new THREE.LineBasicMaterial({ color, depthTest: false }));
      seg.renderOrder = 1;
      return seg;
    };
    // The sketch's own X and Y (as Onshape shows them at the origin), labelled over the view.
    this.gridGroup.add(grid, axes, arrows([1, 0], COLOR.xAxis), arrows([0, 1], COLOR.yAxis));
  }

  // --- Panel ----------------------------------------------------------------------------------------

  /** The sketch's state for the view's status: its name, where it is, how constrained. */
  get status(): { name: string; where: string; state: string; tone: "free" | "ok" | "bad" } {
    const m = this.model;
    const state = m.error ? `Line ${m.error.line ?? "?"}: ${m.error.message}` : m.problem ? m.problem
      : m.dof === undefined ? "" : m.dof === 0 ? "Fully constrained" : `${m.dof} degree${m.dof === 1 ? "" : "s"} of freedom`;
    const where = this.label === m.name || this.label === "the sketch" ? (m.plane ?? "its plane").replace(/^Plane\.(XY|XZ|YZ)$/, (_, p) => `${{ XY: "Top", XZ: "Front", YZ: "Right" }[p as "XY"]} (${p})`) : this.label;
    return { name: m.name ?? "sketch", where, state, tone: m.problem || m.error ? "bad" : m.dof === 0 ? "ok" : "free" };
  }

  /** The docked panel: the state, what the selection allows (or the tool's hint), pattern numbers, Cancel and Finish. */
  private renderPanel() {
    if (!this.active) return;
    const p = this.panel;
    p.hidden = false;
    const el = <T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}) => Object.assign(document.createElement(tag), props) as T;
    const st = this.status;
    const head = el("header", { className: "dlg-head" });
    head.innerHTML = `<b>Sketch${this.model.name ? ` ${esc(this.model.name)}` : ""}</b><span class="sub" title="Sketching on ${esc(st.where)}">on ${esc(st.where)}</span>`;
    const state = el("div", { className: `state${st.tone === "bad" ? " bad" : st.tone === "ok" ? " ok" : ""}`, textContent: st.state });
    const parts: HTMLElement[] = [head, state];
    const options = this.options();
    if (this.selected.size) {
      parts.push(el("div", { className: "section-label", textContent: options.length ? `Selection · ${this.selected.size}` : `${this.selected.size} selected` }));
      const grid = el("div", { className: "options" });
      for (const o of options) {
        const b = el<HTMLButtonElement>("button", { title: o.title, className: `option${o.dim ? " dim" : ""}${o.op ? " op" : ""}` });
        b.dataset.option = o.action.op === "constrain" || o.action.op === "add" ? o.action.kind : "";
        b.innerHTML = `<span class="g">${esc(o.icon)}</span><span>${esc(o.title.split(":")[0])}</span>`;
        b.onclick = () => this.apply(o);
        grid.append(b);
      }
      if (options.length) parts.push(grid);
    } else {
      parts.push(el("div", { className: "section-label", textContent: TOOLS.find((t) => t[0] === this.tool)![1] }), el("div", { className: "hint-text", textContent: HINTS[this.tool] }));
    }
    const pattern = this.pattern();
    if (pattern) {
      const { stmt, call } = pattern;
      const linear = call.method === "linear_pattern";
      const fields: [string, string, number | string, string][] = [["count", "Count (the original included)", 1, call.args[1]]];
      if (linear) {
        fields.push(["dx", "Step in x", 2, call.args[2]]);
        fields.push(["dy", "Step in y", call.args.length > 3 ? 3 : "dy", call.args[3] ?? call.kwargs.dy ?? "0"]);
      } else fields.push(["angle", "Angle covered (360: all round, else from the first copy to the last)", call.args.length > 3 ? 3 : "angle", call.args[3] ?? call.kwargs.angle ?? "360"]);
      parts.push(el("div", { className: "section-label", textContent: linear ? "Pattern" : "Circular pattern" }));
      const box = el("div", { className: "fields" });
      for (const [name, title, arg, value] of fields) {
        const input = el<HTMLInputElement>("input", { value, spellcheck: false, title });
        input.dataset.arg = name;
        const commit = () => { const v = input.value.trim(); if (v && v !== value) this.act([{ op: "arg", stmt, arg, expr: v }]); };
        input.onkeydown = (e) => { if (e.key === "Enter") commit(); e.stopPropagation(); };
        input.onchange = commit;
        box.append(el("label", { textContent: name, title }), input);
      }
      parts.push(box);
    }
    const row = el("div", { className: "row-actions" });
    const cons = el<HTMLButtonElement>("button", { className: `btn small${this.construction ? " primary" : ""}`, title: "New geometry only guides: no part of the sketch's regions · Q" });
    cons.textContent = this.construction ? "Construction: on" : "Construction: off";
    cons.onclick = () => this.toggleConstruction();
    row.append(cons);
    if (this.selected.size) {
      const del = el<HTMLButtonElement>("button", { className: "btn small", textContent: `Delete ${this.selected.size}`, title: "Delete the selection and what depends on it · Delete" });
      del.onclick = () => this.deleteSelected();
      row.append(del);
    }
    parts.push(row, el("div", { className: "cursor" }));
    const foot = el("footer", { className: "dlg-foot" });
    const cancel = el<HTMLButtonElement>("button", { className: "btn cancel", title: "Leave the sketch without saving" });
    cancel.innerHTML = "Cancel";
    cancel.onclick = () => this.cancel();
    const done = el<HTMLButtonElement>("button", { className: "btn primary", title: "Close the sketch and save it" });
    done.innerHTML = 'Finish <kbd>↵</kbd>';
    done.disabled = !this.canFinish; // points alone are a sketch too (holes go there)
    done.onclick = () => this.finish();
    foot.append(cancel, done);
    parts.push(el("div", { className: "spacer" }), foot);
    p.replaceChildren(...parts);
    this.host.changed();
  }
}

/** A dimension as drawn: where its label goes, its lines (pairs of ends), its arrows (tip, the way it points). */
type DimShape = { at: XY; segs: XY[]; arrows: [XY, XY][]; prefix?: string; suffix?: string };

/** A dimension line from p to q, its label in the middle: arrows out to both ends, or in from outside when short. */
function dimLine(out: DimShape, p: XY, q: XY, px: number) {
  out.at = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const len = dist(p, q);
  if (len < 1e-9) return;
  const u: XY = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
  if (len >= 3 * ARROW_PX * px) {
    out.segs.push(p, q);
    out.arrows.push([p, [-u[0], -u[1]]], [q, u]);
  } else {
    const ext = 2.5 * ARROW_PX * px;
    out.segs.push(along(p, u, -ext), along(q, u, ext));
    out.arrows.push([p, u], [q, [-u[0], -u[1]]]);
  }
}

function dimObjects(s: DimShape, color: number, px: number): THREE.Object3D[] {
  const v = (p: XY) => [p[0], p[1], 0];
  const out: THREE.Object3D[] = [];
  if (s.segs.length) {
    out.push(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(s.segs.flatMap(v), 3)),
      new THREE.LineBasicMaterial({ color, depthTest: false })));
  }
  if (s.arrows.length) {
    const [L, W] = [ARROW_PX * px, ARROW_PX * px * 0.3];
    const tris = s.arrows.flatMap(([t, d]) => {
      const b = along(t, d, -L);
      return [...v(t), ...v([b[0] - d[1] * W, b[1] + d[0] * W]), ...v([b[0] + d[1] * W, b[1] - d[0] * W])];
    });
    out.push(new THREE.Mesh(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(tris, 3)),
      new THREE.MeshBasicMaterial({ color, depthTest: false, side: THREE.DoubleSide })));
  }
  for (const o of out) o.renderOrder = 2;
  return out;
}

function pointCloud(positions: number[], colors: number[], size: number, map?: THREE.Texture): THREE.Points {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const dots = new THREE.Points(geo, new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, depthTest: false, ...(map && { map, alphaTest: 0.5 }) }));
  dots.renderOrder = 3;
  return dots;
}

let ring: THREE.Texture | null = null;
/** A ring, for points drawn as circles (white: the points' colours tint it). */
function ringTexture(): THREE.Texture {
  if (ring) return ring;
  const canvas = Object.assign(document.createElement("canvas"), { width: 32, height: 32 });
  const g = canvas.getContext("2d")!;
  g.strokeStyle = "#fff";
  g.lineWidth = 5;
  g.beginPath();
  g.arc(16, 16, 12, 0, 2 * Math.PI);
  g.stroke();
  return (ring = new THREE.CanvasTexture(canvas));
}

function sub(a: XY, b: XY): XY { return [a[0] - b[0], a[1] - b[1]]; }
function dot(a: XY, b: XY): number { return a[0] * b[0] + a[1] * b[1]; }
function cross(a: XY, b: XY): number { return a[0] * b[1] - a[1] * b[0]; }
function dist(a: XY, b: XY): number { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
function unit(a: XY): XY { const l = Math.hypot(a[0], a[1]); return l < 1e-12 ? [0, 0] : [a[0] / l, a[1] / l]; }
function along(p: XY, u: XY, t: number): XY { return [p[0] + u[0] * t, p[1] + u[1] * t]; }

function polar(c: XY, r: number, a: number): XY { return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]; }

/**
 * Where lines A1B1 and A2B2 meet (null when parallel), and the ray along each from there towards its middle: the
 * angle between the rays is the one c.angle measures (caad.py's _directed_angle).
 */
function corner(A1: XY, B1: XY, A2: XY, B2: XY): { O: XY | null; r1: XY; r2: XY } {
  const [d1, d2] = [unit(sub(B1, A1)), unit(sub(B2, A2))];
  const cr = cross(d1, d2);
  if (Math.abs(cr) < 1e-9) return { O: null, r1: d1, r2: d2 };
  const O = along(A1, d1, cross(sub(A2, A1), d2) / cr);
  const ray = (d: XY, A: XY, B: XY): XY => (dot(sub([(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], O), d) >= 0 ? d : [-d[0], -d[1]]);
  return { O, r1: ray(d1, A1, B1), r2: ray(d2, A2, B2) };
}

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
