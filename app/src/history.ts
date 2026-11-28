// Undo and redo (docs/09-design-and-workflow.md): code is the source of truth, so the history is each file's text,
// one step per change (a dialog's OK, a sketch, a deleted feature, an agent's edit, a pause in typing).
type Step = { text: string; label: string };

const LIMIT = 200;

export class History {
  private undos = new Map<string, Step[]>();
  private redos = new Map<string, Step[]>();

  /** Record a change of `path` from `before` (the text it had): `label` names the change ("Fillet edited"). */
  record(path: string, before: string, after: string, label: string) {
    if (before === after) return;
    const u = this.undos.get(path) ?? [];
    u.push({ text: before, label });
    if (u.length > LIMIT) u.shift();
    this.undos.set(path, u);
    this.redos.delete(path);
  }

  /** What undo would undo, and redo redo (for tooltips). */
  peek(path: string | null): { undo?: string; redo?: string } {
    if (!path) return {};
    return { undo: this.undos.get(path)?.at(-1)?.label, redo: this.redos.get(path)?.at(-1)?.label };
  }

  /** Step back: the text to restore and the change's label; `current` is the text now (it goes to redo). */
  undo(path: string, current: string): Step | null {
    const step = this.undos.get(path)?.pop();
    if (!step) return null;
    this.redos.set(path, [...(this.redos.get(path) ?? []), { text: current, label: step.label }]);
    return step;
  }

  redo(path: string, current: string): Step | null {
    const step = this.redos.get(path)?.pop();
    if (!step) return null;
    this.undos.set(path, [...(this.undos.get(path) ?? []), { text: current, label: step.label }]);
    return step;
  }

  /** A file renamed or deleted: its history follows it, or goes. */
  move(from: string, to: string | null) {
    for (const m of [this.undos, this.redos]) {
      const v = m.get(from);
      m.delete(from);
      if (v && to) m.set(to, v);
    }
  }

  clear() { this.undos.clear(); this.redos.clear(); }
}
