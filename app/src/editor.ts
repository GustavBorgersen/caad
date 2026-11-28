// Code panel: CodeMirror with Python highlighting, line marks for the error and the hovered feature.
import { basicSetup } from "codemirror";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

type Marks = { error: number | null; feature: [number, number] | null; agent: [number, number][] };

// Code colours from the theme's tokens (docs/10-visual-system.md), so light and dark both pass contrast.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--code-keyword)" },
  { tag: [t.number, t.bool, t.null], color: "var(--code-number)" },
  { tag: [t.string, t.special(t.string)], color: "var(--code-string)" },
  { tag: t.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.definition(t.variableName), t.function(t.definition(t.variableName))], color: "var(--accent-text)", fontWeight: "600" },
]);
const setMarks = StateEffect.define<Marks>();

const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      const doc = tr.state.doc;
      const ranges: Range<Decoration>[] = [];
      for (const [a, b] of e.value.agent) {
        for (let l = a; l <= Math.min(b, doc.lines); l++) ranges.push(Decoration.line({ class: "cm-agent-line" }).range(doc.line(l).from));
      }
      if (e.value.feature) {
        const [a, b] = e.value.feature;
        for (let l = a; l <= Math.min(b, doc.lines); l++) ranges.push(Decoration.line({ class: "cm-feature-line" }).range(doc.line(l).from));
      }
      if (e.value.error && e.value.error <= doc.lines) ranges.push(Decoration.line({ class: "cm-error-line" }).range(doc.line(e.value.error).from));
      deco = Decoration.set(ranges, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export class Editor {
  view: EditorView;
  private silent = false;
  private marks: Marks = { error: null, feature: null, agent: [] };
  onChange: (text: string) => void = () => {};

  constructor(el: HTMLElement) {
    this.view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: "",
        extensions: [
          basicSetup,
          python(),
          syntaxHighlighting(highlight),
          marksField,
          EditorView.updateListener.of((u) => { if (u.docChanged && !this.silent) this.onChange(u.state.doc.toString()); }),
        ],
      }),
    });
  }

  get text() { return this.view.state.doc.toString(); }

  /** Replace the whole text (file opened or changed outside) without firing onChange. */
  setText(text: string) {
    if (typeof text !== "string") throw new TypeError(`The editor's text must be a string, not ${typeof text}`); // CodeMirror would hang
    if (text === this.text) return;
    this.silent = true;
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
    this.silent = false;
  }

  /** The lines of the features the agent changed (until the next change). */
  markAgent(ranges: [number, number][]) { this.marks = { ...this.marks, agent: ranges }; this.apply(); }
  markError(line: number | null) { this.marks = { ...this.marks, error: line }; this.apply(); }
  markFeature(range: [number, number] | null, scroll = false) {
    this.marks = { ...this.marks, feature: range };
    this.apply();
    if (range && scroll && range[0] <= this.view.state.doc.lines) {
      this.view.dispatch({ effects: EditorView.scrollIntoView(this.view.state.doc.line(range[0]).from, { y: "center" }) });
    }
  }

  private apply() { this.view.dispatch({ effects: setMarks.of(this.marks) }); }
}
