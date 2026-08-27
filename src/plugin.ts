import type { EditorView } from "@codemirror/view";
import {
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  WorkspaceLeaf,
} from "obsidian";
import {
  type ChatMessage,
  CompletionError,
  fetchCompletion,
  getProviderModels,
  getProviderOptions,
  type CompletionRequestOptions,
  type ReasoningEffort,
  streamChatCompletion,
} from "./ai-client.js";
import {
  DiscussionSidebarView,
  type DiscussionRunStatus,
  type DiscussionSidebarHost,
  type DiscussionSnapshot,
  VIEW_TYPE_AI_DISCUSSION,
} from "./discussion-sidebar.js";
import {
  acceptSuggestion,
  acceptSuggestionSegment,
  clearAllSuggestions,
  dismissSuggestion,
  getSuggestionManager,
  inlineSuggestionExtension,
  type InlineSuggestionConfig,
} from "./ghost-text.js";
import { tr } from "./i18n.js";
import {
  type AIAutocompleteSettings,
  DEFAULT_SETTINGS,
  getActivePromptTemplate,
  getDiscussionProviderModel,
  getProviderApiKey,
  getProviderModel,
  normalizeLoadedSettings,
  normalizeReasoningEffort,
  normalizeTokenBudget,
  setDiscussionProviderModel,
} from "./settings.js";
import {
  AIAutocompleteSettingTab,
  type SettingsHost,
} from "./settings-tab.js";

interface DiscussionTurn {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
}

interface DiscussionSession {
  reference: string;
  turns: DiscussionTurn[];
  status: DiscussionRunStatus;
  streamingThinking: string;
  streamingText: string;
  error: string;
}

const MAX_DISCUSSION_TURNS = 12;
const ACTIVE_EDITOR_NOTE_KEY = "__active-editor__";

export default class AIAutocompletePlugin
  extends Plugin
  implements DiscussionSidebarHost, SettingsHost
{
  settings: AIAutocompleteSettings = DEFAULT_SETTINGS;

  private lastErrorNoticeAt = 0;
  private readonly discussionSessions = new Map<string, DiscussionSession>();
  private discussionController: AbortController | null = null;
  private discussionRequestNoteKey: string | null = null;
  private discussionNoteKey: string | null = null;
  private lastMarkdownView: MarkdownView | null = null;
  private sidebarRefreshQueued = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    const editorExtensions = inlineSuggestionExtension(
      async ({ prefix, suffix, signal }) => {
        try {
          return await fetchCompletion(
            this.getCompletionOptions(),
            prefix,
            suffix,
            signal
          );
        } catch (error) {
          if (isAbortError(error)) return null;
          this.showCompletionError(error);
          return null;
        }
      },
      () => this.getInlineConfig()
    );

    this.registerEditorExtension(editorExtensions);
    this.registerView(
      VIEW_TYPE_AI_DISCUSSION,
      (leaf) => new DiscussionSidebarView(leaf, this)
    );
    this.addSettingTab(new AIAutocompleteSettingTab(this.app, this));
    this.registerCommands();

    this.addRibbonIcon(
      "messages-square",
      this.l("打开 AI 讨论", "Open AI Discussion"),
      () => void this.activateDiscussionSidebar(true)
    );

    this.lastMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (this.lastMarkdownView?.file?.path) {
      this.discussionNoteKey = this.lastMarkdownView.file.path;
    }

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!(leaf?.view instanceof MarkdownView)) return;

        this.lastMarkdownView = leaf.view;
        if (leaf.view.file?.path) this.discussionNoteKey = leaf.view.file.path;
        this.refreshSidebar();
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file?.path) this.discussionNoteKey = file.path;
        this.refreshSidebar();
      })
    );
  }

  onunload(): void {
    this.discussionController?.abort();
    this.discussionController = null;
    this.discussionRequestNoteKey = null;
    this.discussionSessions.clear();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AI_DISCUSSION);
  }

  private registerCommands(): void {
    this.addCommand({
      id: "trigger",
      name: this.l("手动触发行内补全", "Trigger inline suggestion"),
      editorCallback: (editor) => {
        const view = cmOf(editor);
        if (view) void getSuggestionManager(view)?.request(true);
      },
    });

    this.addCommand({
      id: "accept",
      name: this.l("接受整段行内补全", "Accept inline suggestion"),
      editorCallback: (editor) => withView(editor, acceptSuggestion),
    });

    this.addCommand({
      id: "accept-segment",
      name: this.l("接受下一段补全", "Accept next suggestion segment"),
      editorCallback: (editor) => withView(editor, acceptSuggestionSegment),
    });

    this.addCommand({
      id: "dismiss",
      name: this.l("取消行内补全", "Dismiss inline suggestion"),
      editorCallback: (editor) => withView(editor, dismissSuggestion),
    });

    this.addCommand({
      id: "open-discussion",
      name: this.l("打开 AI 讨论侧栏", "Open AI discussion sidebar"),
      callback: () => void this.activateDiscussionSidebar(true),
    });

    this.addCommand({
      id: "ask-selection",
      name: this.l("在侧栏讨论选文", "Discuss selection in sidebar"),
      editorCallback: (editor, context) => {
        const selection = editor.getSelection().trim();
        if (!selection) {
          new Notice(this.l("请先选中一段文字", "Select a passage first"));
          return;
        }

        if (context instanceof MarkdownView) this.lastMarkdownView = context;
        const path = context.file?.path ?? this.app.workspace.getActiveFile()?.path;
        if (!path) {
          new Notice(
            this.l(
              "无法确定这段选文属于哪篇笔记",
              "Cannot determine the note for this selection"
            )
          );
          return;
        }

        this.pinDiscussionReference(path, selection);
        void this.activateDiscussionSidebar(true);
      },
    });

    this.addCommand({
      id: "new-discussion",
      name: this.l("当前笔记开始新讨论", "Start new discussion for current note"),
      callback: () => this.newDiscussion(),
    });

    this.addCommand({
      id: "toggle-auto",
      name: this.l("切换自动补全", "Toggle automatic completion"),
      callback: () => {
        this.settings.autoEnabled = !this.settings.autoEnabled;
        if (!this.settings.autoEnabled) clearAllSuggestions();
        void this.saveSettings();

        if (this.settings.autoEnabled) {
          new Notice(this.l("AI 自动补全：已开启", "AI autocomplete: on"));
          return;
        }
        new Notice(this.l("AI 自动补全：已关闭", "AI autocomplete: off"));
      },
    });

    this.addCommand({
      id: "test-connection",
      name: this.l("测试 Provider 连接", "Test provider connection"),
      callback: () => void this.testConnection(),
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = normalizeLoadedSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  onSettingsChanged(): void {
    if (!this.settings.autoEnabled) clearAllSuggestions();
    this.refreshSidebar();
  }

  getInlineConfig(): InlineSuggestionConfig {
    return {
      autoEnabled: this.settings.autoEnabled,
      eagerness: this.settings.eagerness,
      maxPrefixChars: this.settings.maxPrefixChars,
      maxSuffixChars: this.settings.maxSuffixChars,
    };
  }

  private getCompletionOptions(): CompletionRequestOptions {
    return this.getRequestOptions(
      getProviderModel(this.settings),
      this.settings.maxTokens,
      this.settings.completionReasoningEffort,
      getActivePromptTemplate(this.settings).prompt
    );
  }

  private getDiscussionOptions(): CompletionRequestOptions {
    return this.getRequestOptions(
      getDiscussionProviderModel(this.settings),
      this.settings.discussionMaxTokens,
      this.settings.discussionReasoningEffort
    );
  }

  private getRequestOptions(
    model: string,
    maxTokens: number,
    reasoningEffort: ReasoningEffort,
    systemPrompt?: string
  ): CompletionRequestOptions {
    return {
      providerId: this.settings.providerId,
      apiKey: getProviderApiKey(this.settings),
      model,
      baseUrl: this.settings.baseUrl,
      systemPrompt,
      temperature: this.settings.temperature,
      maxTokens,
      reasoningEffort,
    };
  }

  getDiscussionSnapshot(): DiscussionSnapshot {
    const noteKey = this.currentDiscussionNoteKey();
    const session = this.getDiscussionSession(noteKey);
    const provider = getProviderOptions().find((item) => {
      return item.id === this.settings.providerId;
    });
    const modelId = getDiscussionProviderModel(this.settings);

    let notePath: string | null = noteKey;
    if (noteKey === ACTIVE_EDITOR_NOTE_KEY) notePath = null;

    return {
      notePath,
      reference: session.reference,
      turns: session.turns,
      status: session.status,
      streamingThinking: session.streamingThinking,
      streamingText: session.streamingText,
      error: session.error,
      language: this.settings.uiLanguage,
      providerId: this.settings.providerId,
      providerName: provider?.name ?? this.settings.providerId,
      modelId,
      modelOptions: getProviderModels(this.settings.providerId),
      reasoning: this.settings.discussionReasoningEffort,
      reasoningHint: this.reasoningHint(this.settings.discussionReasoningEffort),
      tokenBudget: this.settings.discussionMaxTokens,
    };
  }

  async setDiscussionModel(modelId: string): Promise<void> {
    const model = modelId.trim();
    if (!model) return;

    setDiscussionProviderModel(this.settings, model);
    await this.saveSettings();
    this.refreshSidebar();
  }

  async setDiscussionReasoning(value: ReasoningEffort): Promise<void> {
    this.settings.discussionReasoningEffort = normalizeReasoningEffort(value);
    await this.saveSettings();
    this.refreshSidebar();
  }

  async setDiscussionTokenBudget(value: number): Promise<void> {
    this.settings.discussionMaxTokens = normalizeTokenBudget(
      value,
      this.settings.discussionMaxTokens
    );
    await this.saveSettings();
    this.refreshSidebar();
  }

  async sendDiscussion(question: string): Promise<void> {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) return;

    const noteKey = this.currentDiscussionNoteKey();
    const session = this.getDiscussionSession(noteKey);
    this.abortDiscussionRequest();

    const previousTurns = session.turns.slice();
    const reference = session.reference;
    session.turns.push({ role: "user", content: trimmedQuestion });
    this.trimDiscussionTurns(session);
    session.status = "thinking";
    clearStreamingOutput(session);
    session.error = "";
    this.refreshSidebar();

    const messages = buildDiscussionMessages(
      this.settings.discussionPrompt,
      previousTurns,
      noteKey,
      reference,
      trimmedQuestion
    );

    const controller = new AbortController();
    this.discussionController = controller;
    this.discussionRequestNoteKey = noteKey;

    try {
      const result = await streamChatCompletion(
        this.getDiscussionOptions(),
        messages,
        controller.signal,
        {
          onStatus: (status) => {
            if (!this.isCurrentDiscussionRequest(controller, noteKey)) return;
            session.status = status;
            this.queueSidebarRefresh();
          },
          onThinking: (thinking) => {
            if (!this.isCurrentDiscussionRequest(controller, noteKey)) return;
            session.status = "thinking";
            session.streamingThinking = thinking;
            this.queueSidebarRefresh();
          },
          onText: (text) => {
            if (!this.isCurrentDiscussionRequest(controller, noteKey)) return;
            session.status = "generating";
            session.streamingText = text;
            this.queueSidebarRefresh();
          },
        }
      );

      if (!this.isCurrentDiscussionRequest(controller, noteKey)) return;
      const answer = result?.trim();
      if (!answer) {
        throw new CompletionError(
          this.l("模型没有返回可显示的回答文本。", "The model returned no answer text.")
        );
      }

      session.turns.push({
        role: "assistant",
        content: answer,
        thinking: session.streamingThinking.trim() || undefined,
      });
      this.trimDiscussionTurns(session);
      session.status = "idle";
      clearStreamingOutput(session);
      session.error = "";
      this.refreshSidebar();
    } catch (error) {
      if (isAbortError(error)) {
        if (this.discussionRequestNoteKey === noteKey) {
          session.status = "idle";
          clearStreamingOutput(session);
          this.refreshSidebar();
        }
        return;
      }

      session.status = "error";
      session.error = this.errorMessage(error);
      clearStreamingOutput(session);
      console.error("AI autocomplete: discussion error", error);
      this.refreshSidebar();
    } finally {
      if (this.discussionController === controller) {
        this.discussionController = null;
        this.discussionRequestNoteKey = null;
      }
    }
  }

  cancelDiscussion(): void {
    const noteKey = this.discussionRequestNoteKey;
    const session = noteKey ? this.discussionSessions.get(noteKey) : undefined;
    const partialText = session?.streamingText.trim() ?? "";
    const partialThinking = session?.streamingThinking.trim() ?? "";

    this.abortDiscussionRequest();

    if (session && (partialText || partialThinking)) {
      session.turns.push({
        role: "assistant",
        content: partialText,
        thinking: partialThinking || undefined,
      });
      this.trimDiscussionTurns(session);
      session.status = "idle";
      session.error = "";
    }
    this.refreshSidebar();
  }

  newDiscussion(): void {
    const noteKey = this.currentDiscussionNoteKey();
    if (this.discussionRequestNoteKey === noteKey) this.abortDiscussionRequest();

    this.discussionSessions.set(noteKey, createDiscussionSession());
    this.refreshSidebar();
  }

  clearDiscussionReference(): void {
    const session = this.getDiscussionSession(this.currentDiscussionNoteKey());
    session.reference = "";
    this.refreshSidebar();
  }

  captureCurrentSelection(): boolean {
    const view =
      this.lastMarkdownView ?? this.app.workspace.getActiveViewOfType(MarkdownView);
    const selection = view?.editor.getSelection().trim() ?? "";
    const path = view?.file?.path;

    if (!selection || !path) {
      new Notice(
        this.l(
          "请先在 Markdown 笔记里选中一段文字",
          "Select text in a Markdown note first"
        )
      );
      return false;
    }

    this.pinDiscussionReference(path, selection);
    return true;
  }

  private pinDiscussionReference(notePath: string, selection: string): void {
    this.discussionNoteKey = notePath;
    const session = this.getDiscussionSession(notePath);
    session.reference = selection;
    session.error = "";
    this.refreshSidebar();
  }

  private async activateDiscussionSidebar(focusInput: boolean): Promise<void> {
    const leaf = await this.getDiscussionSidebarLeaf();
    if (!leaf) {
      new Notice(
        this.l("无法打开 AI 讨论侧栏", "Could not open the AI discussion sidebar")
      );
      return;
    }

    const sidebarView = leaf.view;
    if (!(sidebarView instanceof DiscussionSidebarView)) return;

    sidebarView.refresh();
    if (focusInput) {
      requestAnimationFrame(function focusSidebarInput(): void {
        sidebarView.focusInput();
      });
    }
  }

  private async getDiscussionSidebarLeaf(): Promise<WorkspaceLeaf | null> {
    const workspace = this.app.workspace;
    const workspaceWithSideLeaf = workspace as typeof workspace & {
      ensureSideLeaf?: (
        type: string,
        side: "left" | "right",
        options?: { active?: boolean; reveal?: boolean }
      ) => Promise<WorkspaceLeaf>;
    };

    if (typeof workspaceWithSideLeaf.ensureSideLeaf === "function") {
      return workspaceWithSideLeaf.ensureSideLeaf(
        VIEW_TYPE_AI_DISCUSSION,
        "right",
        { active: true, reveal: true }
      );
    }

    let leaf = workspace.getLeavesOfType(VIEW_TYPE_AI_DISCUSSION)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getRightLeaf(true);
      if (leaf) {
        await leaf.setViewState({
          type: VIEW_TYPE_AI_DISCUSSION,
          active: true,
        });
      }
    }

    if (leaf) await workspace.revealLeaf(leaf);
    return leaf;
  }

  private refreshSidebar(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_DISCUSSION)) {
      if (leaf.view instanceof DiscussionSidebarView) leaf.view.refresh();
    }
  }

  private queueSidebarRefresh(): void {
    if (this.sidebarRefreshQueued) return;

    this.sidebarRefreshQueued = true;
    requestAnimationFrame(() => {
      this.sidebarRefreshQueued = false;
      this.refreshSidebar();
    });
  }

  private currentDiscussionNoteKey(): string {
    return (
      this.discussionNoteKey ??
      this.lastMarkdownView?.file?.path ??
      this.app.workspace.getActiveFile()?.path ??
      ACTIVE_EDITOR_NOTE_KEY
    );
  }

  private getDiscussionSession(noteKey: string): DiscussionSession {
    const existingSession = this.discussionSessions.get(noteKey);
    if (existingSession) return existingSession;

    const session = createDiscussionSession();
    this.discussionSessions.set(noteKey, session);
    return session;
  }

  private trimDiscussionTurns(session: DiscussionSession): void {
    if (session.turns.length <= MAX_DISCUSSION_TURNS) return;
    session.turns.splice(0, session.turns.length - MAX_DISCUSSION_TURNS);
  }

  private abortDiscussionRequest(): void {
    const previousKey = this.discussionRequestNoteKey;
    this.discussionController?.abort();
    this.discussionController = null;
    this.discussionRequestNoteKey = null;

    if (!previousKey) return;

    const previousSession = this.discussionSessions.get(previousKey);
    if (!previousSession) return;

    previousSession.status = "idle";
    clearStreamingOutput(previousSession);
  }

  private isCurrentDiscussionRequest(
    controller: AbortController,
    noteKey: string
  ): boolean {
    return (
      !controller.signal.aborted &&
      this.discussionController === controller &&
      this.discussionRequestNoteKey === noteKey
    );
  }

  async testConnection(): Promise<void> {
    const controller = new AbortController();

    try {
      const result = await fetchCompletion(
        this.getCompletionOptions(),
        "个人知识笔记的价值在于",
        "，而不仅仅是把信息保存下来。",
        controller.signal
      );
      const sample = result?.replace(/\s+/g, " ").slice(0, 50);

      if (sample) {
        new Notice(this.l(`连接成功：${sample}`, `Connected — ${sample}`));
        return;
      }
      new Notice(this.l("连接成功", "Connected"));
    } catch (error) {
      this.showCompletionError(error, true);
    }
  }

  private showCompletionError(error: unknown, forceNotice = false): void {
    console.error("AI autocomplete: completion error", error);

    const now = Date.now();
    if (!forceNotice && now - this.lastErrorNoticeAt < 10000) return;

    this.lastErrorNoticeAt = now;
    new Notice(`AI Autocomplete: ${this.errorMessage(error)}`);
  }

  private errorMessage(error: unknown): string {
    let message = this.l("未知错误", "Unknown error");
    if (error instanceof Error) message = error.message;

    if (message.includes("reached the output limit while reasoning")) {
      return this.l(
        "模型在输出正文前就耗尽了 reasoning 预算。请提高 Token 上限或降低思考等级。",
        "The model exhausted its output budget while reasoning. Increase the token budget or lower the reasoning level."
      );
    }
    return message;
  }

  private reasoningHint(value: ReasoningEffort): string {
    if (!value) {
      return this.l(
        "不传 reasoning，由 Provider/模型使用默认行为。",
        "No reasoning level is sent; the provider/model uses its default behavior."
      );
    }

    if (this.settings.providerId === "custom" && value === "minimal") {
      return this.l(
        "pi-ai: reasoning=minimal → Custom OpenAI: reasoning_effort=none",
        "pi-ai: reasoning=minimal → Custom OpenAI: reasoning_effort=none"
      );
    }

    return this.l(
      `pi-ai: reasoning=${value}；由 ${this.settings.providerId} adapter 映射到实际请求字段。`,
      `pi-ai: reasoning=${value}; the ${this.settings.providerId} adapter maps it to the wire format.`
    );
  }

  private l(zh: string, en: string): string {
    return tr(this.settings.uiLanguage, zh, en);
  }
}

function createDiscussionSession(): DiscussionSession {
  return {
    reference: "",
    turns: [],
    status: "idle",
    streamingThinking: "",
    streamingText: "",
    error: "",
  };
}

function clearStreamingOutput(session: DiscussionSession): void {
  session.streamingThinking = "";
  session.streamingText = "";
}

function buildDiscussionMessages(
  systemPrompt: string,
  previousTurns: DiscussionTurn[],
  noteKey: string,
  reference: string,
  question: string
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  for (const turn of previousTurns) {
    messages.push({ role: turn.role, content: turn.content });
  }

  let userContent = question;
  if (reference) {
    userContent = `<reference note="${escapeXmlAttribute(noteKey)}">\n${reference}\n</reference>\n\n<question>\n${question}\n</question>`;
  }
  messages.push({ role: "user", content: userContent });

  return messages;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function cmOf(editor: Editor): EditorView | null {
  return (editor as unknown as { cm?: EditorView }).cm ?? null;
}

function withView(
  editor: Editor,
  action: (view: EditorView) => boolean
): void {
  const view = cmOf(editor);
  if (view) action(view);
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/[&"<>]/g, function escapeCharacter(character): string {
    switch (character) {
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return character;
    }
  });
}
