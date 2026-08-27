import {
  App,
  Editor,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  acceptDiscussionAnswer,
  discussionExtension,
  dismissDiscussionAnswer,
  showDiscussionAnswer,
} from "./discussion";
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
  type ChatMessage,
  CompletionError,
  type CompletionRequestOptions,
  DEFAULT_API_BASE_URL,
  DEFAULT_DISCUSSION_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  fetchChatCompletion,
  fetchCompletion,
  type ReasoningEffort,
} from "./openai-client";

interface PromptTemplate {
  id: string;
  name: string;
  prompt: string;
}

interface DiscussionTurn {
  role: "user" | "assistant";
  content: string;
}

interface DiscussionSession {
  turns: DiscussionTurn[];
}

interface AIAutocompleteSettings {
  autoEnabled: boolean;
  eagerness: number;
  apiKey: string;
  model: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  discussionMaxTokens: number;
  completionReasoningEffort: ReasoningEffort;
  discussionReasoningEffort: ReasoningEffort;
  maxPrefixChars: number;
  maxSuffixChars: number;
  promptTemplates: PromptTemplate[];
  activePromptTemplateId: string;
  discussionPrompt: string;
}

type LegacySettings = Partial<AIAutocompleteSettings> & {
  enabled?: boolean;
  systemPrompt?: string;
  delay?: number;
  minPrefixChars?: number;
};

const DEFAULT_TEMPLATE_ID = "default";
const MAX_DISCUSSION_TURNS = 8;
const DISCUSSION_CONTEXT_BEFORE = 1800;
const DISCUSSION_CONTEXT_AFTER = 900;

const DEFAULT_SETTINGS: AIAutocompleteSettings = {
  autoEnabled: true,
  eagerness: 3,
  apiKey: "",
  model: "gpt-4o-mini",
  baseUrl: DEFAULT_API_BASE_URL,
  temperature: 0.2,
  maxTokens: 96,
  discussionMaxTokens: 384,
  completionReasoningEffort: "",
  discussionReasoningEffort: "",
  maxPrefixChars: 2400,
  maxSuffixChars: 600,
  promptTemplates: [
    {
      id: DEFAULT_TEMPLATE_ID,
      name: "Default",
      prompt: DEFAULT_SYSTEM_PROMPT,
    },
  ],
  activePromptTemplateId: DEFAULT_TEMPLATE_ID,
  discussionPrompt: DEFAULT_DISCUSSION_PROMPT,
};

export default class AIAutocompletePlugin extends Plugin {
  settings: AIAutocompleteSettings = DEFAULT_SETTINGS;
  private editorExtensions: Extension[] = [];
  private lastErrorNoticeAt = 0;
  private readonly discussionSessions = new Map<string, DiscussionSession>();
  private discussionController: AbortController | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.editorExtensions = [
      ...inlineSuggestionExtension(
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
      ),
      ...discussionExtension,
    ];

    this.registerEditorExtension(this.editorExtensions);
    this.addSettingTab(new AIAutocompleteSettingTab(this.app, this));
    this.registerCommands();
  }

  onunload(): void {
    this.discussionController?.abort();
    this.discussionController = null;
    this.discussionSessions.clear();
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
      id: "ask-selection",
      name: "Ask / continue discussion about selection",
      editorCallback: (editor) => void this.askSelection(editor),
    });

    this.addCommand({
      id: "new-discussion",
      name: "Start new discussion for current note",
      editorCallback: (editor) => this.newDiscussion(editor),
    });

    this.addCommand({
      id: "accept-discussion",
      name: "Accept discussion answer",
      editorCallback: (editor) => withView(editor, acceptDiscussionAnswer),
    });

    this.addCommand({
      id: "dismiss-discussion",
      name: "Dismiss discussion answer",
      editorCallback: (editor) => withView(editor, dismissDiscussionAnswer),
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
    const loaded = ((await this.loadData()) ?? {}) as LegacySettings;

    const legacyPrompt = loaded.systemPrompt?.trim();
    const promptTemplates = normalizeTemplates(
      loaded.promptTemplates,
      legacyPrompt || DEFAULT_SYSTEM_PROMPT
    );

    const activePromptTemplateId = promptTemplates.some(
      (template) => template.id === loaded.activePromptTemplateId
    )
      ? (loaded.activePromptTemplateId as string)
      : promptTemplates[0].id;

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      autoEnabled: loaded.autoEnabled ?? loaded.enabled ?? true,
      eagerness: normalizeEagerness(loaded.eagerness ?? 3),
      completionReasoningEffort: normalizeReasoningEffort(
        loaded.completionReasoningEffort
      ),
      discussionReasoningEffort: normalizeReasoningEffort(
        loaded.discussionReasoningEffort
      ),
      promptTemplates,
      activePromptTemplateId,
      discussionPrompt:
        loaded.discussionPrompt?.trim() || DEFAULT_DISCUSSION_PROMPT,
    };
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
    return (
      this.settings.promptTemplates.find(
        (template) => template.id === this.settings.activePromptTemplateId
      ) ?? this.settings.promptTemplates[0]
    );
  }

  getCompletionOptions(): CompletionRequestOptions {
    return {
      apiKey: this.settings.apiKey,
      model: this.settings.model,
      baseUrl: this.settings.baseUrl,
      systemPrompt: this.getActivePromptTemplate().prompt,
      temperature: this.settings.temperature,
      maxTokens: this.settings.maxTokens,
      reasoningEffort: this.settings.completionReasoningEffort,
    };
  }

  getDiscussionOptions(): CompletionRequestOptions {
    return {
      apiKey: this.settings.apiKey,
      model: this.settings.model,
      baseUrl: this.settings.baseUrl,
      temperature: this.settings.temperature,
      maxTokens: this.settings.discussionMaxTokens,
      reasoningEffort: this.settings.discussionReasoningEffort,
    };
  }

  private async askSelection(editor: Editor): Promise<void> {
    const view = cmOf(editor);
    if (!view) return;

    const selection = view.state.selection.main;
    if (selection.empty) {
      new Notice("AI autocomplete: select a question or passage first");
      return;
    }

    const question = view.state.doc
      .sliceString(selection.from, selection.to)
      .trim();
    if (!question) return;

    clearAllSuggestions();
    dismissDiscussionAnswer(view);

    const noteKey = this.currentNoteKey();
    const session = this.getDiscussionSession(noteKey);
    const doc = view.state.doc;
    const lineEnd = doc.lineAt(selection.to).to;
    const context = doc.sliceString(
      Math.max(0, selection.from - DISCUSSION_CONTEXT_BEFORE),
      Math.min(doc.length, selection.to + DISCUSSION_CONTEXT_AFTER)
    );

    this.discussionController?.abort();
    const controller = new AbortController();
    this.discussionController = controller;

    const messages: ChatMessage[] = [
      { role: "system", content: this.settings.discussionPrompt },
      ...session.turns.map((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
      {
        role: "user",
        content: `<note_context>\n${context}\n</note_context>\n\n<selected>\n${question}\n</selected>\n\nRespond to the selected question or passage. Use the note context and earlier discussion only when relevant.`,
      },
    ];

    try {
      const result = await fetchChatCompletion(
        this.getDiscussionOptions(),
        messages,
        controller.signal
      );
      if (controller.signal.aborted || !result?.trim()) return;

      const answer = result.trim();
      session.turns.push({ role: "user", content: question });
      session.turns.push({ role: "assistant", content: answer });
      if (session.turns.length > MAX_DISCUSSION_TURNS) {
        session.turns.splice(0, session.turns.length - MAX_DISCUSSION_TURNS);
      }

      if (view.state.doc !== doc) return;
      showDiscussionAnswer(view, lineEnd, answer);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      this.showCompletionError(error);
    } finally {
      if (this.discussionController === controller) {
        this.discussionController = null;
      }
    }
  }

  private newDiscussion(editor: Editor): void {
    const view = cmOf(editor);
    if (view) dismissDiscussionAnswer(view);
    this.discussionController?.abort();
    this.discussionController = null;
    this.discussionSessions.delete(this.currentNoteKey());
    new Notice("AI autocomplete: started a new discussion");
  }

  private currentNoteKey(): string {
    return this.app.workspace.getActiveFile()?.path ?? "__active-editor__";
  }

  private getDiscussionSession(noteKey: string): DiscussionSession {
    let session = this.discussionSessions.get(noteKey);
    if (!session) {
      session = { turns: [] };
      this.discussionSessions.set(noteKey, session);
    }
    return session;
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

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc(
        "OpenAI-compatible API root, for example https://api.openai.com/v1. /chat/completions is appended automatically."
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
      .setName("API key")
      .setDesc("Optional for local providers that do not require authentication.")
      .addText((text) => {
        text
          .setPlaceholder("sk-…")
          .setValue(settings.apiKey)
          .onChange(async (value) => {
            settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Exact model name accepted by your provider.")
      .addText((text) =>
        text
          .setPlaceholder("gpt-4o-mini")
          .setValue(settings.model)
          .onChange(async (value) => {
            settings.model = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Connection")
      .setDesc("Send a small completion request using the current settings.")
      .addButton((button) =>
        button.setButtonText("Test").onClick(() => void this.plugin.testConnection())
      );

    new Setting(containerEl).setName("Completion").setHeading();

    addReasoningSetting(
      containerEl,
      "Completion reasoning",
      "Provider default sends no reasoning_effort field. Low/none are usually best for latency-sensitive autocomplete.",
      settings.completionReasoningEffort,
      async (value) => {
        settings.completionReasoningEffort = value;
        await this.plugin.saveSettings();
      }
    );

    new Setting(containerEl)
      .setName("Maximum tokens")
      .setDesc("Keep this low for fast, concise inline suggestions.")
      .addSlider((slider) =>
        slider
          .setLimits(32, 256, 16)
          .setValue(settings.maxTokens)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.maxTokens = value;
            await this.plugin.saveSettings();
          })
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
        dropdown
          .setValue(activeTemplate.id)
          .onChange(async (value) => {
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
        text
          .setValue(activeTemplate.name)
          .onChange(async (value) => {
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

    new Setting(containerEl).setName("Discussion").setHeading();

    new Setting(containerEl)
      .setName("Ask / continue discussion")
      .setDesc(
        "Select text, then run “AI Autocomplete: Ask / continue discussion about selection”. Assign a shortcut in Obsidian Settings → Hotkeys."
      );

    new Setting(containerEl)
      .setName("Session behavior")
      .setDesc(
        "Discussion remembers a short Q/A history per note for the current Obsidian session. Autocomplete never uses this history."
      );

    addReasoningSetting(
      containerEl,
      "Discussion reasoning",
      "Provider default sends no reasoning_effort field. Use medium/high only when the configured provider supports it.",
      settings.discussionReasoningEffort,
      async (value) => {
        settings.discussionReasoningEffort = value;
        await this.plugin.saveSettings();
      }
    );

    new Setting(containerEl)
      .setName("Discussion maximum tokens")
      .setDesc("Discussion answers can be longer than inline completions.")
      .addSlider((slider) =>
        slider
          .setLimits(128, 1024, 64)
          .setValue(settings.discussionMaxTokens)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.discussionMaxTokens = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Discussion prompt")
      .setDesc("System prompt used only for selected-text discussions.")
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
      .setDesc("Restore the built-in concise discussion prompt.")
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
        .addOption("none", "None")
        .addOption("low", "Low")
        .addOption("medium", "Medium")
        .addOption("high", "High")
        .setValue(value)
        .onChange(async (next) => {
          await onChange(normalizeReasoningEffort(next));
        })
    );
}

function normalizeTemplates(
  templates: PromptTemplate[] | undefined,
  fallbackPrompt: string
): PromptTemplate[] {
  if (!Array.isArray(templates) || templates.length === 0) {
    return [
      {
        id: DEFAULT_TEMPLATE_ID,
        name: "Default",
        prompt: fallbackPrompt,
      },
    ];
  }

  const valid = templates
    .filter(
      (template) =>
        template &&
        typeof template.id === "string" &&
        typeof template.name === "string" &&
        typeof template.prompt === "string"
    )
    .map((template) => ({ ...template }));

  return valid.length > 0
    ? valid
    : [
        {
          id: DEFAULT_TEMPLATE_ID,
          name: "Default",
          prompt: fallbackPrompt,
        },
      ];
}

function normalizeEagerness(value: number): number {
  return Math.min(5, Math.max(1, Math.round(value)));
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  return value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
    ? value
    : "";
}

function createTemplateId(): string {
  return `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function uniqueTemplateName(
  templates: PromptTemplate[],
  preferredName: string
): string {
  const names = new Set(templates.map((template) => template.name));
  if (!names.has(preferredName)) return preferredName;

  let index = 2;
  while (names.has(`${preferredName} ${index}`)) index += 1;
  return `${preferredName} ${index}`;
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
