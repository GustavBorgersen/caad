// Code panel: CodeMirror with Python highlighting, line marks for the error and the hovered feature.
import { basicSetup } from "codemirror";
import { python } from "@codemirror/lang-python";
import { EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

type Marks = { error: number | null; feature: [number, number] | null };
const setMarks = StateEffect.define<Marks>();

const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      const doc = tr.state.doc;
      const ranges: Range<Decoration>[] = [];
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
  private marks: Marks = { error: null, feature: null };
  onChange: (text: string) => void = () => {};

  constructor(el: HTMLElement) {
    this.view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: "",
        extensions: [
          basicSetup,
          python(),
          marksField,
          EditorView.updateListener.of((u) => { if (u.docChanged && !this.silent) this.onChange(u.state.doc.toString()); }),
        ],
      }),
    });
  }

  get text() { return this.view.state.doc.toString(); }

  /** Replace the whole text (file opened or changed outside) without firing onChange. */
  setText(text: string) {
    if (text === this.text) return;
    this.silent = true;
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
    this.silent = false;
  }

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
