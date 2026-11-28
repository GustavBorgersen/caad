// The view cube (docs/10-visual-system.md): a small cube in the view's corner that turns with the camera. Click a
// face, an edge or a corner to look from there. Z is up; Front looks from -Y, as build123d's Plane.XZ.
import * as THREE from "three";
import { onThemeChange, tokenCss } from "./theme";
import type { Viewer } from "./viewer";

const FACES: { label: string; normal: [number, number, number] }[] = [
  { label: "Right", normal: [1, 0, 0] }, { label: "Left", normal: [-1, 0, 0] }, { label: "Back", normal: [0, 1, 0] },
  { label: "Front", normal: [0, -1, 0] }, { label: "Top", normal: [0, 0, 1] }, { label: "Bottom", normal: [0, 0, -1] },
]; // in BoxGeometry's group order: +x, -x, +y, -y, +z, -z
const EDGE = 0.22; // this close to a cube edge (of 1) counts as the edge or corner

export class ViewCube {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private cube: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial[]>;
  private outline: THREE.LineSegments;
  private hover = -1;
  private raycaster = new THREE.Raycaster();

  constructor(private el: HTMLElement, private viewer: Viewer) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    el.append(this.renderer.domElement);
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), FACES.map(() => new THREE.MeshBasicMaterial()));
    this.outline = new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry), new THREE.LineBasicMaterial());
    this.scene.add(this.cube, this.outline);
    this.paint();
    onThemeChange(() => { this.paint(); this.render(); });
    viewer.onView(() => this.render());
    new ResizeObserver(() => this.resize()).observe(el);
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointermove", (e) => {
      const hit = this.hit(e);
      const face = hit ? hit.face : -1;
      if (face !== this.hover) { this.hover = face; this.paint(); this.render(); }
    });
    canvas.addEventListener("pointerleave", () => { this.hover = -1; this.paint(); this.render(); });
    canvas.addEventListener("click", (e) => {
      const hit = this.hit(e);
      if (hit) viewer.viewFrom(hit.dir);
    });
    this.resize();
  }

  /** What a click there means: the face under it, and the direction to look from (a face, edge or corner). */
  private hit(e: MouseEvent): { face: number; dir: THREE.Vector3 } | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    const h = this.raycaster.intersectObject(this.cube)[0];
    if (!h || h.face?.materialIndex === undefined) return null;
    const p = h.point;
    const snap = (v: number) => (Math.abs(v) > 0.5 - EDGE ? Math.sign(v) : 0);
    return { face: h.face.materialIndex, dir: new THREE.Vector3(snap(p.x), snap(p.y), snap(p.z)) };
  }

  /** Face labels drawn in the theme's colours. */
  private paint() {
    FACES.forEach((f, i) => {
      const c = Object.assign(document.createElement("canvas"), { width: 128, height: 128 });
      const g = c.getContext("2d")!;
      g.fillStyle = i === this.hover ? tokenCss("--accent-soft") : tokenCss("--panel");
      g.fillRect(0, 0, 128, 128);
      g.fillStyle = i === this.hover ? tokenCss("--accent-text") : tokenCss("--muted");
      g.font = "700 30px system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(f.label, 64, 66);
      const m = this.cube.material[i];
      m.map?.dispose();
      m.map = new THREE.CanvasTexture(c);
      m.map.colorSpace = THREE.SRGBColorSpace;
      m.needsUpdate = true;
    });
    (this.outline.material as THREE.LineBasicMaterial).color.set(tokenCss("--faint"));
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.el;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.render();
  }

  /** Turn the cube like the main camera. */
  render() {
    const q = this.viewer.orientation.quaternion;
    this.camera.position.set(0, 0, 3).applyQuaternion(q);
    this.camera.quaternion.copy(q);
    const s = 0.9;
    Object.assign(this.camera, { left: -s, right: s, top: s, bottom: -s });
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }
}
