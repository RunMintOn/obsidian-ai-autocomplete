import { ItemView, WorkspaceLeaf } from "obsidian";
import type { ModelOption, ReasoningEffort } from "./ai-client";
import { tr } from "./i18n";
import type { UiLanguage } from "./settings";

export const VIEW_TYPE_AI_DISCUSSION = "ai-autocomplete-discussion";

export interface DiscussionTurnView {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
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
  streamingThinking?: string;
  language?: UiLanguage;
  providerId?: string;
  providerName?: string;
  modelId?: string;
  modelOptions?: readonly ModelOption[];
  reasoning?: ReasoningEffort;
  reasoningHint?: string;
  tokenBudget?: number;
}

export interface DiscussionSidebarHost {
  getDiscussionSnapshot(): DiscussionSnapshot;
  sendDiscussion(question: string): Promise<void>;
  cancelDiscussion(): void;
  newDiscussion(): void;
  clearDiscussionReference(): void;
  captureCurrentSelection(): boolean;
  setDiscussionModel?(modelId: string): Promise<void>;
  setDiscussionReasoning?(value: ReasoningEffort): Promise<void>;
  setDiscussionTokenBudget?(value: number): Promise<void>;
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
  private modelControlEl: HTMLSelectElement | HTMLInputElement | null = null;
  private reasoningEl: HTMLSelectElement | null = null;
  private tokenEl: HTMLInputElement | null = null;
  private reasoningHintEl: HTMLElement | null = null;
  private newButtonEl: HTMLButtonElement | null = null;
  private captureButtonEl: HTMLButtonElement | null = null;
  private clearButtonEl: HTMLButtonElement | null = null;
  private hintEl: HTMLElement | null = null;
  private busy = false;

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
    this.modelControlEl = null;
    this.reasoningEl = null;
    this.tokenEl = null;
    this.reasoningHintEl = null;
    this.newButtonEl = null;
    this.captureButtonEl = null;
    this.clearButtonEl = null;
    this.hintEl = null;
  }

  refresh(): void {
    if (!this.rootEl) return;
    const snapshot = this.host.getDiscussionSnapshot();
    const language = snapshot.language ?? "zh";

    if (this.noteEl) {
      this.noteEl.textContent =
        snapshot.notePath ?? tr(language, "未绑定笔记", "No active note");
    }

    if (this.newButtonEl) {
      this.newButtonEl.textContent = tr(language, "新对话", "New");
      this.newButtonEl.setAttribute(
        "aria-label",
        tr(language, "开始新对话", "New discussion")
      );
    }
    if (this.captureButtonEl) {
      this.captureButtonEl.textContent = tr(language, "使用选文", "Use selection");
    }
    if (this.clearButtonEl) {
      this.clearButtonEl.textContent = tr(language, "清除", "Clear");
    }

    if (this.referenceWrapEl && this.referenceEl) {
      const hasReference = Boolean(snapshot.reference.trim());
      this.referenceWrapEl.toggleClass("is-empty", !hasReference);
      this.referenceEl.textContent = hasReference
        ? snapshot.reference
        : tr(
            language,
            "在编辑器中选中文字后执行“在侧栏讨论选文”，或者点击上方“使用选文”。",
            "Select text in the editor and run “Discuss selection”, or use the button above."
          );
    }

    this.renderMessages(snapshot, language);
    this.renderStatus(snapshot, language);
    this.renderControls(snapshot, language);

    this.busy =
      snapshot.status === "thinking" || snapshot.status === "generating";
    if (this.sendButtonEl) {
      this.sendButtonEl.textContent = this.busy
        ? tr(language, "停止", "Stop")
        : tr(language, "发送", "Send");
      this.sendButtonEl.toggleClass("mod-cta", !this.busy);
      this.sendButtonEl.toggleClass("mod-warning", this.busy);
    }
    if (this.inputEl) {
      this.inputEl.placeholder = tr(
        language,
        "针对选文或当前讨论继续提问…",
        "Ask about the selection or continue the discussion…"
      );
    }
    if (this.hintEl) {
      this.hintEl.textContent = tr(
        language,
        "Enter 发送 · Shift+Enter 换行",
        "Enter to send · Shift+Enter for newline"
      );
    }
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

    this.newButtonEl = header.createEl("button", {
      cls: "ai-autocomplete-sidebar-icon-button",
      text: "New",
    });
    this.newButtonEl.addEventListener("click", () => {
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
    this.captureButtonEl = referenceActions.createEl("button", {
      text: "Use selection",
    });
    this.captureButtonEl.addEventListener("click", () => {
      if (this.host.captureCurrentSelection()) {
        this.refresh();
        this.focusInput();
      }
    });

    this.clearButtonEl = referenceActions.createEl("button", { text: "Clear" });
    this.clearButtonEl.addEventListener("click", () => {
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

    const controls = composer.createDiv({
      cls: "ai-autocomplete-chat-controls",
    });
    const modelSlot = controls.createDiv({ cls: "ai-autocomplete-control-model" });
    this.modelControlEl = modelSlot.createEl("select");
    this.reasoningEl = controls.createEl("select", {
      cls: "ai-autocomplete-control-reasoning",
    });
    this.tokenEl = controls.createEl("input", {
      cls: "ai-autocomplete-control-tokens",
      attr: {
        type: "number",
        min: "16",
        max: "65536",
        step: "16",
      },
    });

    this.reasoningHintEl = composer.createDiv({
      cls: "ai-autocomplete-reasoning-hint",
    });

    this.inputEl = composer.createEl("textarea", {
      cls: "ai-autocomplete-chat-input",
      attr: { rows: "4" },
    });

    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!this.busy) void this.submit();
      }
    });

    const composerFooter = composer.createDiv({
      cls: "ai-autocomplete-chat-composer-footer",
    });
    this.hintEl = composerFooter.createSpan({
      cls: "ai-autocomplete-chat-hint",
    });
    this.sendButtonEl = composerFooter.createEl("button", {
      cls: "mod-cta",
      text: "Send",
    });
    this.sendButtonEl.addEventListener("click", () => {
      if (this.busy) this.host.cancelDiscussion();
      else void this.submit();
    });
  }

  private renderControls(
    snapshot: DiscussionSnapshot,
    language: UiLanguage
  ): void {
    const modelOptions = snapshot.modelOptions ?? [];
    const modelId = snapshot.modelId ?? "";
    const providerId = snapshot.providerId ?? "";

    const slot = this.modelControlEl?.parentElement;
    if (slot && this.modelControlEl) {
      const shouldUseText = providerId === "custom" || modelOptions.length === 0;
      const isText = this.modelControlEl instanceof HTMLInputElement;
      if (shouldUseText !== isText) {
        this.modelControlEl.remove();
        this.modelControlEl = shouldUseText
          ? slot.createEl("input", {
              cls: "ai-autocomplete-control-model-input",
              attr: { type: "text" },
            })
          : slot.createEl("select");
      }

      if (this.modelControlEl instanceof HTMLSelectElement) {
        this.modelControlEl.empty();
        for (const model of modelOptions) {
          this.modelControlEl.createEl("option", {
            value: model.id,
            text: model.name,
          });
        }
        if (modelId && !modelOptions.some((model) => model.id === modelId)) {
          this.modelControlEl.createEl("option", {
            value: modelId,
            text: `${modelId} *`,
          });
        }
        this.modelControlEl.value = modelId;
        this.modelControlEl.disabled = this.busy;
        this.modelControlEl.onchange = () => {
          const value = (this.modelControlEl as HTMLSelectElement).value;
          if (value && this.host.setDiscussionModel) {
            void this.host.setDiscussionModel(value);
          }
        };
      } else {
        this.modelControlEl.value = modelId;
        this.modelControlEl.placeholder = tr(language, "讨论模型", "Discussion model");
        this.modelControlEl.disabled = this.busy;
        this.modelControlEl.onchange = () => {
          const value = (this.modelControlEl as HTMLInputElement).value.trim();
          if (value && this.host.setDiscussionModel) {
            void this.host.setDiscussionModel(value);
          }
        };
      }
      this.modelControlEl.title = `${snapshot.providerName ?? providerId} · ${tr(
        language,
        "讨论模型",
        "Discussion model"
      )}`;
    }

    if (this.reasoningEl) {
      const reasoning = snapshot.reasoning ?? "";
      this.reasoningEl.empty();
      const options: Array<[ReasoningEffort, string]> = [
        ["", tr(language, "思考：Provider 默认", "Reasoning: Provider default")],
        ["minimal", tr(language, "思考：Minimal", "Reasoning: Minimal")],
        ["low", tr(language, "思考：Low", "Reasoning: Low")],
        ["medium", tr(language, "思考：Medium", "Reasoning: Medium")],
        ["high", tr(language, "思考：High", "Reasoning: High")],
      ];
      for (const [value, label] of options) {
        this.reasoningEl.createEl("option", { value, text: label });
      }
      this.reasoningEl.value = reasoning;
      this.reasoningEl.disabled = this.busy;
      this.reasoningEl.onchange = () => {
        const value = this.reasoningEl?.value as ReasoningEffort;
        if (this.host.setDiscussionReasoning) {
          void this.host.setDiscussionReasoning(value);
        }
      };
    }

    if (this.tokenEl) {
      this.tokenEl.value = String(snapshot.tokenBudget ?? 4096);
      this.tokenEl.title = tr(language, "最大输出 Token", "Maximum output tokens");
      this.tokenEl.disabled = this.busy;
      this.tokenEl.onchange = () => {
        const value = Number(this.tokenEl?.value);
        if (Number.isFinite(value) && this.host.setDiscussionTokenBudget) {
          void this.host.setDiscussionTokenBudget(
            Math.min(65536, Math.max(16, Math.round(value)))
          );
        }
      };
    }

    if (this.reasoningHintEl) {
      this.reasoningHintEl.textContent = snapshot.reasoningHint ?? "";
    }
  }

  private renderMessages(
    snapshot: DiscussionSnapshot,
    language: UiLanguage
  ): void {
    if (!this.messagesEl) return;
    const wasNearBottom =
      this.messagesEl.scrollHeight -
        this.messagesEl.scrollTop -
        this.messagesEl.clientHeight <
      80;

    this.messagesEl.empty();

    if (
      snapshot.turns.length === 0 &&
      !snapshot.streamingText &&
      !snapshot.streamingThinking
    ) {
      this.messagesEl.createDiv({
        cls: "ai-autocomplete-chat-empty",
        text: tr(
          language,
          "选中一段文字作为参考，然后在这里提问。讨论有独立上下文，不会污染行内自动补全。",
          "Pin a passage and ask here. Discussion keeps separate context and never affects inline autocomplete."
        ),
      });
    }

    for (const turn of snapshot.turns) {
      if (turn.role === "user") {
        this.createUserMessage(turn.content, language);
      } else {
        this.createAssistantMessage(
          turn.content,
          turn.thinking ?? "",
          language,
          false
        );
      }
    }

    if (snapshot.streamingText || snapshot.streamingThinking) {
      this.createAssistantMessage(
        snapshot.streamingText,
        snapshot.streamingThinking ?? "",
        language,
        true
      );
    }

    if (wasNearBottom || snapshot.streamingText || snapshot.streamingThinking) {
      requestAnimationFrame(() => {
        if (this.messagesEl) {
          this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        }
      });
    }
  }

  private createUserMessage(content: string, language: UiLanguage): void {
    if (!this.messagesEl) return;
    const message = this.messagesEl.createDiv({
      cls: "ai-autocomplete-chat-message is-user",
    });
    message.createDiv({
      cls: "ai-autocomplete-chat-role",
      text: tr(language, "你", "You"),
    });
    message.createDiv({
      cls: "ai-autocomplete-chat-content",
      text: content,
    });
  }

  private createAssistantMessage(
    content: string,
    thinking: string,
    language: UiLanguage,
    streaming: boolean
  ): void {
    if (!this.messagesEl) return;
    const message = this.messagesEl.createDiv({
      cls: `ai-autocomplete-chat-message is-assistant${
        streaming ? " is-streaming" : ""
      }`,
    });
    message.createDiv({
      cls: "ai-autocomplete-chat-role",
      text: "AI",
    });

    if (thinking) {
      const details = message.createEl("details", {
        cls: "ai-autocomplete-thinking",
      });
      details.open = streaming && !content;
      details.createEl("summary", {
        text: tr(language, "思考过程", "Thinking"),
      });
      details.createDiv({
        cls: "ai-autocomplete-thinking-content",
        text: thinking,
      });
    }

    if (content) {
      message.createDiv({
        cls: "ai-autocomplete-chat-content",
        text: content,
      });
    } else if (streaming) {
      message.createDiv({
        cls: "ai-autocomplete-chat-content is-placeholder",
        text: tr(language, "等待回答…", "Waiting for answer…"),
      });
    }
  }

  private renderStatus(
    snapshot: DiscussionSnapshot,
    language: UiLanguage
  ): void {
    if (!this.statusEl) return;
    this.statusEl.empty();
    this.statusEl.toggleClass("is-visible", snapshot.status !== "idle");

    if (snapshot.status === "thinking") {
      this.statusEl.createSpan({ text: tr(language, "思考中…", "Thinking…") });
    } else if (snapshot.status === "generating") {
      this.statusEl.createSpan({ text: tr(language, "生成中…", "Generating…") });
    } else if (snapshot.status === "error") {
      this.statusEl.createSpan({
        cls: "ai-autocomplete-chat-error",
        text: snapshot.error || tr(language, "请求失败", "Request failed"),
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
