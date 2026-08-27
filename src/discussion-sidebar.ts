import { ItemView, WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_AI_DISCUSSION = "ai-autocomplete-discussion";

export interface DiscussionTurnView {
  role: "user" | "assistant";
  content: string;
}

export type DiscussionRunStatus =
  | "idle"
  | "thinking"
  | "generating"
  | "error";

export interface DiscussionSnapshot {
  notePath: string | null;
  reference: string;
  turns: readonly DiscussionTurnView[];
  status: DiscussionRunStatus;
  streamingText: string;
  error: string;
}

export interface DiscussionSidebarHost {
  getDiscussionSnapshot(): DiscussionSnapshot;
  sendDiscussion(question: string): Promise<void>;
  newDiscussion(): void;
  clearDiscussionReference(): void;
  captureCurrentSelection(): boolean;
}

export class DiscussionSidebarView extends ItemView {
  private rootEl: HTMLElement | null = null;
  private noteEl: HTMLElement | null = null;
  private referenceWrapEl: HTMLElement | null = null;
  private referenceEl: HTMLElement | null = null;
  private messagesEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendButtonEl: HTMLButtonElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: DiscussionSidebarHost
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_AI_DISCUSSION;
  }

  getDisplayText(): string {
    return "AI Discussion";
  }

  getIcon(): string {
    return "messages-square";
  }

  async onOpen(): Promise<void> {
    this.build();
    this.refresh();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
    this.rootEl = null;
    this.noteEl = null;
    this.referenceWrapEl = null;
    this.referenceEl = null;
    this.messagesEl = null;
    this.statusEl = null;
    this.inputEl = null;
    this.sendButtonEl = null;
  }

  refresh(): void {
    if (!this.rootEl) return;
    const snapshot = this.host.getDiscussionSnapshot();

    if (this.noteEl) {
      this.noteEl.textContent = snapshot.notePath ?? "No active note";
    }

    if (this.referenceWrapEl && this.referenceEl) {
      const hasReference = Boolean(snapshot.reference.trim());
      this.referenceWrapEl.toggleClass("is-empty", !hasReference);
      this.referenceEl.textContent = hasReference
        ? snapshot.reference
        : "Select text in the editor and run “Discuss selection”, or use the button above.";
    }

    this.renderMessages(snapshot);
    this.renderStatus(snapshot);

    const busy =
      snapshot.status === "thinking" || snapshot.status === "generating";
    if (this.sendButtonEl) this.sendButtonEl.disabled = busy;
  }

  focusInput(): void {
    this.inputEl?.focus();
  }

  private build(): void {
    this.contentEl.empty();
    this.rootEl = this.contentEl.createDiv({
      cls: "ai-autocomplete-sidebar",
    });

    const header = this.rootEl.createDiv({
      cls: "ai-autocomplete-sidebar-header",
    });
    const headerText = header.createDiv();
    headerText.createDiv({
      cls: "ai-autocomplete-sidebar-title",
      text: "AI Discussion",
    });
    this.noteEl = headerText.createDiv({
      cls: "ai-autocomplete-sidebar-note",
    });

    const newButton = header.createEl("button", {
      cls: "clickable-icon ai-autocomplete-sidebar-icon-button",
      attr: { "aria-label": "New discussion" },
      text: "New",
    });
    newButton.addEventListener("click", () => {
      this.host.newDiscussion();
      this.refresh();
      this.focusInput();
    });

    const referenceSection = this.rootEl.createDiv({
      cls: "ai-autocomplete-reference-section",
    });
    const referenceHeader = referenceSection.createDiv({
      cls: "ai-autocomplete-reference-header",
    });
    referenceHeader.createSpan({ text: "Reference" });

    const referenceActions = referenceHeader.createDiv({
      cls: "ai-autocomplete-reference-actions",
    });
    const captureButton = referenceActions.createEl("button", {
      text: "Use selection",
    });
    captureButton.addEventListener("click", () => {
      if (this.host.captureCurrentSelection()) {
        this.refresh();
        this.focusInput();
      }
    });

    const clearButton = referenceActions.createEl("button", { text: "Clear" });
    clearButton.addEventListener("click", () => {
      this.host.clearDiscussionReference();
      this.refresh();
    });

    this.referenceWrapEl = referenceSection.createDiv({
      cls: "ai-autocomplete-reference-card",
    });
    this.referenceEl = this.referenceWrapEl.createDiv({
      cls: "ai-autocomplete-reference-text",
    });

    this.messagesEl = this.rootEl.createDiv({
      cls: "ai-autocomplete-chat-messages",
    });

    this.statusEl = this.rootEl.createDiv({
      cls: "ai-autocomplete-chat-status",
    });

    const composer = this.rootEl.createDiv({
      cls: "ai-autocomplete-chat-composer",
    });
    this.inputEl = composer.createEl("textarea", {
      cls: "ai-autocomplete-chat-input",
      attr: {
        placeholder: "Ask about the selected passage…",
        rows: "4",
      },
    });

    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.submit();
      }
    });

    const composerFooter = composer.createDiv({
      cls: "ai-autocomplete-chat-composer-footer",
    });
    composerFooter.createSpan({
      cls: "ai-autocomplete-chat-hint",
      text: "Enter to send · Shift+Enter for newline",
    });
    this.sendButtonEl = composerFooter.createEl("button", {
      cls: "mod-cta",
      text: "Send",
    });
    this.sendButtonEl.addEventListener("click", () => void this.submit());
  }

  private renderMessages(snapshot: DiscussionSnapshot): void {
    if (!this.messagesEl) return;
    const wasNearBottom =
      this.messagesEl.scrollHeight -
        this.messagesEl.scrollTop -
        this.messagesEl.clientHeight <
      80;

    this.messagesEl.empty();

    if (snapshot.turns.length === 0 && !snapshot.streamingText) {
      this.messagesEl.createDiv({
        cls: "ai-autocomplete-chat-empty",
        text: "Ask a question about the pinned selection. This discussion keeps its own short context and never affects inline autocomplete.",
      });
    }

    for (const turn of snapshot.turns) {
      this.createMessage(turn.role, turn.content);
    }

    if (snapshot.streamingText) {
      this.createMessage("assistant", snapshot.streamingText, true);
    }

    if (wasNearBottom || snapshot.streamingText) {
      requestAnimationFrame(() => {
        if (this.messagesEl) {
          this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        }
      });
    }
  }

  private createMessage(
    role: "user" | "assistant",
    content: string,
    streaming = false
  ): void {
    if (!this.messagesEl) return;
    const message = this.messagesEl.createDiv({
      cls: `ai-autocomplete-chat-message is-${role}${
        streaming ? " is-streaming" : ""
      }`,
    });
    message.createDiv({
      cls: "ai-autocomplete-chat-role",
      text: role === "user" ? "You" : "AI",
    });
    message.createDiv({
      cls: "ai-autocomplete-chat-content",
      text: content,
    });
  }

  private renderStatus(snapshot: DiscussionSnapshot): void {
    if (!this.statusEl) return;
    this.statusEl.empty();
    this.statusEl.toggleClass("is-visible", snapshot.status !== "idle");

    if (snapshot.status === "thinking") {
      this.statusEl.createSpan({ text: "Thinking…" });
    } else if (snapshot.status === "generating") {
      this.statusEl.createSpan({ text: "Generating…" });
    } else if (snapshot.status === "error") {
      this.statusEl.createSpan({
        cls: "ai-autocomplete-chat-error",
        text: snapshot.error || "Request failed",
      });
    }
  }

  private async submit(): Promise<void> {
    const input = this.inputEl;
    if (!input) return;
    const question = input.value.trim();
    if (!question) return;

    input.value = "";
    await this.host.sendDiscussion(question);
    this.refresh();
    this.focusInput();
  }
}
