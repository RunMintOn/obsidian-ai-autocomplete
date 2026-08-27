import {
  App,
  Editor,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import {
  acceptSuggestion,
  acceptSuggestionSegment,
  dismissSuggestion,
  getSuggestionManager,
  inlineSuggestionExtension,
  type InlineSuggestionConfig,
} from "./ghost-text";
import {
  CompletionError,
  type CompletionRequestOptions,
  DEFAULT_API_BASE_URL,
  DEFAULT_SYSTEM_PROMPT,
  fetchCompletion,
} from "./openai-client";

interface AIAutocompleteSettings {
  enabled: boolean;
  apiKey: string;
  model: string;
  baseUrl: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  delay: number;
  minPrefixChars: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
}

const DEFAULT_SETTINGS: AIAutocompleteSettings = {
  enabled: true,
  apiKey: "",
  model: "gpt-4o-mini",
  baseUrl: DEFAULT_API_BASE_URL,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  temperature: 0.2,
  maxTokens: 96,
  delay: 650,
  minPrefixChars: 3,
  maxPrefixChars: 2400,
  maxSuffixChars: 600,
};

export default class AIAutocompletePlugin extends Plugin {
  settings: AIAutocompleteSettings = DEFAULT_SETTINGS;
  private editorExtensions: Extension[] = [];
  private lastErrorNoticeAt = 0;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.editorExtensions = inlineSuggestionExtension(
      async ({ prefix, suffix, signal }) => {
        if (!this.settings.enabled) return null;
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
    this.addSettingTab(new AIAutocompleteSettingTab(this.app, this));
    this.registerCommands();
  }

  private registerCommands(): void {
    this.addCommand({
      id: "trigger",
      name: "Trigger inline suggestion",
      editorCallback: (editor) => {
        const view = cmOf(editor);
        if (view) void getSuggestionManager(view)?.request();
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
      id: "toggle",
      name: "Toggle auto-completion",
      callback: () => {
        this.settings.enabled = !this.settings.enabled;
        void this.saveSettings();
        new Notice(
          `AI autocomplete: ${this.settings.enabled ? "on" : "off"}`
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
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<AIAutocompleteSettings>
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getInlineConfig(): InlineSuggestionConfig {
    return {
      enabled: this.settings.enabled,
      delay: this.settings.delay,
      minPrefixChars: this.settings.minPrefixChars,
      maxPrefixChars: this.settings.maxPrefixChars,
      maxSuffixChars: this.settings.maxSuffixChars,
    };
  }

  getCompletionOptions(): CompletionRequestOptions {
    return {
      apiKey: this.settings.apiKey,
      model: this.settings.model,
      baseUrl: this.settings.baseUrl,
      systemPrompt: this.settings.systemPrompt,
      temperature: this.settings.temperature,
      maxTokens: this.settings.maxTokens,
    };
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

    new Setting(containerEl)
      .setName("Enabled")
      .setDesc("Show inline suggestions automatically while typing.")
      .addToggle((toggle) =>
        toggle.setValue(settings.enabled).onChange(async (value) => {
          settings.enabled = value;
          await this.plugin.saveSettings();
        })
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

    new Setting(containerEl)
      .setName("Trigger delay")
      .setDesc("Idle time after typing before requesting a suggestion.")
      .addSlider((slider) =>
        slider
          .setLimits(200, 2000, 50)
          .setValue(settings.delay)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.delay = value;
            await this.plugin.saveSettings();
          })
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

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Instructions used for every inline completion request.")
      .addTextArea((text) => {
        text.inputEl.rows = 12;
        text.inputEl.cols = 60;
        text
          .setPlaceholder(DEFAULT_SYSTEM_PROMPT)
          .setValue(settings.systemPrompt)
          .onChange(async (value) => {
            settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Reset prompt")
      .setDesc("Restore the built-in inline-completion prompt.")
      .addButton((button) =>
        button.setButtonText("Reset").onClick(async () => {
          settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
          await this.plugin.saveSettings();
          this.display();
        })
      );
  }
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
