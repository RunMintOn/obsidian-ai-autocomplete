import { ItemView, WorkspaceLeaf } from "obsidian";
import type { ModelOption, ReasoningEffort } from "./ai-client.js";
import { tr } from "./i18n.js";
import {
  MAX_TOKEN_BUDGET,
  MIN_TOKEN_BUDGET,
  type UiLanguage,
} from "./settings.js";

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
  private titleEl: HTMLElement | null = null;
  private noteEl: HTMLElement | null = null;
  private referenceLabelEl: HTMLElement | null = null;
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
    const language = this.host.getDiscussionSnapshot().language ?? "zh";
    return tr(language, "AI 讨论", "AI Discussion");
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
    this.clearElementReferences();
  }

  refresh(): void {
    if (!this.rootEl) return;

    const snapshot = this.host.getDiscussionSnapshot();
    const language = snapshot.language ?? "zh";
    this.busy = isBusyStatus(snapshot.status);

    this.renderHeader(snapshot, language);
    this.renderReference(snapshot, language);
    this.renderMessages(snapshot, language);
    this.renderStatus(snapshot, language);
    this.renderControls(snapshot, language);
    this.renderComposerState(language);
  }

  focusInput(): void {
    this.inputEl?.focus();
  }

  private clearElementReferences(): void {
    this.rootEl = null;
    this.titleEl = null;
    this.noteEl = null;
    this.referenceLabelEl = null;
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

  private renderHeader(
    snapshot: DiscussionSnapshot,
    language: UiLanguage
  ): void {
    if (this.titleEl) {
      this.titleEl.textContent = tr(language, "AI 讨论", "AI Discussion");
    }
    if (this.noteEl) {
      this.noteEl.textContent =
        snapshot.notePath ?? tr(language, "未绑定笔记", "No active note");
    }
    if (this.referenceLabelEl) {
      this.referenceLabelEl.textContent = tr(language, "参考选文", "Reference");
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
  }

  private renderReference(
    snapshot: DiscussionSnapshot,
    language: UiLanguage
  ): void {
    if (!this.referenceWrapEl || !this.referenceEl) return;

    const hasReference = Boolean(snapshot.reference.trim());
    this.referenceWrapEl.toggleClass("is-empty", !hasReference);

    if (hasReference) {
      this.referenceEl.textContent = snapshot.reference;
      return;
    }

    this.referenceEl.textContent = tr(
      language,
      "在编辑器中选中文字后执行“在侧栏讨论选文”，或者点击上方“使用选文”。",
      "Select text in the editor and run “Discuss selection”, or use the button above."
    );
  }

  private renderComposerState(language: UiLanguage): void {
    if (this.sendButtonEl) {
      if (this.busy) {
        this.sendButtonEl.textContent = tr(language, "停止", "Stop");
      } else {
        this.sendButtonEl.textContent = tr(language, "发送", "Send");
      }
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

  private build(): void {
    this.contentEl.empty();
    this.rootEl = this.contentEl.createDiv({
      cls: "ai-autocomplete-sidebar",
    });

    const header = this.rootEl.createDiv({
      cls: "ai-autocomplete-sidebar-header",
    });
    const headerText = header.createDiv();
    this.titleEl = headerText.createDiv({
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
    this.referenceLabelEl = referenceHeader.createSpan({ text: "Reference" });

    const referenceActions = referenceHeader.createDiv({
      cls: "ai-autocomplete-reference-actions",
    });
    this.captureButtonEl = referenceActions.createEl("button", {
      text: "Use selection",
    });
    this.captureButtonEl.addEventListener("click", () => {
      if (!this.host.captureCurrentSelection()) return;
      this.refresh();
      this.focusInput();
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
    const modelSlot = controls.createDiv({
      cls: "ai-autocomplete-control-model",
    });

    this.modelControlEl = modelSlot.createEl("select");
    this.reasoningEl = controls.createEl("select", {
      cls: "ai-autocomplete-control-reasoning",
    });
    this.tokenEl = controls.createEl("input", {
      cls: "ai-autocomplete-control-tokens",
      attr: {
        type: "number",
        min: String(MIN_TOKEN_BUDGET),
        max: String(MAX_TOKEN_BUDGET),
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
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;

      event.preventDefault();
      if (!this.busy) void this.submit();
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
      if (this.busy) {
        this.host.cancelDiscussion();
        return;
      }
      void this.submit();
    });
  }

  private renderControls(
    snapshot: DiscussionSnapshot,
    language: UiLanguage
  ): void {
    this.renderModelControl(snapshot, language);
    this.renderReasoningControl(snapshot, language);
    this.renderTokenControl(snapshot, language);

    if (this.reasoningHintEl) {
      this.reasoningHintEl.textContent = snapshot.reasoningHint ?? "";
    }
  }

  private renderModelControl(
    snapshot: DiscussionSnapshot,
    language: UiLanguage
  ): void {
    if (!this.modelControlEl) return;

    const modelOptions = snapshot.modelOptions ?? [];
    const modelId = snapshot.modelId ?? "";
    const providerId = snapshot.providerId ?? "";
    const slot = this.modelControlEl.parentElement;
    if (!slot) return;

    const shouldUseTextInput =
      providerId === "custom" || modelOptions.length === 0;
    const isTextInput = this.modelControlEl instanceof HTMLInputElement;
    if (shouldUseTextInput !== isTextInput) {
      this.modelControlEl.remove();
      this.modelControlEl = createModelControl(slot, shouldUseTextInput);
    }

    if (this.modelControlEl instanceof HTMLSelectElement) {
      this.syncCatalogModelControl(this.modelControlEl, modelOptions, modelId);
    } else {
      this.syncTextModelControl(this.modelControlEl, modelId, language);
    }

    this.modelControlEl.disabled = this.busy;
    this.modelControlEl.title = `${snapshot.providerName ?? providerId} · ${tr(
      language,
      "讨论模型",
      "Discussion model"
    )}`;
  }

  private syncCatalogModelControl(
    control: HTMLSelectElement,
    modelOptions: readonly ModelOption[],
    modelId: string
  ): void {
    control.empty();

    for (const model of modelOptions) {
      control.createEl("option", {
        value: model.id,
        text: model.name,
      });
    }

    const hasCurrentModel = modelOptions.some((model) => model.id === modelId);
    if (modelId && !hasCurrentModel) {
      control.createEl("option", {
        value: modelId,
        text: `${modelId} *`,
      });
    }

    control.value = modelId;
    control.onchange = () => {
      const value = control.value;
      if (value && this.host.setDiscussionModel) {
        void this.host.setDiscussionModel(value);
      }
    };
  }

  private syncTextModelControl(
    control: HTMLInputElement,
    modelId: string,
    language: UiLanguage
  ): void {
    control.value = modelId;
    control.placeholder = tr(language, "讨论模型", "Discussion model");
    control.onchange = () => {
      const value = control.value.trim();
      if (value && this.host.setDiscussionModel) {
        void this.host.setDiscussionModel(value);
      }
    };
  }

  private renderReasoningControl(
    snapshot: DiscussionSnapshot,
    language: UiLanguage
  ): void {
    if (!this.reasoningEl) return;

    const options: Array<[ReasoningEffort, string]> = [
      ["", tr(language, "思考：Provider 默认", "Reasoning: Provider default")],
      ["minimal", tr(language, "思考：Minimal", "Reasoning: Minimal")],
      ["low", tr(language, "思考：Low", "Reasoning: Low")],
      ["medium", tr(language, "思考：Medium", "Reasoning: Medium")],
      ["high", tr(language, "思考：High", "Reasoning: High")],
    ];

    this.reasoningEl.empty();
    for (const [value, label] of options) {
      this.reasoningEl.createEl("option", { value, text: label });
    }

    this.reasoningEl.value = snapshot.reasoning ?? "";
    this.reasoningEl.disabled = this.busy;
    this.reasoningEl.onchange = () => {
      const value = this.reasoningEl?.value as ReasoningEffort;
      if (this.host.setDiscussionReasoning) {
        void this.host.setDiscussionReasoning(value);
      }
    };
  }

  private renderTokenControl(
    snapshot: DiscussionSnapshot,
    language: UiLanguage
  ): void {
    if (!this.tokenEl) return;

    this.tokenEl.value = String(snapshot.tokenBudget ?? 4096);
    this.tokenEl.title = tr(language, "最大输出 Token", "Maximum output tokens");
    this.tokenEl.disabled = this.busy;
    this.tokenEl.onchange = () => {
      const value = Number(this.tokenEl?.value);
      if (!Number.isFinite(value) || !this.host.setDiscussionTokenBudget) return;

      const normalized = Math.min(
        MAX_TOKEN_BUDGET,
        Math.max(MIN_TOKEN_BUDGET, Math.round(value))
      );
      void this.host.setDiscussionTokenBudget(normalized);
    };
  }

  private renderMessages(
    snapshot: DiscussionSnapshot,
    language: UiLanguage
  ): void {
    if (!this.messagesEl) return;

    const messagesEl = this.messagesEl;
    const wasNearBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
    messagesEl.empty();

    if (
      snapshot.turns.length === 0 &&
      !snapshot.streamingText &&
      !snapshot.streamingThinking
    ) {
      messagesEl.createDiv({
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
        continue;
      }
      this.createAssistantMessage(
        turn.content,
        turn.thinking ?? "",
        language,
        false
      );
    }

    if (snapshot.streamingText || snapshot.streamingThinking) {
      this.createAssistantMessage(
        snapshot.streamingText,
        snapshot.streamingThinking ?? "",
        language,
        true
      );
    }

    if (!wasNearBottom && !snapshot.streamingText && !snapshot.streamingThinking) {
      return;
    }

    requestAnimationFrame(function scrollMessagesToBottom(): void {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
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

    let className = "ai-autocomplete-chat-message is-assistant";
    if (streaming) className += " is-streaming";

    const message = this.messagesEl.createDiv({ cls: className });
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
      return;
    }

    if (streaming) {
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
      return;
    }
    if (snapshot.status === "generating") {
      this.statusEl.createSpan({ text: tr(language, "生成中…", "Generating…") });
      return;
    }
    if (snapshot.status === "error") {
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

function isBusyStatus(status: DiscussionRunStatus): boolean {
  return status === "thinking" || status === "generating";
}

function createModelControl(
  slot: HTMLElement,
  useTextInput: boolean
): HTMLSelectElement | HTMLInputElement {
  if (useTextInput) {
    return slot.createEl("input", {
      cls: "ai-autocomplete-control-model-input",
      attr: { type: "text" },
    });
  }
  return slot.createEl("select");
}
