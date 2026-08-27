import {
  Decoration,
  EditorView,
  keymap,
  WidgetType,
} from "@codemirror/view";
import { Prec, StateEffect, StateField } from "@codemirror/state";

export interface DiscussionAnswer {
  from: number;
  text: string;
}

const setDiscussionAnswerEffect = StateEffect.define<DiscussionAnswer | null>();

export const DiscussionAnswerState = StateField.define<DiscussionAnswer | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiscussionAnswerEffect)) return effect.value;
    }

    if (!value) return null;

    // A discussion answer is anchored to a concrete document position. Any
    // unrelated edit or cursor move dismisses it rather than trying to remap a
    // potentially stale answer.
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (answer) => {
      if (!answer?.text) return Decoration.none;
      return Decoration.set([
        Decoration.widget({
          widget: new DiscussionWidget(answer.text),
          side: 1,
          block: true,
        }).range(answer.from),
      ]);
    }),
});

class DiscussionWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: DiscussionWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "ai-autocomplete-discussion-ghost";

    const label = document.createElement("div");
    label.className = "ai-autocomplete-discussion-label";
    label.textContent = "AI";

    const body = document.createElement("div");
    body.className = "ai-autocomplete-discussion-body";
    body.textContent = this.text;

    container.append(label, body);
    return container;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function currentDiscussion(view: EditorView): DiscussionAnswer | null {
  return view.state.field(DiscussionAnswerState, false) ?? null;
}

export function showDiscussionAnswer(
  view: EditorView,
  from: number,
  text: string
): void {
  view.dispatch({
    effects: setDiscussionAnswerEffect.of({ from, text }),
  });
}

export function dismissDiscussionAnswer(view: EditorView): boolean {
  if (!currentDiscussion(view)) return false;
  view.dispatch({ effects: setDiscussionAnswerEffect.of(null) });
  return true;
}

export function acceptDiscussionAnswer(view: EditorView): boolean {
  const answer = currentDiscussion(view);
  if (!answer) return false;

  const before = view.state.doc.sliceString(Math.max(0, answer.from - 1), answer.from);
  const prefix = before === "\n" || answer.from === 0 ? "" : "\n";
  const insert = `${prefix}\n${answer.text}`;
  const end = answer.from + insert.length;

  view.dispatch({
    changes: { from: answer.from, insert },
    selection: { anchor: end },
    effects: setDiscussionAnswerEffect.of(null),
    userEvent: "input.complete",
    scrollIntoView: true,
  });
  return true;
}

export const discussionExtension = [
  DiscussionAnswerState,
  Prec.highest(
    keymap.of([
      { key: "Tab", run: acceptDiscussionAnswer },
      { key: "Escape", run: dismissDiscussionAnswer },
    ])
  ),
];
