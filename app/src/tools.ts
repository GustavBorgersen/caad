// The agent's tools, answered by the page. Definitions (names, schemas) are in ../../bridge/tools.json.
import { text, type ToolHandler, type ToolResult } from "./agent";
import type { BuildResult, Feature, Kernel, SelectInfo } from "./kernel";
import type { Project } from "./project";
import type { Pick, Viewer } from "./viewer";

export interface App {
  kernel: Kernel;
  viewer: Viewer;
  project(): Project | null;
  path(): string | null;
  result(): BuildResult | null;
  selection(): SelectInfo[];
  openPart(path: string, rollback?: number | null): Promise<BuildResult | null>;
  /** Save new source for a part, show it and rebuild. */
  applyCode(path: string, code: string): Promise<BuildResult | null>;
  note(message: string | null): void;
}

const KERNEL_WAIT_MS = 100_000;
const fmt = (n: number) => +n.toFixed(2);

export function describeBuild(path: string, r: BuildResult | null): string {
  if (!r) return `${path}: superseded by a newer build — call get_timeline.`;
  const lines: string[] = [];
  if (r.ok) lines.push(`${path}: built OK in ${r.times.build} s.`);
  else if (r.error?.feature != null) {
    lines.push(`${path}: FAILED at feature ${r.error.feature} (line ${r.error.line}): ${r.error.message}`);
    lines.push("The view shows the part as it was before that feature.");
  } else lines.push(`${path}: FAILED${r.error?.line ? ` at line ${r.error.line}` : ""}: ${r.error?.message}`);
  const s = r.summary;
  if (s) {
    const [x0, y0, z0, x1, y1, z1] = s.bbox;
    lines.push(`${s.type}: ${s.volume != null ? `volume ${fmt(s.volume)} mm³, ` : ""}${s.faces} faces, ${s.edges} edges; ` +
      `size ${fmt(x1 - x0)} × ${fmt(y1 - y0)} × ${fmt(z1 - z0)} mm (X ${fmt(x0)}…${fmt(x1)}, Y ${fmt(y0)}…${fmt(y1)}, Z ${fmt(z0)}…${fmt(z1)})`);
  }
  const feats = r.timeline?.features ?? [];
  if (feats.length) {
    lines.push(`Timeline${r.timeline?.part ? ` of '${r.timeline.part}'` : ""}:`);
    for (const f of feats) {
      const notes = [f.name && `as ${f.name}`, f.refs.length && `uses ${f.refs.join(", ")}`,
        f.pending?.length && `uses pending sketch ${f.pending.join(", ")}`, f.sketch && sketchStatus(f.sketch)].filter(Boolean).join("; ");
      lines.push(`  ${f.index}  L${f.line}${f.end > f.line ? `-${f.end}` : ""}  ${f.status.padEnd(11)} ${f.kind.padEnd(9)} ${f.label}${notes ? `  (${notes})` : ""}`);
    }
  }
  return lines.join("\n");
}

/** A constrained sketch's state, for the timeline and the agent. */
export function sketchStatus(s: NonNullable<Feature["sketch"]>): string {
  const dof = s.dof === undefined ? "" : s.dof === 0 ? "fully constrained" : `${s.dof} degree${s.dof === 1 ? "" : "s"} of freedom left`;
  return [dof, s.message].filter(Boolean).join(". ");
}

export function makeTools(app: App): Record<string, ToolHandler> {
  const needProject = () => {
    const p = app.project();
    if (!p) throw new Error("No project is open in CAAD. Ask the user to open a folder (or the examples).");
    return p;
  };
  const needKernel = async () => {
    if (!(await app.kernel.whenReady(KERNEL_WAIT_MS))) throw new Error("The CAD kernel is still loading in the browser. Try again in a moment.");
  };
  const needPart = () => {
    if (!app.path() || !app.result()) throw new Error("No part is open. Use open_part, or ask the user to pick one.");
  };
  let guide: string | null = null;

  return {
    async get_status() {
      const p = app.project();
      const parts = p ? await p.list() : [];
      return text([
        `CAAD page: ${location.origin}`,
        `Project: ${p ? `${p.name}${p.writable ? "" : " (examples: read-only, edits stay in the browser)"}, ${parts.length} part file(s)` : "none open"}`,
        `Open part: ${app.path() ?? "none"}`,
        `CAD kernel: ${app.kernel.ready ? "ready" : "loading (takes about a minute after the page opens)"}`,
        `Selection: ${app.selection().flatMap((s) => s.items).length} item(s)`,
      ].join("\n"));
    },

    async build123d_guide({ topic }: { topic?: string }) {
      guide ??= await (await fetch("/agent/guide.md")).text();
      const sections = guide.split(/\n(?=## )/);
      const toc = sections.slice(1).map((s) => "- " + s.split("\n")[0].slice(3)).join("\n");
      if (!topic) return text(`${sections[0].trim()}\n\nSections (call again with topic, or 'all'):\n${toc}`);
      if (topic.toLowerCase() === "all") return text(guide);
      const hit = sections.find((s) => s.split("\n")[0].toLowerCase().includes(topic.toLowerCase()));
      return hit ? text(hit) : text(`No section '${topic}'. Sections:\n${toc}`, true);
    },

    async api_help({ name }: { name: string }) {
      await needKernel();
      return text((await app.kernel.apiHelp(name)).value);
    },

    async run_snippet({ code }: { code: string }) {
      await needKernel();
      const r = await app.kernel.snippet(code);
      const parts = [];
      if (r.output) parts.push(`Output:\n${r.output}`);
      if (r.value != null) parts.push(`Value:\n${typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 1)}`);
      if (r.error) parts.push(`Error: ${r.error}`);
      return text(parts.join("\n\n") || "(no output)", !!r.error);
    },

    async list_parts() {
      const parts = await needProject().list();
      return text(parts.length ? parts.join("\n") : "No build123d part files in this project yet. Create one with write_part.");
    },

    async read_part({ path }: { path: string }) {
      const src = await needProject().read(path);
      const width = String(src.split("\n").length).length;
      return text(src.split("\n").map((l, i) => `${String(i + 1).padStart(width)} | ${l}`).join("\n"));
    },

    async write_part({ path, code }: { path: string; code: string }) {
      needProject();
      if (!path.endsWith(".py")) throw new Error("Part files are Python files: the path must end in .py");
      await needKernel();
      return text(describeBuild(path, await app.applyCode(path, code)));
    },

    async edit_part({ path, old_text, new_text }: { path: string; old_text: string; new_text: string }) {
      const src = await needProject().read(path);
      const count = src.split(old_text).length - 1;
      if (count !== 1) throw new Error(count ? `old_text occurs ${count} times in ${path}; include more context so it is unique.` : `old_text was not found in ${path}. Use read_part to see the current code.`);
      await needKernel();
      return text(describeBuild(path, await app.applyCode(path, src.replace(old_text, () => new_text))));
    },

    async open_part({ path, rollback }: { path: string; rollback?: number }) {
      needProject();
      await needKernel();
      return text(describeBuild(path, await app.openPart(path, rollback ?? null)));
    },

    async get_timeline() {
      needPart();
      return text(describeBuild(app.path()!, app.result()));
    },

    async get_selection() {
      needPart();
      const infos = app.selection();
      if (!infos.length) return text("Nothing is selected. Ask the user to click faces or edges in the view (Shift-click for more).");
      const out = [`In ${app.path()}:`];
      for (const info of infos) {
        for (const it of info.items) {
          const { kind, index, ...props } = it;
          void index;
          out.push(`- ${kind}: ${JSON.stringify(props)}`);
        }
        out.push(`  Selectors (verified against the model; best first${info.selectors.some((s) => s.fragile) ? "; 'position-based' may pick other geometry after edits" : ""}):`);
        for (const s of info.selectors) out.push(`    ${s.expr}${s.fragile ? "   # position-based" : ""}`);
      }
      return text(out.join("\n"));
    },

    async highlight({ selector, note }: { selector: string; note?: string }) {
      needPart();
      if (!selector.trim()) { app.viewer.highlight([]); app.note(null); return text("Highlight cleared."); }
      await needKernel();
      const r = await app.kernel.highlightIndices(selector);
      if (r.error) throw new Error(r.error);
      const picks: Pick[] = [
        ...(r.faces ?? []).map((index) => ({ kind: "face" as const, index, type: "", point: [0, 0, 0] as [number, number, number] })),
        ...(r.edges ?? []).map((index) => ({ kind: "edge" as const, index, type: "", point: [0, 0, 0] as [number, number, number] })),
      ];
      app.viewer.highlight(picks);
      app.note(note ?? null);
      const n = (k: number, w: string) => (k ? `${k} ${w}${k > 1 ? "s" : ""}` : "");
      const what = [n(r.faces?.length ?? 0, "face"), n(r.edges?.length ?? 0, "edge")].filter(Boolean).join(" and ");
      return text(what ? `Highlighted ${what} in blue for the user.` : "The selector matched nothing in the shown part.", !what);
    },

    async render({ view = "current", width = 800, height = 600 }: { view?: string; width?: number; height?: number }): Promise<ToolResult> {
      needPart();
      const w = Math.min(Math.max(width, 64), 2000), h = Math.min(Math.max(height, 64), 2000);
      return { content: [
        { type: "image", data: app.viewer.renderImage(view, w, h), mimeType: "image/png" },
        { type: "text", text: `${app.path()}, view: ${view}${app.result()?.upto != null && app.result()!.upto! < (app.result()!.timeline?.features.length ?? 0) - 1 ? ` (rolled back to feature ${app.result()!.upto})` : ""}` },
      ] };
    },
  };
}
