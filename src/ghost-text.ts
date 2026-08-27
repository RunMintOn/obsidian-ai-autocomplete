import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Text,
} from "@codemirror/state";

export interface InlineSuggestion {
  from: number;
  text: string;
}

interface CompositionSnapshot {
  suggestion: InlineSuggestion;
  before: string;
  after: string;
}

export interface CompletionContext {
  prefix: string;
  suffix: string;
  state: EditorState;
  signal: AbortSignal;
}

export interface InlineSuggestionConfig {
  enabled: boolean;
  delay: number;
  minPrefixChars: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
}

export type FetchFn = (context: CompletionContext) => Promise<string | null>;
export type GetConfig = () => InlineSuggestionConfig;

const setSuggestionEffect = StateEffect.define<InlineSuggestion | null>();

export const InlineSuggestionState = StateField.define<InlineSuggestion | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSuggestionEffect)) return effect.value;
    }

    if (!value) return null;

    let candidate: InlineSuggestion | null = value;

    if (tr.docChanged) {
      let consumed = "";
      let pureInsertionAtAnchor = true;

      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted: Text) => {
        if (!pureInsertionAtAnchor) return;
        if (fromA !== toA || fromA !== value.from) {
          pureInsertionAtAnchor = false;
          return;
        }
        consumed += inserted.toString();
      });

      if (!pureInsertionAtAnchor) return null;

      if (consumed.length > 0) {
        if (!value.text.startsWith(consumed)) return null;
        const remaining = value.text.slice(consumed.length);
        candidate = remaining
          ? { from: value.from + consumed.length, text: remaining }
          : null;
      } else {
        candidate = {
          from: tr.changes.mapPos(value.from, 1),
          text: value.text,
        };
      }
    }

    if (candidate && tr.selection) {
      const selection = tr.selection.main;
      if (!selection.empty || selection.head !== candidate.from) return null;
    }

    return candidate;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (suggestion) => {
      if (!suggestion?.text) return Decoration.none;
      return Decoration.set([
        Decoration.widget({
          widget: new GhostTextWidget(suggestion.text),
          side: 1,
        }).range(suggestion.from),
      ]);
    }),
});

class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: GhostTextWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "ai-autocomplete-ghost-text";
    span.textContent = this.text;
    return span;
  }

  get lineBreaks(): number {
    return this.text.split("\n").length - 1;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function currentSuggestion(view: EditorView): InlineSuggestion | null {
  return view.state.field(InlineSuggestionState, false) ?? null;
}

function setSuggestion(
  view: EditorView,
  suggestion: InlineSuggestion | null
): void {
  view.dispatch({ effects: setSuggestionEffect.of(suggestion) });
}

function insertPortion(
  view: EditorView,
  suggestion: InlineSuggestion,
  take: number
): boolean {
  const part = suggestion.text.slice(0, take);
  if (!part) return false;

  const rest = suggestion.text.slice(take);
  const nextFrom = suggestion.from + part.length;

  view.dispatch({
    changes: { from: suggestion.from, insert: part },
    selection: { anchor: nextFrom },
    effects: setSuggestionEffect.of(
      rest ? { from: nextFrom, text: rest } : null
    ),
    userEvent: "input.complete",
    scrollIntoView: true,
  });
  return true;
}

export function acceptSuggestion(view: EditorView): boolean {
  const suggestion = currentSuggestion(view);
  if (!suggestion) return false;
  return insertPortion(view, suggestion, suggestion.text.length);
}

export function acceptSuggestionSegment(view: EditorView): boolean {
  const suggestion = currentSuggestion(view);
  if (!suggestion) return false;
  return insertPortion(view, suggestion, nextSegmentLength(suggestion.text));
}

export function dismissSuggestion(view: EditorView): boolean {
  if (!currentSuggestion(view)) return false;
  setSuggestion(view, null);
  return true;
}

function nextSegmentLength(text: string): number {
  if (!text) return 0;

  const leadingWhitespace = /^\s*/.exec(text)?.[0].length ?? 0;
  const rest = text.slice(leadingWhitespace);
  if (!rest) return text.length;

  type Segment = { segment: string; isWordLike?: boolean };
  type Segmenter = {
    segment(input: string): Iterable<Segment>;
  };
  type SegmenterConstructor = new (
    locales?: string | string[],
    options?: { granularity: "word" }
  ) => Segmenter;

  const SegmenterCtor = (
    Intl as unknown as { Segmenter?: SegmenterConstructor }
  ).Segmenter;

  if (SegmenterCtor) {
    const segmenter = new SegmenterCtor(undefined, { granularity: "word" });
    const first = segmenter.segment(rest)[Symbol.iterator]().next().value as
      | Segment
      | undefined;
    if (first?.segment) return leadingWhitespace + first.segment.length;
  }

  const fallback = /^\S+/.exec(rest)?.[0] ?? rest[0] ?? "";
  return leadingWhitespace + fallback.length;
}

const managers = new WeakMap<EditorView, SuggestionManager>();
const activeManagers = new Set<SuggestionManager>();

export function clearAllSuggestions(): void {
  for (const manager of activeManagers) manager.clear();
}

export function getSuggestionManager(
  view: EditorView
): SuggestionManager | undefined {
  return managers.get(view);
}

export class SuggestionManager {
  private timer: number | null = null;
  private controller: AbortController | null = null;
  private composing = false;
  private compositionSnapshot: CompositionSnapshot | null = null;
  private compositionFinishTimer: number | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly fetchFn: FetchFn,
    private readonly getConfig: GetConfig
  ) {
    managers.set(view, this);
    activeManagers.add(this);
  }

  update(update: ViewUpdate): void {
    const acceptedCompletion = update.transactions.some((tr) =>
      tr.isUserEvent("input.complete")
    );

    if (acceptedCompletion) {
      this.cancelTimer();
      this.abortRequest();
      return;
    }

    if (this.composing || update.view.composing) {
      this.cancelTimer();
      this.abortRequest();
      return;
    }

    const userEdited = update.transactions.some(
      (tr) => tr.isUserEvent("input") || tr.isUserEvent("delete")
    );

    if (userEdited) {
      this.abortRequest();

      // Matching text was consumed from the existing ghost. Keep it stable
      // rather than replacing it with a new network result on every keypress.
      if (currentSuggestion(this.view)) {
        this.cancelTimer();
        return;
      }

      if (this.getConfig().enabled) this.schedule();
      return;
    }

    if (update.selectionSet && !update.docChanged) {
      this.cancelTimer();
      this.abortRequest();
    }
  }

  onCompositionStart(): void {
    if (this.composing) return;
    this.composing = true;
    this.cancelTimer();
    this.abortRequest();

    const suggestion = currentSuggestion(this.view);
    if (!suggestion) {
      this.compositionSnapshot = null;
      return;
    }

    const doc = this.view.state.doc.toString();
    this.compositionSnapshot = {
      suggestion,
      before: doc.slice(0, suggestion.from),
      after: doc.slice(suggestion.from),
    };

    // Hide the widget while the OS IME owns the composition range. We restore
    // the unconsumed remainder after compositionend when it still matches.
    setSuggestion(this.view, null);
  }

  onCompositionEnd(): void {
    if (this.compositionFinishTimer !== null) {
      window.clearTimeout(this.compositionFinishTimer);
    }

    // Let CodeMirror apply the final composition transaction first.
    this.compositionFinishTimer = window.setTimeout(() => {
      this.compositionFinishTimer = null;
      this.finishComposition();
    }, 0);
  }

  private finishComposition(): void {
    this.composing = false;

    const snapshot = this.compositionSnapshot;
    this.compositionSnapshot = null;

    if (!this.getConfig().enabled) return;

    if (snapshot) {
      const doc = this.view.state.doc.toString();
      const { before, after, suggestion } = snapshot;

      if (
        doc.startsWith(before) &&
        doc.endsWith(after) &&
        doc.length >= before.length + after.length
      ) {
        const inserted = doc.slice(before.length, doc.length - after.length);

        if (suggestion.text.startsWith(inserted)) {
          const remaining = suggestion.text.slice(inserted.length);
          if (remaining) {
            setSuggestion(this.view, {
              from: suggestion.from + inserted.length,
              text: remaining,
            });
            return;
          }
        }
      }
    }

    if (this.getConfig().enabled) this.schedule();
  }

  schedule(): void {
    this.cancelTimer();
    const delay = Math.max(0, this.getConfig().delay);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.request();
    }, delay);
  }

  async request(): Promise<void> {
    const config = this.getConfig();
    if (!config.enabled || this.composing || this.view.composing) return;
    if (currentSuggestion(this.view)) return;

    const selection = this.view.state.selection.main;
    if (!selection.empty) return;

    const cursor = selection.head;
    const doc = this.view.state.doc;
    const prefix = doc.sliceString(
      Math.max(0, cursor - config.maxPrefixChars),
      cursor
    );
    const suffix = doc.sliceString(
      cursor,
      Math.min(doc.length, cursor + config.maxSuffixChars)
    );

    if (prefix.trim().length < config.minPrefixChars) return;

    this.abortRequest();
    const controller = new AbortController();
    this.controller = controller;

    try {
      const result = await this.fetchFn({
        prefix,
        suffix,
        state: this.view.state,
        signal: controller.signal,
      });

      if (controller.signal.aborted || !result || !result.trim()) return;
      if (!this.getConfig().enabled) return;
      if (this.view.state.doc !== doc) return;

      const currentSelection = this.view.state.selection.main;
      if (!currentSelection.empty || currentSelection.head !== cursor) return;
      if (this.composing || this.view.composing) return;

      setSuggestion(this.view, { from: cursor, text: result });
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  clear(): void {
    this.cancelTimer();
    this.abortRequest();
    this.compositionSnapshot = null;
    if (currentSuggestion(this.view)) setSuggestion(this.view, null);
  }

  destroy(): void {
    this.clear();
    if (this.compositionFinishTimer !== null) {
      window.clearTimeout(this.compositionFinishTimer);
      this.compositionFinishTimer = null;
    }
    managers.delete(this.view);
    activeManagers.delete(this);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private abortRequest(): void {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }
}

const ghostTextKeymap = Prec.highest(
  keymap.of([
    { key: "Tab", run: acceptSuggestion },
    { key: "Escape", run: dismissSuggestion },
    { key: "Mod-ArrowRight", run: acceptSuggestionSegment },
  ])
);

const compositionHandlers = EditorView.domEventHandlers({
  compositionstart: (_event, view) => {
    getSuggestionManager(view)?.onCompositionStart();
    return false;
  },
  compositionend: (_event, view) => {
    getSuggestionManager(view)?.onCompositionEnd();
    return false;
  },
});

export function inlineSuggestionExtension(
  fetchFn: FetchFn,
  getConfig: GetConfig
) {
  const triggerPlugin = ViewPlugin.define(
    (view) => new SuggestionManager(view, fetchFn, getConfig)
  );

  return [
    InlineSuggestionState,
    ghostTextKeymap,
    compositionHandlers,
    triggerPlugin,
  ];
}
