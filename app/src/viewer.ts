// 3D view: one mesh for all faces and one line set for all edges, with per-face/per-edge picking
// and colouring. Z is up, as in build123d.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { Mesh, PlaneOutline, SketchOutline } from "./kernel";
import { onThemeChange, reduceMotion, token } from "./theme";

export type SketchPlane = { origin: number[]; x: number[]; y: number[]; z: number[] };

/** Takes over the pointer while sketching (the camera still orbits with drag, unless the tool takes it). */
export interface PointerTool {
  move(ev: PointerEvent): void;
  click(ev: PointerEvent): void;
  /** Pressed: return true to take this drag (dragging sketch geometry); the camera stays until release. */
  down?(ev: PointerEvent): boolean;
  drag?(ev: PointerEvent): void;
  /** Released after a taken drag (also when it didn't move: the tool decides whether that was a click). */
  up?(ev: PointerEvent): void;
}

export type Pick = { kind: "face" | "edge"; index: number; type: string; point: [number, number, number] };

// Colours come from the theme's tokens (docs/10-visual-system.md), read again when the theme changes.
const mix = (a: number, b: number, t: number) => new THREE.Color(a).lerp(new THREE.Color(b), t);
function palette() {
  return {
    face: mix(token("--part-hi"), token("--part-lo"), 0.12),
    faceHover: new THREE.Color(token("--hov-hi")),
    faceSelected: new THREE.Color(token("--sel-hi")),
    facePreview: new THREE.Color(token("--pre-hi")),
    faceAgent: mix(token("--agent"), token("--part-hi"), 0.55),
    faceFaded: mix(token("--part-hi"), token("--panel"), 0.55),
    edge: new THREE.Color(token("--edge")),
    edgeFaded: new THREE.Color(token("--cons")),
    edgeHover: new THREE.Color(token("--hov-lo")),
    edgeSelected: new THREE.Color(token("--accent")),
    edgePreview: new THREE.Color(token("--pre-lo")),
    edgeAgent: new THREE.Color(token("--agent")),
    sketch: token("--sk"), // outlines of sketches no feature uses yet
    plane: token("--plane"), // plane features
    axisX: token("--axis-x"), axisY: token("--axis-y"), // a plane's own X and Y, as in the sketch editor
    background: token("--view-bottom"),
  };
}
let COLORS = palette();
const EDGE_PICK_PX = 6;
const MARKED_EDGE_PX = 3; // selected/hovered/highlighted edges are drawn this wide (WebGL lines are always 1 px)

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private sun = new THREE.DirectionalLight(0xffffff, 1.6);
  private faces: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  private edges: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  private data: Mesh | null = null;
  private faceOfTriangle = new Uint32Array(0);
  private faceVertices: [number, number][] = []; // [first vertex, last vertex] per face
  private edgeOfSegment = new Uint32Array(0);
  private edgeVertices: [number, number][] = [];
  private marked: LineSegments2 | null = null; // wide lines for selected, hovered and highlighted edges
  private markedMaterial = new LineMaterial({ linewidth: MARKED_EDGE_PX, vertexColors: true, depthTest: true });
  private hovered: Pick | null = null;
  private agent: Pick[] = [];
  private faded = false;
  private fresh = new Set<number>(); // faces a dialog's preview adds or changes (drawn in the preview colour)
  private previewBase: Set<string> | null = null; // the faces before the edited feature, as keys (see faceKey)
  selection: Pick[] = [];
  onSelect: (selection: Pick[]) => void = () => {};
  /** Right-click without dragging (a drag pans): what is under the pointer, for the context menu. */
  onContext: (pick: Pick | null, ev: MouseEvent) => void = () => {};
  tool: PointerTool | null = null;
  onCameraChange: () => void = () => {};
  /** Called on every camera change, besides onCameraChange (the view cube). */
  private viewListeners = new Set<() => void>();

  constructor(private el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); // transparent: the view's gradient shows through
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    el.prepend(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener("change", () => { this.onCameraChange(); for (const f of this.viewListeners) f(); this.render(); });
    onThemeChange(() => this.retheme());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 1.6));
    const sun = this.sun;
    sun.position.set(1, -1, 2);
    this.camera.add(sun); // light follows the camera, so every side is readable
    this.scene.add(this.camera);
    new ResizeObserver(() => this.resize()).observe(el);
    this.bindPointer();
    this.resize();
  }

  /** Show a new mesh. `fit` re-frames the camera (new part); otherwise the view stays put (rebuild). */
  setMesh(mesh: Mesh | null, fit: boolean, preview = false) {
    for (const obj of [this.faces, this.edges]) if (obj) { this.scene.remove(obj); obj.geometry.dispose(); obj.material.dispose(); }
    if (this.marked) { this.scene.remove(this.marked); this.marked.geometry.dispose(); this.marked = null; }
    this.faces = this.edges = null;
    this.data = mesh;
    this.hovered = null;
    this.selection = [];
    this.agent = []; // the page restores the selection after a rebuild (see setSelection)
    if (!mesh) { this.render(); return; }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geo.computeVertexNormals(); // vertices are per face, so normals are smooth within a face only
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.positions.length), 3));
    this.faceOfTriangle = new Uint32Array(mesh.indices.length / 3);
    this.faceVertices = mesh.faces.map(([start, count], f) => {
      let lo = Infinity, hi = -1;
      for (let i = start; i < start + count; i++) { lo = Math.min(lo, mesh.indices[i]); hi = Math.max(hi, mesh.indices[i]); }
      this.faceOfTriangle.fill(f, start / 3, (start + count) / 3);
      return [lo, hi];
    });
    this.faces = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.6, metalness: 0, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, // edges draw on top of faces
    }));
    // A preview: the faces that weren't there before the edited feature are drawn in the preview colour.
    this.fresh = new Set();
    if (preview && this.previewBase) mesh.faces.forEach((_, f) => { if (!this.previewBase!.has(faceKey(mesh, f))) this.fresh.add(f); });

    const segs: number[] = [], edgeOfSeg: number[] = [];
    this.edgeVertices = mesh.edges.map((e, i) => {
      const first = segs.length / 3;
      for (let k = 0; k + 5 < e.points.length; k += 3) {
        segs.push(...e.points.subarray(k, k + 6));
        edgeOfSeg.push(i);
      }
      return [first, segs.length / 3 - 1];
    });
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segs), 3));
    lgeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(segs.length), 3));
    this.edgeOfSegment = new Uint32Array(edgeOfSeg);
    this.edges = new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({ vertexColors: true }));

    this.scene.add(this.faces, this.edges);
    this.applyFade();
    this.recolor();
    if (fit) this.fit(mesh.bbox);
    this.render();
  }

  /** A dialog opened on the shown part: its later previews colour what they add or change. Null: no preview. */
  setPreviewBase(mesh: Mesh | null) {
    this.previewBase = mesh ? new Set(mesh.faces.map((_, f) => faceKey(mesh, f))) : null;
    if (!mesh && this.fresh.size) { this.fresh.clear(); this.recolor(); this.render(); }
  }

  /** Set the selection from face/edge indices (e.g. restored after a rebuild) without firing onSelect. */
  setSelection(items: { kind: "face" | "edge"; index: number }[]) {
    if (!this.data) return;
    const d = this.data;
    this.selection = items
      .filter((i) => i.index < (i.kind === "face" ? d.faces.length : d.edges.length))
      .map((i) => ({ ...i, type: i.kind === "face" ? d.face_types[i.index] : d.edges[i.index].type, point: [0, 0, 0] }));
    this.recolor();
    this.render();
  }

  /** Highlight geometry on behalf of the agent (shown in blue until the user clicks). */
  highlight(picks: Pick[]) { this.agent = picks; this.recolor(); this.render(); }

  private sketchLines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  private planes: THREE.Group | null = null;
  private sketchPoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;

  /** Outlines of the sketches no feature uses yet. `fit` frames them (a part without a solid yet). */
  private lastSketches: SketchOutline[] = [];
  private lastPlanes: PlaneOutline[] | undefined;

  setSketches(sketches: SketchOutline[], fit: boolean) {
    this.lastSketches = sketches;
    for (const obj of [this.sketchLines, this.sketchPoints]) {
      if (!obj) continue;
      this.scene.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
    }
    this.sketchLines = this.sketchPoints = null;
    const dots = sketches.flatMap((s) => s.points ?? []);
    if (dots.length) { // drawn points (where holes can go)
      const geo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(dots, 3));
      this.sketchPoints = new THREE.Points(geo, new THREE.PointsMaterial({ color: COLORS.sketch, size: 7, sizeAttenuation: false, depthTest: false }));
      this.sketchPoints.renderOrder = 3;
      this.scene.add(this.sketchPoints);
    }
    const segs: number[] = [];
    for (const s of sketches) for (const e of s.edges) for (let k = 0; k + 5 < e.points.length; k += 3) segs.push(...e.points.subarray(k, k + 6));
    if (segs.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segs), 3));
      // Drawn on top of the part: a sketch often lies on or inside it.
      this.sketchLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: COLORS.sketch, depthTest: false }));
      this.sketchLines.renderOrder = 3;
      this.scene.add(this.sketchLines);
      if (fit) {
        geo.computeBoundingBox();
        const { min, max } = geo.boundingBox!;
        this.fit([min.x, min.y, min.z, max.x, max.y, max.z]);
      }
    }
    if (fit && !segs.length && dots.length) {
      this.sketchPoints!.geometry.computeBoundingBox();
      const { min, max } = this.sketchPoints!.geometry.boundingBox!;
      this.fit([min.x, min.y, min.z, max.x, max.y, max.z]);
    }
    this.render();
  }

  /** Plane features: a translucent square with an outline each, drawn on top like sketches. */
  setPlanes(planes: PlaneOutline[] | undefined) {
    this.lastPlanes = planes;
    if (this.planes) {
      this.scene.remove(this.planes);
      this.planes.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) { o.geometry.dispose(); o.material.dispose(); }
        if (o instanceof THREE.Sprite) { o.material.map?.dispose(); o.material.dispose(); }
      });
      this.planes = null;
    }
    if (planes?.length) {
      const tris: number[] = [], segs: number[] = [], axes = { X: [] as number[], Y: [] as number[] }, labels: THREE.Sprite[] = [];
      for (const { corners: c } of planes) {
        const p = (i: number) => c.slice(3 * i, 3 * i + 3);
        tris.push(...p(0), ...p(1), ...p(2), ...p(0), ...p(2), ...p(3));
        for (let i = 0; i < 4; i++) segs.push(...p(i), ...p((i + 1) % 4));
        // Its X and Y from the middle: arrows, labelled (corners go -x-y, +x-y, +x+y, -x+y).
        const [c0, c1, , c3] = [0, 1, 2, 3].map((i) => new THREE.Vector3(...p(i)));
        const [hx, hy] = [c1.clone().sub(c0).multiplyScalar(0.5), c3.clone().sub(c0).multiplyScalar(0.5)];
        const mid = c0.clone().add(hx).add(hy);
        for (const [axis, d, n] of [["X", hx, hy], ["Y", hy, hx]] as const) {
          const tip = mid.clone().addScaledVector(d, 0.5), back = tip.clone().addScaledVector(d, -0.08);
          axes[axis].push(...mid.toArray(), ...tip.toArray());
          for (const side of [1, -1]) axes[axis].push(...tip.toArray(), ...back.clone().addScaledVector(n, 0.035 * side).toArray());
          labels.push(axisLabel(axis, axis === "X" ? COLORS.axisX : COLORS.axisY, tip.clone().addScaledVector(d, 0.12), hx.length() * 0.14));
        }
      }
      const fill = new THREE.Mesh(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(tris, 3)),
        new THREE.MeshBasicMaterial({ color: COLORS.plane, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      const outline = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(segs, 3)),
        new THREE.LineBasicMaterial({ color: COLORS.plane, transparent: true, opacity: 0.7 }));
      const arrows = (["X", "Y"] as const).map((a) => new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(axes[a], 3)),
        new THREE.LineBasicMaterial({ color: a === "X" ? COLORS.axisX : COLORS.axisY })));
      fill.renderOrder = outline.renderOrder = 2;
      for (const o of [...arrows, ...labels]) o.renderOrder = 3;
      this.planes = new THREE.Group().add(fill, outline, ...arrows, ...labels);
      this.scene.add(this.planes);
    }
    this.render();
  }

  /** Frame a box from the standard direction (a new part), or keeping the current direction (`keep`). */
  fit(bbox: number[], opts: { keep?: boolean; animate?: boolean } = {}) {
    const [x0, y0, z0, x1, y1, z1] = bbox;
    const center = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const radius = Math.max(1, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05; // fits the narrower direction
    const dir = opts.keep ? this.camera.position.clone().sub(this.controls.target).normalize() : new THREE.Vector3(1, -1.2, 0.9).normalize();
    this.moveCamera(center, dir, opts.keep ? this.camera.up.clone() : new THREE.Vector3(0, 0, 1), dist, opts.animate ?? false);
  }

  /** The bounding box of what is shown (the part, else its sketches). */
  get bbox(): number[] | null {
    if (this.data) return this.data.bbox;
    const g = this.sketchLines?.geometry ?? this.sketchPoints?.geometry;
    if (!g) return null;
    g.computeBoundingBox();
    const { min, max } = g.boundingBox!;
    return [min.x, min.y, min.z, max.x, max.y, max.z];
  }

  private anim = 0;
  private animEnd = 0; // ends a move on time if animation frames stall (a busy or hidden page)

  /** Put the camera at `dist` from `center` along `dir` with `up`; animated (250 ms) unless reduce motion is on. */
  moveCamera(center: THREE.Vector3, dir: THREE.Vector3, up: THREE.Vector3, dist: number, animate = true) {
    cancelAnimationFrame(this.anim);
    clearTimeout(this.animEnd);
    const end = { pos: center.clone().addScaledVector(dir.clone().normalize(), dist), target: center.clone(), up: up.clone().normalize() };
    const finish = () => {
      cancelAnimationFrame(this.anim);
      clearTimeout(this.animEnd);
      this.camera.position.copy(end.pos);
      this.camera.up.copy(end.up);
      this.camera.near = dist / 100;
      this.camera.far = dist * 100;
      this.camera.updateProjectionMatrix();
      this.controls.target.copy(end.target);
      this.controls.update();
    };
    if (!animate || reduceMotion()) { finish(); return; }
    const start = { target: this.controls.target.clone(), up: this.camera.up.clone(), off: this.camera.position.clone().sub(this.controls.target) };
    const endOff = end.pos.clone().sub(end.target);
    const [r0, r1] = [start.off.length(), endOff.length()];
    const q = new THREE.Quaternion().setFromUnitVectors(start.off.clone().normalize(), endOff.clone().normalize());
    const t0 = performance.now(), ms = 250;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms), e = 1 - (1 - t) ** 3; // ease out
      const off = start.off.clone().normalize().applyQuaternion(new THREE.Quaternion().slerp(q, e)).multiplyScalar(r0 + (r1 - r0) * e);
      this.controls.target.lerpVectors(start.target, end.target, e);
      this.camera.position.copy(this.controls.target).add(off);
      this.camera.up.lerpVectors(start.up, end.up, e).normalize();
      this.camera.near = Math.min(r0, r1) / 100;
      this.camera.far = Math.max(r0, r1) * 100;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      if (t < 1) this.anim = requestAnimationFrame(step); else finish();
    };
    this.anim = requestAnimationFrame(step);
    this.animEnd = window.setTimeout(finish, ms + 150);
  }

  /** Look from a direction (the view cube, standard views), keeping what is shown framed. */
  viewFrom(dir: THREE.Vector3, up?: THREE.Vector3) {
    const bb = this.bbox;
    const target = this.controls.target.clone();
    let dist = this.camera.position.distanceTo(target);
    if (bb) {
      const [x0, y0, z0, x1, y1, z1] = bb;
      target.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      const radius = Math.max(1, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2);
      const vfov = THREE.MathUtils.degToRad(this.camera.fov);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
      dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05;
    }
    const d = dir.clone().normalize();
    const u = up ?? (Math.abs(d.z) > 0.99 ? new THREE.Vector3(0, d.z > 0 ? 1 : -1, 0).multiplyScalar(d.z > 0 ? 1 : -1) : new THREE.Vector3(0, 0, 1));
    this.moveCamera(target, d, u, dist);
  }

  /** Look straight at a face of the part (its outward normal towards the viewer). */
  viewNormalToFace(index: number) {
    const d = this.data;
    if (!d) return;
    const [start, count] = d.faces[index];
    const n = new THREE.Vector3(), c = new THREE.Vector3(), [a, b, e] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    let area = 0;
    for (let i = start; i < start + count; i += 3) {
      a.fromArray(d.positions, 3 * d.indices[i]); b.fromArray(d.positions, 3 * d.indices[i + 1]); e.fromArray(d.positions, 3 * d.indices[i + 2]);
      const t = b.clone().sub(a).cross(e.clone().sub(a));
      n.add(t);
      area += t.length();
      c.addScaledVector(a.clone().add(b).add(e), t.length() / 3);
    }
    if (n.lengthSq() < 1e-12) return;
    n.normalize();
    const up = Math.abs(n.z) > 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    this.moveCamera(this.controls.target.clone().lerp(c.divideScalar(area || 1), 1), n, up, this.camera.position.distanceTo(this.controls.target));
  }

  /** The camera's direction and up, for the view cube. */
  get orientation(): { quaternion: THREE.Quaternion } { return { quaternion: this.camera.quaternion }; }
  onView(f: () => void) { this.viewListeners.add(f); }

  /** Repaint with the theme's colours. */
  private retheme() {
    COLORS = palette();
    this.applyFade();
    this.recolor();
    this.setSketches(this.lastSketches, false);
    this.setPlanes(this.lastPlanes);
    this.offscreen?.setClearColor(COLORS.background);
    this.render();
  }

  private offscreen: THREE.WebGLRenderer | null = null;

  /**
   * PNG (base64, no data: prefix) for the agent. "current" is the user's camera; named views frame the
   * whole part from that side. The user's view is not changed.
   */
  renderImage(view = "current", width = 800, height = 600): string {
    if (!this.offscreen) {
      this.offscreen = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      this.offscreen.setClearColor(COLORS.background);
    }
    this.offscreen.setSize(width, height, false);
    const cam = this.camera.clone();
    cam.aspect = width / height;
    const dirs: Record<string, [number, number, number]> = {
      iso: [1, -1.2, 0.9], front: [0, -1, 0], back: [0, 1, 0], top: [0, 0, 1], bottom: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0],
    };
    if (view !== "current" && this.data && dirs[view]) {
      const [x0, y0, z0, x1, y1, z1] = this.data.bbox;
      const center = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      const radius = Math.max(1, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2);
      const vfov = THREE.MathUtils.degToRad(cam.fov);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect);
      const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05;
      cam.up.set(0, 0, 1);
      if (view === "top" || view === "bottom") cam.up.set(0, 1, 0);
      cam.position.copy(center).add(new THREE.Vector3(...dirs[view]).normalize().multiplyScalar(dist));
      cam.near = dist / 100;
      cam.far = dist * 100;
      cam.lookAt(center);
    }
    cam.clear(); // the clone copied the light; use the real one instead, so it follows this camera
    cam.add(this.sun);
    this.scene.add(cam);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const res = this.markedMaterial.resolution.clone();
    this.markedMaterial.resolution.set(width, height);
    this.offscreen.render(this.scene, cam);
    this.markedMaterial.resolution.copy(res);
    this.scene.remove(cam);
    this.camera.add(this.sun);
    return this.offscreen.domElement.toDataURL("image/png").split(",")[1];
  }

  render() { this.renderer.render(this.scene, this.camera); }

  add(obj: THREE.Object3D) { this.scene.add(obj); this.render(); }
  remove(obj: THREE.Object3D) { this.scene.remove(obj); this.render(); }

  /** Where the pointer's ray meets a plane (world coordinates), or null. */
  hitPlane(ev: PointerEvent, plane: SketchPlane): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const n = new THREE.Vector3(...plane.z);
    const p = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...plane.origin));
    return this.raycaster.ray.intersectPlane(p, new THREE.Vector3());
  }

  /** What the pointer's ray hits among `objects`, nearest first. */
  raycast(ev: PointerEvent, objects: THREE.Object3D[]): THREE.Intersection[] {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObjects(objects, false);
  }

  get canvas(): HTMLCanvasElement { return this.renderer.domElement; }

  /** Where a point in the scene is on the canvas, in CSS pixels from its top left. */
  toScreen(at: THREE.Vector3): { x: number; y: number } {
    const p = at.clone().project(this.camera);
    const el = this.renderer.domElement;
    return { x: ((p.x + 1) / 2) * el.clientWidth, y: ((1 - p.y) / 2) * el.clientHeight };
  }

  /** World size of one screen pixel at a point. */
  pixelSize(at: THREE.Vector3): number {
    const h = this.renderer.domElement.clientHeight || 1;
    return (2 * this.camera.position.distanceTo(at) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / h;
  }

  /** Look straight at a sketch plane (its normal towards the viewer, its Y axis up). */
  lookAtPlane(plane: SketchPlane, size: number) {
    const o = new THREE.Vector3(...plane.origin);
    const dist = (size / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.4;
    this.camera.up.set(...(plane.y as [number, number, number]));
    this.camera.position.copy(o).add(new THREE.Vector3(...plane.z).multiplyScalar(dist));
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(o);
    this.controls.update();
  }

  /** Back to Z-up orbiting after sketching. */
  resetUp() { this.camera.up.set(0, 0, 1); this.controls.update(); this.render(); }

  /** Sketch mode: the part fades back (lighter and see-through, its edges in the construction colour). */
  setFacesFaded(faded: boolean) {
    this.faded = faded;
    this.applyFade();
    this.recolor();
    this.render();
  }

  private applyFade() {
    if (!this.faces) return;
    this.faces.material.transparent = this.faded;
    this.faces.material.opacity = this.faded ? 0.5 : 1;
    this.faces.material.depthWrite = !this.faded;
    this.faces.material.needsUpdate = true;
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.el;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.markedMaterial.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  private pick(ev: PointerEvent): Pick | null {
    return this.pickAt(ev, false);
  }

  /** The part's edge under the cursor (for the sketch editor's Use tool): faces don't hide edges here. */
  pickEdge(ev: PointerEvent): Pick | null {
    return this.pickAt(ev, true);
  }

  /** Show `p` as hovered (the sketch editor's Use tool, which has the pointer). */
  hoverPick(p: Pick | null) {
    if (p?.kind === this.hovered?.kind && p?.index === this.hovered?.index) return;
    this.hovered = p;
    this.recolor();
    this.render();
  }

  private pickAt(ev: PointerEvent, edgesOnly: boolean): Pick | null {
    if (!this.faces || !this.edges || !this.data) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const faceHit = edgesOnly ? undefined : this.raycaster.intersectObject(this.faces)[0];
    // Edge pick tolerance: a few pixels, converted to world units at the target distance.
    const dist = faceHit?.distance ?? this.camera.position.distanceTo(this.controls.target);
    const pxWorld = (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / rect.height;
    this.raycaster.params.Line = { threshold: EDGE_PICK_PX * pxWorld };
    const edgeHit = this.raycaster.intersectObject(this.edges)[0];
    const p = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];
    // Prefer the edge when it's near the cursor and not hidden behind the face under it.
    if (edgeHit && edgeHit.index !== undefined && (!faceHit || edgeHit.distance <= faceHit.distance + EDGE_PICK_PX * pxWorld * 2)) {
      const index = this.edgeOfSegment[edgeHit.index / 2];
      return { kind: "edge", index, type: this.data.edges[index].type, point: p(edgeHit.point) };
    }
    if (faceHit && faceHit.faceIndex != null) {
      const index = this.faceOfTriangle[faceHit.faceIndex];
      return { kind: "face", index, type: this.data.face_types[index], point: p(faceHit.point) };
    }
    return null;
  }

  private bindPointer() {
    const canvas = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    let taken = false; // the tool took this drag
    canvas.addEventListener("pointermove", (ev) => {
      if (taken) { this.tool?.drag?.(ev); return; }
      if (ev.buttons) return;
      if (this.tool) { this.tool.move(ev); return; }
      const hit = this.pick(ev);
      if (hit?.kind !== this.hovered?.kind || hit?.index !== this.hovered?.index) {
        this.hovered = hit;
        canvas.style.cursor = hit ? "pointer" : "";
        this.recolor();
        this.render();
      }
    });
    let right: { x: number; y: number } | null = null;
    canvas.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (right && Math.hypot(ev.clientX - right.x, ev.clientY - right.y) > 4) return; // a pan, not a click
      this.onContext(this.tool ? null : this.pick(ev as PointerEvent), ev);
    });
    canvas.addEventListener("pointerdown", (ev) => {
      if (ev.button === 2) right = { x: ev.clientX, y: ev.clientY };
      down = { x: ev.clientX, y: ev.clientY };
      if (ev.button === 0 && this.tool?.down?.(ev)) {
        taken = true;
        this.controls.enabled = false;
        canvas.setPointerCapture(ev.pointerId);
      }
    }, { capture: true }); // before OrbitControls, so a taken drag doesn't orbit
    canvas.addEventListener("pointerup", (ev) => {
      if (taken) {
        taken = false;
        this.controls.enabled = true;
        this.tool?.up?.(ev);
        return;
      }
      if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 4 || ev.button !== 0) return; // a drag, not a click
      if (this.tool) { this.tool.click(ev); return; }
      const hit = this.pick(ev);
      const same = (a: Pick) => hit && a.kind === hit.kind && a.index === hit.index;
      if (!hit) this.selection = [];
      else if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
        this.selection = this.selection.some(same) ? this.selection.filter((a) => !same(a)) : [...this.selection, hit];
      } else this.selection = this.selection.length === 1 && same(this.selection[0]) ? [] : [hit];
      this.agent = [];
      this.recolor();
      this.render();
      this.onSelect(this.selection);
    });
  }

  private recolor() {
    if (!this.faces || !this.edges) return;
    const fc = this.faces.geometry.getAttribute("color") as THREE.BufferAttribute;
    const ec = this.edges.geometry.getAttribute("color") as THREE.BufferAttribute;
    const paint = (attr: THREE.BufferAttribute, [lo, hi]: [number, number], c: THREE.Color) => {
      for (let v = lo; v <= hi; v++) attr.setXYZ(v, c.r, c.g, c.b);
    };
    this.faceVertices.forEach((r, f) => paint(fc, r, this.faded ? COLORS.faceFaded : this.fresh.has(f) ? COLORS.facePreview : COLORS.face));
    this.edgeVertices.forEach((r) => paint(ec, r, this.faded ? COLORS.edgeFaded : COLORS.edge));
    const mark = (p: Pick, face: THREE.Color, edge: THREE.Color) =>
      p.kind === "face" ? paint(fc, this.faceVertices[p.index], face) : paint(ec, this.edgeVertices[p.index], edge);
    for (const p of this.agent) mark(p, COLORS.faceAgent, COLORS.edgeAgent);
    if (this.hovered) mark(this.hovered, COLORS.faceHover, COLORS.edgeHover);
    for (const p of this.selection) mark(p, COLORS.faceSelected, COLORS.edgeSelected);
    fc.needsUpdate = ec.needsUpdate = true;
    this.updateMarkedEdges();
  }

  /** Wide lines for marked edges, later marks (selection) drawn over earlier ones (agent). */
  private updateMarkedEdges() {
    if (this.marked) { this.scene.remove(this.marked); this.marked.geometry.dispose(); this.marked = null; }
    if (!this.data) return;
    const marks: [Pick, THREE.Color][] = [
      ...this.agent.map((p): [Pick, THREE.Color] => [p, COLORS.edgeAgent]),
      ...(this.hovered ? [[this.hovered, COLORS.edgeHover] as [Pick, THREE.Color]] : []),
      ...this.selection.map((p): [Pick, THREE.Color] => [p, COLORS.edgeSelected]),
    ].filter(([p]) => p.kind === "edge");
    if (!marks.length) return;
    const pos: number[] = [], col: number[] = [];
    for (const [p, c] of marks) {
      const pts = this.data.edges[p.index].points;
      for (let k = 0; k + 5 < pts.length; k += 3) {
        pos.push(...pts.subarray(k, k + 6));
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    const geo = new LineSegmentsGeometry();
    geo.setPositions(pos);
    geo.setColors(col);
    this.marked = new LineSegments2(geo, this.markedMaterial);
    this.marked.renderOrder = 1;
    this.scene.add(this.marked);
  }
}

/**
 * A face as a key that survives rebuilds when the face's surface stays: a flat face by its plane (so one that only
 * grew or shrank, next to a new fillet, still matches), others by their centre and area.
 */
function faceKey(mesh: Mesh, f: number): string {
  const [start, count] = mesh.faces[f];
  const p = mesh.positions, ix = mesh.indices;
  let area = 0, cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
  for (let i = start; i < start + count; i += 3) {
    const [a, b, c] = [3 * ix[i], 3 * ix[i + 1], 3 * ix[i + 2]];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const [wx, wy, wz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const t = Math.hypot(wx, wy, wz) / 2;
    area += t;
    nx += wx; ny += wy; nz += wz;
    cx += t * (p[a] + p[b] + p[c]) / 3; cy += t * (p[a + 1] + p[b + 1] + p[c + 1]) / 3; cz += t * (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
  }
  if (!area) return `${mesh.face_types[f]}:${f}`;
  const r = (v: number, step: number) => (Math.round(v / step) * step).toFixed(2);
  [cx, cy, cz] = [cx / area, cy / area, cz / area];
  if (mesh.face_types[f] === "PLANE") {
    const l = Math.hypot(nx, ny, nz) || 1;
    [nx, ny, nz] = [nx / l, ny / l, nz / l];
    return `P:${r(nx, 0.01)},${r(ny, 0.01)},${r(nz, 0.01)}:${r(nx * cx + ny * cy + nz * cz, 0.01)}`;
  }
  return `${mesh.face_types[f]}:${r(area, 0.05)}:${r(cx, 0.05)},${r(cy, 0.05)},${r(cz, 0.05)}`;
}

/** A letter in the view, `size` across, always facing the camera. */
function axisLabel(text: string, color: number, at: THREE.Vector3, size: number): THREE.Sprite {
  const canvas = Object.assign(document.createElement("canvas"), { width: 64, height: 64 });
  const g = canvas.getContext("2d")!;
  g.font = "600 48px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  g.fillText(text, 32, 34);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false }));
  sprite.position.copy(at);
  sprite.scale.setScalar(size);
  return sprite;
}
