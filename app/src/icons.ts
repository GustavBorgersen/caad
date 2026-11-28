// Icons (docs/10-visual-system.md): Lucide for everything general, and the CAD icons Lucide doesn't have, drawn to
// its rules (24 px grid, 2 px stroke, round caps and joins). All bundled: nothing is fetched.
import {
  ArrowLeftRight, Box, Check, ChevronDown, ChevronRight, Circle, Code, Copy, Crosshair, Download, Ellipsis, FileCode, FileCog,
  FileDown, Folder, FolderOpen, History, Keyboard, Lock, Maximize, Monitor, Moon, MousePointer2, Pencil, Plus, Redo2, Scissors,
  Settings, Sparkles, Square, Sun, Trash2, TriangleAlert, Undo2, X, type IconNode,
} from "lucide";

const own = (d: string): IconNode => [...d.matchAll(/<(\w+) ([^>]*?)\/>/g)].map(([, tag, attrs]) =>
  [tag, Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]))] as IconNode[number]);

const ICONS = {
  // general (Lucide)
  undo: Undo2, redo: Redo2, folder: Folder, folderOpen: FolderOpen, settings: Settings, code: Code, chevron: ChevronRight,
  down: ChevronDown, part: Box, fileCode: FileCode, fileCog: FileCog, fileDown: FileDown, more: Ellipsis, lock: Lock,
  alert: TriangleAlert, swap: ArrowLeftRight, agent: Sparkles, plus: Plus, trash: Trash2, rename: Pencil, copy: Copy,
  target: Crosshair, check: Check, x: X, history: History, sun: Sun, moon: Moon, monitor: Monitor, download: Download,
  keyboard: Keyboard, fit: Maximize, select: MousePointer2, trim: Scissors, circle: Circle, rect: Square,
  // CAD (CAAD's own, Lucide style)
  sketch: own('<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>'),
  extrude: own('<path d="M4 17l8 4 8-4-8-4z"/><path d="M12 13V3"/><path d="M8.5 6.5L12 3l3.5 3.5"/>'),
  revolve: own('<path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 3v4h-4"/>'),
  hole: own('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>'),
  fillet: own('<path d="M4 20V10a6 6 0 0 1 6-6h10"/>'),
  chamfer: own('<path d="M4 20v-9l7-7h9"/>'),
  plane: own('<path d="M3 17l5-10h13l-5 10z"/>'),
  mirror: own('<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7L4 17h5z"/><path d="M15 7l5 10h-5z"/>'),
  box: own('<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>'),
  cylinder: own('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/>'),
  sphere: own('<circle cx="12" cy="12" r="8"/><path d="M4 12c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5"/>'),
  loft: own('<path d="M5 19h14"/><path d="M8 5h8"/><path d="M5 19L8 5M19 19L16 5"/>'),
  sweep: own('<path d="M4 18c4 0 4-12 8-12s4 12 8 12"/>'),
  group: own('<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2"/>'),
  line: own('<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/>'),
  arc: own('<path d="M4 18a8 8 0 0 1 16 0"/>'),
  point: own('<circle cx="12" cy="12" r="3.5"/>'),
  dimension: own('<path d="M4 8v8M20 8v8M4 12h16"/><path d="M7 9.5L4 12l3 2.5M17 9.5l3 2.5-3 2.5"/>'),
  construction: own('<path d="M4 20L20 4" stroke-dasharray="3 3"/>'),
  useEdges: own('<path d="M4 20h16"/><path d="M12 4v10"/><path d="M8 10l4 4 4-4"/>'),
  cube: own('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>'),
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** An icon as SVG markup (`class="i"`, sized by CSS, coloured by `currentColor`). */
export function icon(name: IconName, cls = ""): string {
  const inner = ICONS[name].map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(String(v))}"`).join(" ")}/>`).join("");
  return `<svg class="i${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

/** An icon as an element. */
export function iconEl(name: IconName, cls = ""): SVGSVGElement {
  const t = document.createElement("template");
  t.innerHTML = icon(name, cls);
  return t.content.firstElementChild as SVGSVGElement;
}

/** The icon for a timeline feature's kind. */
export function featureIcon(kind: string): IconName {
  return (kind in ICONS ? kind : kind === "code" ? "code" : "group") as IconName;
}
