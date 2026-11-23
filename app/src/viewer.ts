// 3D view: one mesh for all faces and one line set for all edges, with per-face/per-edge picking
// and colouring. Z is up, as in build123d.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Mesh } from "./kernel";

export type Pick = { kind: "face" | "edge"; index: number; type: string; point: [number, number, number] };

const COLORS = {
  face: new THREE.Color(0xc3ccd6),
  faceHover: new THREE.Color(0xf2d38b),
  faceSelected: new THREE.Color(0xf0a040),
  faceAgent: new THREE.Color(0x7cc4f0),
  edge: new THREE.Color(0x2a3038),
  edgeHover: new THREE.Color(0xd08a00),
  edgeSelected: new THREE.Color(0xe06000),
  edgeAgent: new THREE.Color(0x1a7fd0),
};
const EDGE_PICK_PX = 6;

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private faces: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  private edges: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  private data: Mesh | null = null;
  private faceOfTriangle = new Uint32Array(0);
  private faceVertices: [number, number][] = []; // [first vertex, last vertex] per face
  private edgeOfSegment = new Uint32Array(0);
  private edgeVertices: [number, number][] = [];
  private hovered: Pick | null = null;
  private agent: Pick[] = [];
  selection: Pick[] = [];
  onSelect: (selection: Pick[]) => void = () => {};

  constructor(private el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0xeef1f4);
    el.prepend(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener("change", () => this.render());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, -1, 2);
    this.camera.add(sun); // light follows the camera, so every side is readable
    this.scene.add(this.camera);
    new ResizeObserver(() => this.resize()).observe(el);
    this.bindPointer();
    this.resize();
  }

  /** Show a new mesh. `fit` re-frames the camera (new part); otherwise the view stays put (rebuild). */
  setMesh(mesh: Mesh | null, fit: boolean) {
    for (const obj of [this.faces, this.edges]) if (obj) { this.scene.remove(obj); obj.geometry.dispose(); obj.material.dispose(); }
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
      vertexColors: true, roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, // edges draw on top of faces
    }));

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
    this.recolor();
    if (fit) this.fit(mesh.bbox);
    this.render();
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

  fit(bbox: number[]) {
    const [x0, y0, z0, x1, y1, z1] = bbox;
    const center = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const radius = Math.max(1, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05; // fits the narrower direction
    this.camera.position.copy(center).add(new THREE.Vector3(1, -1.2, 0.9).normalize().multiplyScalar(dist));
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
  }

  /** PNG of the current view (for the agent's `render` tool). */
  screenshot(): string { this.render(); return this.renderer.domElement.toDataURL("image/png"); }

  render() { this.renderer.render(this.scene, this.camera); }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.el;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  private pick(ev: PointerEvent): Pick | null {
    if (!this.faces || !this.edges || !this.data) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const faceHit = this.raycaster.intersectObject(this.faces)[0];
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
    canvas.addEventListener("pointermove", (ev) => {
      if (ev.buttons) return;
      const hit = this.pick(ev);
      if (hit?.kind !== this.hovered?.kind || hit?.index !== this.hovered?.index) {
        this.hovered = hit;
        canvas.style.cursor = hit ? "pointer" : "";
        this.recolor();
        this.render();
      }
    });
    canvas.addEventListener("pointerdown", (ev) => { down = { x: ev.clientX, y: ev.clientY }; });
    canvas.addEventListener("pointerup", (ev) => {
      if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 4 || ev.button !== 0) return; // a drag, not a click
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
    this.faceVertices.forEach((r) => paint(fc, r, COLORS.face));
    this.edgeVertices.forEach((r) => paint(ec, r, COLORS.edge));
    const mark = (p: Pick, face: THREE.Color, edge: THREE.Color) =>
      p.kind === "face" ? paint(fc, this.faceVertices[p.index], face) : paint(ec, this.edgeVertices[p.index], edge);
    for (const p of this.agent) mark(p, COLORS.faceAgent, COLORS.edgeAgent);
    if (this.hovered) mark(this.hovered, COLORS.faceHover, COLORS.edgeHover);
    for (const p of this.selection) mark(p, COLORS.faceSelected, COLORS.edgeSelected);
    fc.needsUpdate = ec.needsUpdate = true;
  }
}
