import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from "obsidian";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  type ChatMessage,
  CompletionError,
  DEFAULT_DISCUSSION_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  fetchCompletion,
  getProviderModels,
  getProviderOptions,
  type CompletionRequestOptions,
  type ReasoningEffort,
  streamChatCompletion,
} from "./ai-client";
import {
  DiscussionSidebarView,
  type DiscussionRunStatus,
  type DiscussionSidebarHost,
  type DiscussionSnapshot,
  VIEW_TYPE_AI_DISCUSSION,
} from "./discussion-sidebar";
import {
  acceptSuggestion,
  acceptSuggestionSegment,
  clearAllSuggestions,
  dismissSuggestion,
  getSuggestionManager,
  inlineSuggestionExtension,
  type InlineSuggestionConfig,
} from "./ghost-text";
import {
  type AIAutocompleteSettings,
  createTemplateId,
  DEFAULT_API_BASE_URL,
  DEFAULT_SETTINGS,
  getActivePromptTemplate,
  getProviderApiKey,
  getProviderModel,
  normalizeEagerness,
  normalizeLoadedSettings,
  normalizeReasoningEffort,
  normalizeTokenBudget,
  setProviderApiKey,
  setProviderModel,
  type PromptTemplate,
  uniqueTemplateName,
} from "./settings";

interface DiscussionTurn {
  role: "user" | "assistant";
  content: string;
}

interface DiscussionSession {
  reference: string;
  turns: DiscussionTurn[];
  status: DiscussionRunStatus;
  streamingText: string;
  error: string;
}

const MAX_DISCUSSION_TURNS = 12;

export default class AIAutocompletePlugin
  extends Plugin
  implements DiscussionSidebarHost
{
  settings: AIAutocompleteSettings = DEFAULT_SETTINGS;
  private editorExtensions: Extension[] = [];
  private lastErrorNoticeAt = 0;
  private readonly discussionSessions = new Map<string, DiscussionSession>();
  private discussionController: AbortController | null = null;
  private discussionRequestNoteKey: string | null = null;
  private discussionNoteKey: string | null = null;
  private lastMarkdownView: MarkdownView | null = null;
  private sidebarRefreshQueued = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.editorExtensions = inlineSuggestionExtension(
      async ({ prefix, suffix, signal }) => {
        try {
          return await fetchCompletion(
            this.getCompletionOptions(),
            prefix,
            suffix,
            signal
          );
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") return null;
          this.showCompletionError(error);
          return null;
        }
      },
      () => this.getInlineConfig()
    );

    this.registerEditorExtension(this.editorExtensions);
    this.registerView(
      VIEW_TYPE_AI_DISCUSSION,
      (leaf) => new DiscussionSidebarView(leaf, this)
    );
    this.addSettingTab(new AIAutocompleteSettingTab(this.app, this));
    this.registerCommands();

    this.addRibbonIcon("messages-square", "Open AI Discussion", () => {
      void this.activateDiscussionSidebar(true);
    });

    this.lastMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (this.lastMarkdownView?.file?.path) {
      this.discussionNoteKey = this.lastMarkdownView.file.path;
    }

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) {
          this.lastMarkdownView = leaf.view;
          if (leaf.view.file?.path) {
            this.discussionNoteKey = leaf.view.file.path;
          }
          this.refreshSidebar();
        }
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
      name: "Trigger inline suggestion",
      editorCallback: (editor) => {
        const view = cmOf(editor);
        if (view) void getSuggestionManager(view)?.request(true);
      },
    });

    this.addCommand({
      id: "accept",
      name: "Accept inline suggestion",
      editorCallback: (editor) => withView(editor, acceptSuggestion),
    });

    this.addCommand({
      id: "accept-segment",
      name: "Accept next suggestion segment",
      editorCallback: (editor) => withView(editor, acceptSuggestionSegment),
    });

    this.addCommand({
      id: "dismiss",
      name: "Dismiss inline suggestion",
      editorCallback: (editor) => withView(editor, dismissSuggestion),
    });

    this.addCommand({
      id: "open-discussion",
      name: "Open AI discussion sidebar",
      callback: () => void this.activateDiscussionSidebar(true),
    });

    this.addCommand({
      id: "ask-selection",
      name: "Discuss selection in sidebar",
      editorCallback: (editor, context) => {
        const selection = editor.getSelection().trim();
        if (!selection) {
          new Notice("AI autocomplete: select a passage first");
          return;
        }

        if (context instanceof MarkdownView) this.lastMarkdownView = context;
        const path = context.file?.path ?? this.app.workspace.getActiveFile()?.path;
        if (!path) {
          new Notice("AI autocomplete: cannot determine the note for this selection");
          return;
        }

        this.pinDiscussionReference(path, selection);
        void this.activateDiscussionSidebar(true);
      },
    });

    this.addCommand({
      id: "new-discussion",
      name: "Start new discussion for current note",
      callback: () => this.newDiscussion(),
    });

    this.addCommand({
      id: "toggle-auto",
      name: "Toggle automatic completion",
      callback: () => {
        this.settings.autoEnabled = !this.settings.autoEnabled;
        if (!this.settings.autoEnabled) clearAllSuggestions();
        void this.saveSettings();
        new Notice(
          `AI autocomplete: automatic completion ${
            this.settings.autoEnabled ? "on" : "off"
          }`
        );
      },
    });

    this.addCommand({
      id: "test-connection",
      name: "Test provider connection",
      callback: () => void this.testConnection(),
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = normalizeLoadedSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getInlineConfig(): InlineSuggestionConfig {
    return {
      autoEnabled: this.settings.autoEnabled,
      eagerness: this.settings.eagerness,
      maxPrefixChars: this.settings.maxPrefixChars,
      maxSuffixChars: this.settings.maxSuffixChars,
    };
  }

  getActivePromptTemplate(): PromptTemplate {
    return getActivePromptTemplate(this.settings);
  }

  getCompletionOptions(): CompletionRequestOptions {
    return {
      providerId: this.settings.providerId,
      apiKey: getProviderApiKey(this.settings),
      model: getProviderModel(this.settings),
      baseUrl: this.settings.baseUrl,
      systemPrompt: this.getActivePromptTemplate().prompt,
      temperature: this.settings.temperature,
      maxTokens: this.settings.maxTokens,
      reasoningEffort: this.settings.completionReasoningEffort,
    };
  }

  getDiscussionOptions(): CompletionRequestOptions {
    return {
      providerId: this.settings.providerId,
      apiKey: getProviderApiKey(this.settings),
      model: getProviderModel(this.settings),
      baseUrl: this.settings.baseUrl,
      temperature: this.settings.temperature,
      maxTokens: this.settings.discussionMaxTokens,
      reasoningEffort: this.settings.discussionReasoningEffort,
    };
  }

  getDiscussionSnapshot(): DiscussionSnapshot {
    const noteKey = this.currentDiscussionNoteKey();
    const session = this.getDiscussionSession(noteKey);
    return {
      notePath: noteKey === "__active-editor__" ? null : noteKey,
      reference: session.reference,
      turns: session.turns,
      status: session.status,
      streamingText: session.streamingText,
      error: session.error,
    };
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
    session.streamingText = "";
    session.error = "";
    this.refreshSidebar();

    const messages: ChatMessage[] = [
      { role: "system", content: this.settings.discussionPrompt },
      ...previousTurns.map((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
      {
        role: "user",
        content: reference
          ? `<reference note="${escapeXmlAttribute(noteKey)}">\n${reference}\n</reference>\n\n<question>\n${trimmedQuestion}\n</question>`
          : trimmedQuestion,
      },
    ];

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
        throw new CompletionError("The model returned no answer text.");
      }

      session.turns.push({ role: "assistant", content: answer });
      this.trimDiscussionTurns(session);
      session.status = "idle";
      session.streamingText = "";
      session.error = "";
      this.refreshSidebar();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (this.discussionRequestNoteKey === noteKey) {
          session.status = "idle";
          session.streamingText = "";
          this.refreshSidebar();
        }
        return;
      }

      const message =
        error instanceof CompletionError || error instanceof Error
          ? error.message
          : "Unknown completion error";
      session.status = "error";
      session.error = message;
      session.streamingText = "";
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
    const partial = session?.streamingText.trim() ?? "";

    this.abortDiscussionRequest();

    if (session && partial) {
      session.turns.push({ role: "assistant", content: partial });
      this.trimDiscussionTurns(session);
      session.status = "idle";
      session.error = "";
    }
    this.refreshSidebar();
  }

  newDiscussion(): void {
    const noteKey = this.currentDiscussionNoteKey();
    if (this.discussionRequestNoteKey === noteKey) {
      this.abortDiscussionRequest();
    }
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
      new Notice("AI autocomplete: select text in a Markdown note first");
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
    const workspace = this.app.workspace;
    const workspaceWithSideLeaf = workspace as typeof workspace & {
      ensureSideLeaf?: (
        type: string,
        side: "left" | "right",
        options?: { active?: boolean; reveal?: boolean }
      ) => Promise<WorkspaceLeaf>;
    };

    let leaf: WorkspaceLeaf | null = null;
    if (typeof workspaceWithSideLeaf.ensureSideLeaf === "function") {
      leaf = await workspaceWithSideLeaf.ensureSideLeaf(
        VIEW_TYPE_AI_DISCUSSION,
        "right",
        { active: true, reveal: true }
      );
    } else {
      leaf = workspace.getLeavesOfType(VIEW_TYPE_AI_DISCUSSION)[0] ?? null;
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
    }

    if (!leaf) {
      new Notice("AI autocomplete: could not open the discussion sidebar");
      return;
    }

    const view = leaf.view;
    if (view instanceof DiscussionSidebarView) {
      view.refresh();
      if (focusInput) requestAnimationFrame(() => view.focusInput());
    }
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
      "__active-editor__"
    );
  }

  private getDiscussionSession(noteKey: string): DiscussionSession {
    let session = this.discussionSessions.get(noteKey);
    if (!session) {
      session = createDiscussionSession();
      this.discussionSessions.set(noteKey, session);
    }
    return session;
  }

  private trimDiscussionTurns(session: DiscussionSession): void {
    if (session.turns.length > MAX_DISCUSSION_TURNS) {
      session.turns.splice(0, session.turns.length - MAX_DISCUSSION_TURNS);
    }
  }

  private abortDiscussionRequest(): void {
    const previousKey = this.discussionRequestNoteKey;
    this.discussionController?.abort();
    this.discussionController = null;
    this.discussionRequestNoteKey = null;

    if (previousKey) {
      const previous = this.discussionSessions.get(previousKey);
      if (previous) {
        previous.status = "idle";
        previous.streamingText = "";
      }
    }
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
      new Notice(
        `AI autocomplete: connected${sample ? ` — ${sample}` : ""}`
      );
    } catch (error) {
      this.showCompletionError(error, true);
    }
  }

  showCompletionError(error: unknown, forceNotice = false): void {
    console.error("AI autocomplete: completion error", error);

    const now = Date.now();
    if (!forceNotice && now - this.lastErrorNoticeAt < 10000) return;
    this.lastErrorNoticeAt = now;

    const message =
      error instanceof CompletionError || error instanceof Error
        ? error.message
        : "Unknown completion error";
    new Notice(`AI autocomplete failed: ${message}`);
  }
}

class AIAutocompleteSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: AIAutocompletePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.settings;

    new Setting(containerEl).setName("General").setHeading();

    new Setting(containerEl)
      .setName("Automatic completion")
      .setDesc(
        "Show suggestions automatically after you pause typing. Manual trigger remains available when this is off."
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.autoEnabled).onChange(async (value) => {
          settings.autoEnabled = value;
          if (!value) clearAllSuggestions();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Eagerness")
      .setDesc(
        "How aggressively automatic completion triggers. 1 = conservative, 3 = balanced, 5 = eager."
      )
      .addSlider((slider) =>
        slider
          .setLimits(1, 5, 1)
          .setValue(settings.eagerness)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.eagerness = normalizeEagerness(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Manual trigger")
      .setDesc(
        "Command: “AI Autocomplete: Trigger inline suggestion”. Assign any shortcut in Obsidian Settings → Hotkeys."
      );

    new Setting(containerEl).setName("Provider").setHeading();

    const providerOptions = getProviderOptions();
    const selectedProvider =
      providerOptions.find((provider) => provider.id === settings.providerId) ??
      providerOptions[0];

    new Setting(containerEl)
      .setName("Provider")
      .setDesc(
        "Built-in providers and model catalogs come from pi-ai. Choose Custom only for your own OpenAI-compatible endpoint."
      )
      .addDropdown((dropdown) => {
        for (const provider of providerOptions) {
          dropdown.addOption(provider.id, provider.name);
        }
        dropdown.setValue(settings.providerId).onChange(async (value) => {
          settings.providerId = value;
          if (value !== "custom") {
            const models = getProviderModels(value);
            const current = getProviderModel(settings);
            if (!models.some((model) => model.id === current) && models[0]) {
              setProviderModel(settings, models[0].id);
            }
          }
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("API key")
      .setDesc(`Stored separately for ${selectedProvider.name}.`)
      .addText((text) => {
        text
          .setPlaceholder("API key")
          .setValue(getProviderApiKey(settings))
          .onChange(async (value) => {
            setProviderApiKey(settings, value.trim());
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    if (settings.providerId === "custom") {
      new Setting(containerEl)
        .setName("API base URL")
        .setDesc(
          "Root of your OpenAI-compatible API, for example http://127.0.0.1:18180/v1."
        )
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_API_BASE_URL)
            .setValue(settings.baseUrl)
            .onChange(async (value) => {
              settings.baseUrl = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Model")
        .setDesc("Exact model id accepted by the custom endpoint.")
        .addText((text) =>
          text
            .setPlaceholder("model-id")
            .setValue(getProviderModel(settings))
            .onChange(async (value) => {
              setProviderModel(settings, value.trim());
              await this.plugin.saveSettings();
            })
        );
    } else {
      const models = getProviderModels(settings.providerId);
      const selectedModel = getProviderModel(settings);
      const selectedModelInfo = models.find((model) => model.id === selectedModel);

      new Setting(containerEl)
        .setName("Model")
        .setDesc(
          selectedModelInfo
            ? `${models.length} models in the pi-ai catalog. ${
                selectedModelInfo.reasoning ? "Reasoning model." : "Non-reasoning model."
              } Max output: ${selectedModelInfo.maxTokens.toLocaleString()} tokens.`
            : `${models.length} models in the pi-ai catalog.`
        )
        .addDropdown((dropdown) => {
          if (selectedModel && !models.some((model) => model.id === selectedModel)) {
            dropdown.addOption(selectedModel, `${selectedModel} (not in catalog)`);
          }
          for (const model of models) {
            dropdown.addOption(model.id, model.name);
          }
          dropdown.setValue(selectedModel).onChange(async (value) => {
            setProviderModel(settings, value);
            await this.plugin.saveSettings();
            this.display();
          });
        });
    }

    new Setting(containerEl)
      .setName("Connection")
      .setDesc("Send a small completion request using the current provider and model.")
      .addButton((button) =>
        button.setButtonText("Test").onClick(() => void this.plugin.testConnection())
      );

    new Setting(containerEl).setName("Completion").setHeading();

    addReasoningSetting(
      containerEl,
      "Completion reasoning",
      "Provider default requests no explicit reasoning level. Minimal/None is provider-specific; Low is usually the highest useful setting for latency-sensitive autocomplete.",
      settings.completionReasoningEffort,
      async (value) => {
        settings.completionReasoningEffort = value;
        await this.plugin.saveSettings();
      }
    );

    addTokenBudgetSetting(
      containerEl,
      "Maximum output tokens",
      "Maximum output budget, including reasoning tokens when the model uses them. You can enter any value from 16 to 65,536.",
      settings.maxTokens,
      async (value) => {
        settings.maxTokens = value;
        await this.plugin.saveSettings();
      }
    );

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("Lower values make completions more stable and predictable.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.1)
          .setValue(settings.temperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.temperature = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Completion prompt templates").setHeading();

    const activeTemplate = this.plugin.getActivePromptTemplate();

    new Setting(containerEl)
      .setName("Active template")
      .setDesc("Only the active template's system prompt is sent to the model.")
      .addDropdown((dropdown) => {
        for (const template of settings.promptTemplates) {
          dropdown.addOption(template.id, template.name);
        }
        dropdown.setValue(activeTemplate.id).onChange(async (value) => {
          settings.activePromptTemplateId = value;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Template actions")
      .setDesc("Create, copy, or remove completion prompt templates.")
      .addButton((button) =>
        button.setButtonText("New").onClick(async () => {
          const template: PromptTemplate = {
            id: createTemplateId(),
            name: uniqueTemplateName(settings.promptTemplates, "New template"),
            prompt: DEFAULT_SYSTEM_PROMPT,
          };
          settings.promptTemplates.push(template);
          settings.activePromptTemplateId = template.id;
          await this.plugin.saveSettings();
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("Duplicate").onClick(async () => {
          const template: PromptTemplate = {
            id: createTemplateId(),
            name: uniqueTemplateName(
              settings.promptTemplates,
              `${activeTemplate.name} copy`
            ),
            prompt: activeTemplate.prompt,
          };
          settings.promptTemplates.push(template);
          settings.activePromptTemplateId = template.id;
          await this.plugin.saveSettings();
          this.display();
        })
      )
      .addButton((button) => {
        button
          .setButtonText("Delete")
          .setDisabled(settings.promptTemplates.length <= 1)
          .onClick(async () => {
            if (settings.promptTemplates.length <= 1) return;
            settings.promptTemplates = settings.promptTemplates.filter(
              (template) => template.id !== activeTemplate.id
            );
            settings.activePromptTemplateId = settings.promptTemplates[0].id;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Template name")
      .setDesc("Rename the active completion prompt template.")
      .addText((text) =>
        text.setValue(activeTemplate.name).onChange(async (value) => {
          const trimmed = value.trim();
          if (!trimmed) return;
          activeTemplate.name = trimmed;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Editable instructions for the active completion template.")
      .addTextArea((text) => {
        text.inputEl.rows = 14;
        text.inputEl.cols = 60;
        text
          .setPlaceholder(DEFAULT_SYSTEM_PROMPT)
          .setValue(activeTemplate.prompt)
          .onChange(async (value) => {
            activeTemplate.prompt = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Reset current template")
      .setDesc("Replace this completion template's prompt with the built-in default.")
      .addButton((button) =>
        button.setButtonText("Reset prompt").onClick(async () => {
          activeTemplate.prompt = DEFAULT_SYSTEM_PROMPT;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl).setName("Discussion sidebar").setHeading();

    new Setting(containerEl)
      .setName("Discuss selection")
      .setDesc(
        "Select text in a Markdown note and run “AI Autocomplete: Discuss selection in sidebar”. The selection is pinned as reference; then ask questions in the sidebar."
      );

    new Setting(containerEl)
      .setName("Session behavior")
      .setDesc(
        "Each note keeps its own short in-memory discussion history. Changing the editor selection or cursor does not clear it, and inline autocomplete never receives discussion history."
      );

    addReasoningSetting(
      containerEl,
      "Discussion reasoning",
      "Provider default requests no explicit reasoning level. Larger reasoning levels may need a much larger output-token budget.",
      settings.discussionReasoningEffort,
      async (value) => {
        settings.discussionReasoningEffort = value;
        await this.plugin.saveSettings();
      }
    );

    addTokenBudgetSetting(
      containerEl,
      "Discussion output tokens",
      "Total output budget for the sidebar answer, including reasoning tokens. Values up to 65,536 are allowed.",
      settings.discussionMaxTokens,
      async (value) => {
        settings.discussionMaxTokens = value;
        await this.plugin.saveSettings();
      }
    );

    new Setting(containerEl)
      .setName("Discussion prompt")
      .setDesc("System prompt used only by the discussion sidebar.")
      .addTextArea((text) => {
        text.inputEl.rows = 12;
        text.inputEl.cols = 60;
        text
          .setPlaceholder(DEFAULT_DISCUSSION_PROMPT)
          .setValue(settings.discussionPrompt)
          .onChange(async (value) => {
            settings.discussionPrompt = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Reset discussion prompt")
      .setDesc("Restore the built-in discussion prompt.")
      .addButton((button) =>
        button.setButtonText("Reset prompt").onClick(async () => {
          settings.discussionPrompt = DEFAULT_DISCUSSION_PROMPT;
          await this.plugin.saveSettings();
          this.display();
        })
      );
  }
}

function addReasoningSetting(
  containerEl: HTMLElement,
  name: string,
  description: string,
  value: ReasoningEffort,
  onChange: (value: ReasoningEffort) => Promise<void>
): void {
  new Setting(containerEl)
    .setName(name)
    .setDesc(description)
    .addDropdown((dropdown) =>
      dropdown
        .addOption("", "Provider default (do not send)")
        .addOption("none", "Minimal / None (provider-specific)")
        .addOption("low", "Low")
        .addOption("medium", "Medium")
        .addOption("high", "High")
        .setValue(value)
        .onChange(async (next) => {
          await onChange(normalizeReasoningEffort(next));
        })
    );
}

function addTokenBudgetSetting(
  containerEl: HTMLElement,
  name: string,
  description: string,
  value: number,
  onChange: (value: number) => Promise<void>
): void {
  new Setting(containerEl)
    .setName(name)
    .setDesc(description)
    .addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = "16";
      text.inputEl.max = "65536";
      text.inputEl.step = "16";
      text.setValue(String(value)).onChange(async (raw) => {
        if (!raw.trim()) return;
        await onChange(normalizeTokenBudget(raw, value));
      });
      text.inputEl.addEventListener("blur", () => {
        const normalized = normalizeTokenBudget(text.inputEl.value, value);
        text.inputEl.value = String(normalized);
      });
    });
}

function createDiscussionSession(): DiscussionSession {
  return {
    reference: "",
    turns: [],
    status: "idle",
    streamingText: "",
    error: "",
  };
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
  return value.replace(/[&"<>]/g, (character) => {
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
