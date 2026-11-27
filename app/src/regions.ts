// Picking a sketch's regions in the view for the feature dialog's sketch field: a translucent fill per region,
// the chosen ones in the sketch colour; a click toggles one (the dialog writes regions(sk1, ...)).
import * as THREE from "three";
import type { SketchRegion } from "./kernel";
import type { PointerTool, Viewer } from "./viewer";

const COLOR = 0x1f6feb; // the sketch colour
const HOVER = 0xf0a040;

export class RegionPicker implements PointerTool {
  private group = new THREE.Group();
  private fills: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
  private hovered = -1;

  constructor(private viewer: Viewer, readonly regions: SketchRegion[], private toggle: (index: number) => void) {
    const segs: number[] = [];
    regions.forEach((r, i) => {
      const fill = new THREE.Mesh(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(r.triangles, 3)),
        new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
      fill.renderOrder = 4; // on top of the part, like sketch outlines
      fill.userData.region = i;
      this.fills.push(fill);
      this.group.add(fill);
      segs.push(...r.lines);
    });
    const outline = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(segs, 3)),
      new THREE.LineBasicMaterial({ color: COLOR, depthTest: false }));
    outline.renderOrder = 5;
    this.group.add(outline);
    this.paint();
    viewer.add(this.group);
  }

  private paint() {
    this.fills.forEach((f, i) => {
      const selected = this.regions[i].selected;
      f.material.color.set(i === this.hovered ? HOVER : COLOR);
      f.material.opacity = i === this.hovered ? 0.45 : selected ? 0.4 : 0.06;
    });
    this.viewer.render();
  }

  private hit(ev: PointerEvent): number {
    const h = this.viewer.raycast(ev, this.fills)[0];
    return h ? (h.object.userData.region as number) : -1;
  }

  move(ev: PointerEvent) {
    const i = this.hit(ev);
    if (i === this.hovered) return;
    this.hovered = i;
    this.viewer.canvas.style.cursor = i >= 0 ? "pointer" : "";
    this.paint();
  }

  click(ev: PointerEvent) {
    const i = this.hit(ev);
    if (i >= 0) this.toggle(i);
  }

  /** Where region `i` is on the canvas (the middle of its first triangle), for tests. */
  screen(i: number): { x: number; y: number } {
    const t = this.regions[i].triangles;
    return this.viewer.toScreen(new THREE.Vector3((t[0] + t[3] + t[6]) / 3, (t[1] + t[4] + t[7]) / 3, (t[2] + t[5] + t[8]) / 3));
  }

  dispose() {
    this.viewer.remove(this.group);
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) { o.geometry.dispose(); o.material.dispose(); }
    });
    this.viewer.canvas.style.cursor = "";
  }
}
