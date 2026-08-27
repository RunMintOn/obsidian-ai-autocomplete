import {
  Decoration,
  EditorView,
  keymap,
  WidgetType,
} from "@codemirror/view";
import { Prec, StateEffect, StateField } from "@codemirror/state";

export type DiscussionStatus = "loading" | "streaming" | "done" | "error";

export interface DiscussionAnswer {
  from: number;
  text: string;
  status: DiscussionStatus;
}

const setDiscussionAnswerEffect = StateEffect.define<DiscussionAnswer | null>();

export const DiscussionAnswerState = StateField.define<DiscussionAnswer | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiscussionAnswerEffect)) return effect.value;
    }

    if (!value) return null;

    // Discussion answers are deliberately persistent UI. Cursor/selection moves
    // must not dismiss them. When the note changes, remap the anchor so the
    // answer stays attached to the same logical area of the document.
    if (tr.docChanged) {
      return {
        ...value,
        from: tr.changes.mapPos(value.from, 1),
      };
    }

    return value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (answer) => {
      if (!answer) return Decoration.none;
      return Decoration.set([
        Decoration.widget({
          widget: new DiscussionWidget(answer.text, answer.status),
          side: 1,
          block: true,
        }).range(answer.from),
      ]);
    }),
});

class DiscussionWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly status: DiscussionStatus
  ) {
    super();
  }

  eq(other: DiscussionWidget): boolean {
    return other.text === this.text && other.status === this.status;
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = `ai-autocomplete-discussion-ghost is-${this.status}`;

    const label = document.createElement("div");
    label.className = "ai-autocomplete-discussion-label";

    const title = document.createElement("span");
    title.textContent = "AI";
    label.appendChild(title);

    if (this.status !== "done") {
      const status = document.createElement("span");
      status.className = "ai-autocomplete-discussion-status";
      status.textContent =
        this.status === "loading"
          ? "Thinking…"
          : this.status === "streaming"
            ? "Generating…"
            : "Failed";
      label.appendChild(status);
    }

    const body = document.createElement("div");
    body.className = "ai-autocomplete-discussion-body";
    if (this.text) {
      body.textContent = this.text;
    } else if (this.status === "loading") {
      body.textContent = "Waiting for the model…";
    } else if (this.status === "streaming") {
      body.textContent = "Receiving answer…";
    }

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

export function showDiscussionLoading(view: EditorView, from: number): void {
  view.dispatch({
    effects: setDiscussionAnswerEffect.of({
      from,
      text: "",
      status: "loading",
    }),
  });
}

export function updateDiscussionAnswer(
  view: EditorView,
  text: string,
  status: DiscussionStatus = "streaming"
): boolean {
  const answer = currentDiscussion(view);
  if (!answer) return false;

  view.dispatch({
    effects: setDiscussionAnswerEffect.of({
      ...answer,
      text,
      status,
    }),
  });
  return true;
}

export function finishDiscussionAnswer(
  view: EditorView,
  text: string
): boolean {
  return updateDiscussionAnswer(view, text, "done");
}

export function showDiscussionError(
  view: EditorView,
  message: string
): boolean {
  return updateDiscussionAnswer(view, message, "error");
}

export function dismissDiscussionAnswer(view: EditorView): boolean {
  if (!currentDiscussion(view)) return false;
  view.dispatch({ effects: setDiscussionAnswerEffect.of(null) });
  return true;
}

export function acceptDiscussionAnswer(view: EditorView): boolean {
  const answer = currentDiscussion(view);
  if (!answer || answer.status !== "done" || !answer.text.trim()) return false;

  const before = view.state.doc.sliceString(
    Math.max(0, answer.from - 1),
    answer.from
  );
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
