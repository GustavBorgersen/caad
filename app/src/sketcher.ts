// Sketch mode: draw rectangles, circles and polygons on a plane or flat face, edit their dimensions,
// then extrude or cut. The result is plain build123d code (see sketch-code.ts).
import * as THREE from "three";
import { num, type Operation, type Shape } from "./sketch-code";
import type { PointerTool, SketchPlane, Viewer } from "./viewer";

type Tool = "rect" | "circle" | "poly";
const HINTS: Record<Tool, string> = {
  rect: "Rectangle: click one corner, then the opposite corner.",
  circle: "Circle: click the centre, then a point on the circle.",
  poly: "Polygon: click the corners; click the first corner again to close. Backspace removes the last point.",
};
const COLOR = { shape: 0xd35400, preview: 0xe67e22, grid: 0xc9d1d9, axis: 0x9aa5b1 };
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];

export type SketchDone = (shapes: Shape[], op: Operation) => void;

export class Sketcher implements PointerTool {
  private group = new THREE.Group();
  private gridGroup = new THREE.Group();
  private shapes: Shape[] = [];
  private tool: Tool = "rect";
  private pending: [number, number][] = []; // clicked points of the shape being drawn
  private cursor: [number, number] | null = null;
  private plane!: SketchPlane;
  private step = 1;
  private op: Operation = { op: "extrude", amount: 10, both: false, through: false };
  private onDone: SketchDone = () => {};
  private onCancel: () => void = () => {};
  active = false;

  constructor(private viewer: Viewer, private panel: HTMLElement) {
    this.group.matrixAutoUpdate = false;
    this.group.renderOrder = 2;
    this.group.add(this.gridGroup);
    window.addEventListener("keydown", (e) => {
      if (!this.active || (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "Escape") { if (this.pending.length) { this.pending = []; this.redraw(); } else this.cancel(); }
      if (e.key === "Backspace" && this.tool === "poly" && this.pending.length) { this.pending.pop(); this.redraw(); }
      if (e.key === "Enter" && this.tool === "poly" && this.pending.length >= 3) this.closePolygon();
    });
  }

  /** Start sketching on a plane. `label` says where (shown in the panel). */
  start(plane: SketchPlane, label: string, size: number, onDone: SketchDone, onCancel: () => void) {
    this.plane = plane;
    this.onDone = onDone;
    this.onCancel = onCancel;
    this.shapes = [];
    this.pending = [];
    this.op = { op: "extrude", amount: 10, both: false, through: false }; // every sketch starts as a plain extrude
    this.active = true;
    const [x, y, z, o] = [plane.x, plane.y, plane.z, plane.origin].map((v) => new THREE.Vector3(...v));
    this.group.matrix.makeBasis(x, y, z).setPosition(o);
    this.group.matrixWorldNeedsUpdate = true;
    this.viewer.lookAtPlane(plane, size);
    this.viewer.setFacesFaded(true);
    this.viewer.tool = this;
    this.viewer.onCameraChange = () => this.updateGrid();
    this.viewer.add(this.group);
    this.updateGrid();
    this.label = label;
    this.renderPanel();
  }

  private label = "";

  stop() {
    this.active = false;
    this.viewer.tool = null;
    this.viewer.onCameraChange = () => {};
    this.viewer.remove(this.group);
    this.viewer.setFacesFaded(false);
    this.viewer.resetUp();
    this.panel.hidden = true;
  }

  private cancel() { this.stop(); this.onCancel(); }

  // --- Pointer --------------------------------------------------------------------------------------

  private local(ev: PointerEvent): [number, number] | null {
    const p = this.viewer.hitPlane(ev, this.plane);
    if (!p) return null;
    const d = p.sub(new THREE.Vector3(...this.plane.origin));
    const snap = (v: number) => Math.round(v / this.step) * this.step;
    return [snap(d.dot(new THREE.Vector3(...this.plane.x))), snap(d.dot(new THREE.Vector3(...this.plane.y)))];
  }

  move(ev: PointerEvent) {
    this.cursor = this.local(ev);
    this.redraw();
  }

  click(ev: PointerEvent) {
    const p = this.local(ev);
    if (!p) return;
    if (this.tool === "poly") {
      const first = this.pending[0];
      if (this.pending.length >= 3 && first && Math.hypot(p[0] - first[0], p[1] - first[1]) < this.step * 0.5 + 1e-9) return this.closePolygon();
      this.pending.push(p);
    } else if (!this.pending.length) {
      this.pending.push(p);
    } else {
      const [a] = this.pending;
      if (this.tool === "rect") {
        const w = Math.abs(p[0] - a[0]), h = Math.abs(p[1] - a[1]);
        if (w > 0 && h > 0) this.shapes.push({ kind: "rect", x: (a[0] + p[0]) / 2, y: (a[1] + p[1]) / 2, w, h });
      } else {
        const r = Math.hypot(p[0] - a[0], p[1] - a[1]);
        if (r > 0) this.shapes.push({ kind: "circle", x: a[0], y: a[1], r });
      }
      this.pending = [];
      this.renderPanel();
    }
    this.redraw();
  }

  private closePolygon() {
    this.shapes.push({ kind: "poly", pts: [...this.pending] });
    this.pending = [];
    this.renderPanel();
    this.redraw();
  }

  // --- Drawing --------------------------------------------------------------------------------------

  private updateGrid() {
    const px = this.viewer.pixelSize(new THREE.Vector3(...this.plane.origin));
    const step = STEPS.find((s) => s / px >= 10) ?? STEPS[STEPS.length - 1];
    if (step === this.step && this.gridGroup.children.length) return;
    this.step = step;
    this.gridGroup.clear();
    const half = Math.ceil((px * 1200) / step) * step;
    const pts: number[] = [];
    for (let v = -half; v <= half + 1e-9; v += step) pts.push(-half, v, 0, half, v, 0, v, -half, 0, v, half, 0);
    const grid = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pts, 3)),
      new THREE.LineBasicMaterial({ color: COLOR.grid, transparent: true, opacity: 0.6, depthTest: false }));
    const axes = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([-half, 0, 0, half, 0, 0, 0, -half, 0, 0, half, 0], 3)),
      new THREE.LineBasicMaterial({ color: COLOR.axis, depthTest: false }));
    this.gridGroup.add(grid, axes);
    const info = this.panel.querySelector(".grid-step");
    if (info) info.textContent = `grid ${num(step)} mm`;
  }

  private outline(s: Shape): [number, number][] {
    if (s.kind === "rect") {
      const [x0, x1, y0, y1] = [s.x - s.w / 2, s.x + s.w / 2, s.y - s.h / 2, s.y + s.h / 2];
      return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
    }
    if (s.kind === "circle") return Array.from({ length: 65 }, (_, i) => [s.x + s.r * Math.cos((i / 64) * 2 * Math.PI), s.y + s.r * Math.sin((i / 64) * 2 * Math.PI)]);
    return [...s.pts, s.pts[0]];
  }

  private line(pts: [number, number][], color: number) {
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x, y, 0)));
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
  }

  private redraw() {
    for (const c of [...this.group.children]) if (c !== this.gridGroup) { this.group.remove(c); (c as THREE.Line).geometry.dispose(); }
    for (const s of this.shapes) this.group.add(this.line(this.outline(s), COLOR.shape));
    const c = this.cursor;
    if (c && this.pending.length) {
      const [a] = this.pending;
      let preview: Shape | null = null;
      if (this.tool === "rect") preview = { kind: "rect", x: (a[0] + c[0]) / 2, y: (a[1] + c[1]) / 2, w: Math.abs(c[0] - a[0]), h: Math.abs(c[1] - a[1]) };
      else if (this.tool === "circle") preview = { kind: "circle", x: a[0], y: a[1], r: Math.hypot(c[0] - a[0], c[1] - a[1]) };
      if (preview) this.group.add(this.line(this.outline(preview), COLOR.preview));
      else this.group.add(this.line([...this.pending, c], COLOR.preview));
    }
    if (c) { // cursor cross, so the snapped position is visible
      const k = this.step * 0.6;
      this.group.add(this.line([[c[0] - k, c[1]], [c[0] + k, c[1]]], COLOR.preview), this.line([[c[0], c[1] - k], [c[0], c[1] + k]], COLOR.preview));
    }
    const pos = this.panel.querySelector(".cursor");
    if (pos) pos.textContent = c ? `(${num(c[0])}, ${num(c[1])})` : "";
    this.viewer.render();
  }

  // --- Panel ----------------------------------------------------------------------------------------

  private renderPanel() {
    const p = this.panel;
    p.hidden = false;
    const field = (label: string, value: number, set: (v: number) => void, min?: number) => {
      const l = document.createElement("label");
      l.textContent = label + " ";
      const i = Object.assign(document.createElement("input"), { type: "number", value: num(value), step: "any" });
      if (min !== undefined) i.min = String(min);
      i.onchange = () => { const v = parseFloat(i.value); if (Number.isFinite(v) && (min === undefined || v > min)) { set(v); this.redraw(); } };
      l.append(i);
      return l;
    };
    p.innerHTML = `
      <div class="row head"><b>Sketch</b> <span class="muted">on ${this.label}</span><span class="spacer"></span><span class="muted grid-step">grid ${num(this.step)} mm</span> <span class="muted cursor"></span></div>
      <div class="row tools"></div>
      <div class="hint muted">${HINTS[this.tool]}</div>
      <div class="shapes"></div>
      <div class="row op"></div>
      <div class="row actions"></div>`;
    const tools = p.querySelector(".tools")!;
    for (const [t, label] of [["rect", "▭ Rectangle"], ["circle", "◯ Circle"], ["poly", "⬠ Polygon"]] as [Tool, string][]) {
      const b = Object.assign(document.createElement("button"), { textContent: label });
      b.classList.toggle("on", this.tool === t);
      b.onclick = () => { this.tool = t; this.pending = []; this.renderPanel(); this.redraw(); };
      tools.append(b);
    }
    const list = p.querySelector(".shapes")!;
    this.shapes.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "row shape";
      row.append(Object.assign(document.createElement("span"), { textContent: s.kind === "rect" ? "▭" : s.kind === "circle" ? "◯" : "⬠" }));
      if (s.kind === "rect") row.append(field("x", s.x, (v) => (s.x = v)), field("y", s.y, (v) => (s.y = v)), field("w", s.w, (v) => (s.w = v), 0), field("h", s.h, (v) => (s.h = v), 0));
      else if (s.kind === "circle") row.append(field("x", s.x, (v) => (s.x = v)), field("y", s.y, (v) => (s.y = v)), field("r", s.r, (v) => (s.r = v), 0));
      else row.append(Object.assign(document.createElement("span"), { className: "muted", textContent: `${s.pts.length} corners` }));
      const del = Object.assign(document.createElement("button"), { textContent: "×", title: "Remove" });
      del.onclick = () => { this.shapes.splice(i, 1); this.renderPanel(); this.redraw(); };
      row.append(del);
      list.append(row);
    });
    if (!this.shapes.length) list.innerHTML = `<div class="muted">No shapes yet.</div>`;

    const op = p.querySelector(".op")!;
    for (const [value, label] of [["extrude", "Extrude"], ["cut", "Cut"]] as const) {
      const b = Object.assign(document.createElement("button"), { textContent: label });
      b.classList.toggle("on", this.op.op === value);
      b.onclick = () => { this.op.op = value; this.renderPanel(); };
      op.append(b);
    }
    if (!(this.op.op === "cut" && this.op.through)) op.append(field("depth", this.op.amount, (v) => (this.op.amount = v), 0));
    const check = (label: string, key: "both" | "through") => {
      const l = document.createElement("label");
      const c = Object.assign(document.createElement("input"), { type: "checkbox", checked: this.op[key] });
      c.onchange = () => { this.op[key] = c.checked; this.renderPanel(); };
      l.append(c, " " + label);
      return l;
    };
    op.append(check("both directions", "both"));
    if (this.op.op === "cut") op.append(check("through all", "through"));

    const actions = p.querySelector(".actions")!;
    const apply = Object.assign(document.createElement("button"), { textContent: this.op.op === "cut" ? "Cut" : "Extrude", className: "primary" });
    apply.disabled = !this.shapes.length;
    apply.onclick = () => { const shapes = this.shapes; const o = { ...this.op }; this.stop(); this.onDone(shapes, o); };
    const cancel = Object.assign(document.createElement("button"), { textContent: "Cancel" });
    cancel.onclick = () => this.cancel();
    actions.append(apply, cancel);
  }

  /** For tests: add a shape as if drawn. */
  addShape(s: Shape) { this.shapes.push(s); this.renderPanel(); this.redraw(); }
}
