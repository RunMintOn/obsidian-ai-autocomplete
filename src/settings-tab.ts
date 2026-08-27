import { App, PluginSettingTab, Setting } from "obsidian";
import {
  DEFAULT_DISCUSSION_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  getProviderModels,
  getProviderOptions,
  type ReasoningEffort,
} from "./ai-client";
import { tr } from "./i18n";
import {
  type AIAutocompleteSettings,
  createTemplateId,
  DEFAULT_API_BASE_URL,
  getActivePromptTemplate,
  getDiscussionProviderModel,
  getProviderApiKey,
  getProviderModel,
  normalizeEagerness,
  normalizeReasoningEffort,
  normalizeTokenBudget,
  setDiscussionProviderModel,
  setProviderApiKey,
  setProviderModel,
  type PromptTemplate,
  uniqueTemplateName,
} from "./settings";

export interface SettingsHost {
  settings: AIAutocompleteSettings;
  saveSettings(): Promise<void>;
  testConnection(): Promise<void>;
  onSettingsChanged?(): void;
}

export class AIAutocompleteSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: SettingsHost) {
    super(app, host as never);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.host.settings;
    const l = (zh: string, en: string) => tr(settings.uiLanguage, zh, en);

    new Setting(containerEl).setName(l("界面", "Interface")).setHeading();

    new Setting(containerEl)
      .setName(l("界面语言", "Interface language"))
      .setDesc(
        l(
          "开发阶段默认中文；英文界面保留。命令面板中的名称在重载插件后会切换语言。",
          "Chinese is the development default; English remains available. Command names update after the plugin reloads."
        )
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("zh", "中文")
          .addOption("en", "English")
          .setValue(settings.uiLanguage)
          .onChange(async (value) => {
            settings.uiLanguage = value === "en" ? "en" : "zh";
            await this.host.saveSettings();
            this.host.onSettingsChanged?.();
            this.display();
          })
      );

    new Setting(containerEl).setName(l("通用", "General")).setHeading();

    new Setting(containerEl)
      .setName(l("自动补全", "Automatic completion"))
      .setDesc(
        l(
          "暂停输入后自动显示补全。关闭后仍可使用手动触发命令。",
          "Show suggestions after you pause typing. Manual trigger still works when disabled."
        )
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.autoEnabled).onChange(async (value) => {
          settings.autoEnabled = value;
          await this.host.saveSettings();
          this.host.onSettingsChanged?.();
        })
      );

    new Setting(containerEl)
      .setName(l("触发积极度", "Eagerness"))
      .setDesc(
        l(
          "1 更克制，3 平衡，5 更积极。只影响自动触发，不改变模型参数。",
          "1 is conservative, 3 balanced, 5 eager. This only changes automatic triggering."
        )
      )
      .addSlider((slider) =>
        slider
          .setLimits(1, 5, 1)
          .setValue(settings.eagerness)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.eagerness = normalizeEagerness(value);
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(l("手动触发", "Manual trigger"))
      .setDesc(
        l(
          "命令：AI Autocomplete: 手动触发行内补全。快捷键请在 Obsidian 设置 → 快捷键中配置。",
          "Command: AI Autocomplete: Trigger inline suggestion. Configure the shortcut in Obsidian Settings → Hotkeys."
        )
      );

    new Setting(containerEl).setName("Provider").setHeading();

    const providers = getProviderOptions();
    const selectedProvider =
      providers.find((provider) => provider.id === settings.providerId) ?? providers[0];

    new Setting(containerEl)
      .setName("Provider")
      .setDesc(
        l(
          "内置 Provider 和模型目录来自 pi-ai；只有自己的 OpenAI-compatible 地址才选 Custom。",
          "Built-in providers and model catalogs come from pi-ai. Use Custom only for your own OpenAI-compatible endpoint."
        )
      )
      .addDropdown((dropdown) => {
        for (const provider of providers) dropdown.addOption(provider.id, provider.name);
        dropdown.setValue(settings.providerId).onChange(async (value) => {
          settings.providerId = value;
          ensureModels(settings);
          await this.host.saveSettings();
          this.host.onSettingsChanged?.();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc(
        l(
          `单独保存给 ${selectedProvider.name}。`,
          `Stored separately for ${selectedProvider.name}.`
        )
      )
      .addText((text) => {
        text
          .setPlaceholder("API key")
          .setValue(getProviderApiKey(settings))
          .onChange(async (value) => {
            setProviderApiKey(settings, value.trim());
            await this.host.saveSettings();
          });
        text.inputEl.type = "password";
      });

    if (settings.providerId === "custom") {
      new Setting(containerEl)
        .setName("API Base URL")
        .setDesc(
          l(
            "例如 http://127.0.0.1:18180/v1。",
            "For example http://127.0.0.1:18180/v1."
          )
        )
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_API_BASE_URL)
            .setValue(settings.baseUrl)
            .onChange(async (value) => {
              settings.baseUrl = value.trim();
              await this.host.saveSettings();
            })
        );

      addTextModelSetting(
        containerEl,
        l("补全模型", "Completion model"),
        getProviderModel(settings),
        async (value) => {
          setProviderModel(settings, value);
          await this.host.saveSettings();
        }
      );
      addTextModelSetting(
        containerEl,
        l("讨论模型", "Discussion model"),
        getDiscussionProviderModel(settings),
        async (value) => {
          setDiscussionProviderModel(settings, value);
          await this.host.saveSettings();
          this.host.onSettingsChanged?.();
        }
      );
    } else {
      const models = getProviderModels(settings.providerId);
      addCatalogModelSetting(
        containerEl,
        l("补全模型", "Completion model"),
        models,
        getProviderModel(settings),
        async (value) => {
          setProviderModel(settings, value);
          await this.host.saveSettings();
        }
      );
      addCatalogModelSetting(
        containerEl,
        l("讨论模型", "Discussion model"),
        models,
        getDiscussionProviderModel(settings),
        async (value) => {
          setDiscussionProviderModel(settings, value);
          await this.host.saveSettings();
          this.host.onSettingsChanged?.();
        }
      );
    }

    new Setting(containerEl)
      .setName(l("连接测试", "Connection test"))
      .setDesc(l("使用当前补全模型发送一个小请求。", "Send a small request with the current completion model."))
      .addButton((button) =>
        button.setButtonText(l("测试", "Test")).onClick(() => void this.host.testConnection())
      );

    new Setting(containerEl).setName(l("行内补全", "Inline completion")).setHeading();

    addReasoningSetting(
      containerEl,
      settings,
      l("补全思考等级", "Completion reasoning"),
      settings.completionReasoningEffort,
      async (value) => {
        settings.completionReasoningEffort = value;
        await this.host.saveSettings();
      }
    );

    addTokenBudgetSetting(
      containerEl,
      l("最大输出 Token", "Maximum output tokens"),
      l(
        "包含模型的 reasoning token。可直接输入 16–65536。",
        "Includes reasoning tokens. Enter any value from 16–65536."
      ),
      settings.maxTokens,
      async (value) => {
        settings.maxTokens = value;
        await this.host.saveSettings();
      }
    );

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc(l("越低越稳定。", "Lower values are more stable."))
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.1)
          .setValue(settings.temperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.temperature = value;
            await this.host.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(l("补全提示词模板", "Completion prompt templates"))
      .setHeading();

    const activeTemplate = getActivePromptTemplate(settings);

    new Setting(containerEl)
      .setName(l("当前模板", "Active template"))
      .addDropdown((dropdown) => {
        for (const template of settings.promptTemplates) {
          dropdown.addOption(template.id, template.name);
        }
        dropdown.setValue(activeTemplate.id).onChange(async (value) => {
          settings.activePromptTemplateId = value;
          await this.host.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName(l("模板操作", "Template actions"))
      .addButton((button) =>
        button.setButtonText(l("新建", "New")).onClick(async () => {
          const template: PromptTemplate = {
            id: createTemplateId(),
            name: uniqueTemplateName(
              settings.promptTemplates,
              l("新模板", "New template")
            ),
            prompt: DEFAULT_SYSTEM_PROMPT,
          };
          settings.promptTemplates.push(template);
          settings.activePromptTemplateId = template.id;
          await this.host.saveSettings();
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText(l("复制", "Duplicate")).onClick(async () => {
          const template: PromptTemplate = {
            id: createTemplateId(),
            name: uniqueTemplateName(
              settings.promptTemplates,
              `${activeTemplate.name}${l(" 副本", " copy")}`
            ),
            prompt: activeTemplate.prompt,
          };
          settings.promptTemplates.push(template);
          settings.activePromptTemplateId = template.id;
          await this.host.saveSettings();
          this.display();
        })
      )
      .addButton((button) =>
        button
          .setButtonText(l("删除", "Delete"))
          .setDisabled(settings.promptTemplates.length <= 1)
          .onClick(async () => {
            if (settings.promptTemplates.length <= 1) return;
            settings.promptTemplates = settings.promptTemplates.filter(
              (template) => template.id !== activeTemplate.id
            );
            settings.activePromptTemplateId = settings.promptTemplates[0].id;
            await this.host.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(l("模板名称", "Template name"))
      .addText((text) =>
        text.setValue(activeTemplate.name).onChange(async (value) => {
          const trimmed = value.trim();
          if (!trimmed) return;
          activeTemplate.name = trimmed;
          await this.host.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(l("System Prompt", "System prompt"))
      .setDesc(l("当前内置默认提示词以中文维护。", "The built-in default prompt is currently maintained in Chinese."))
      .addTextArea((text) => {
        text.inputEl.rows = 14;
        text.inputEl.cols = 60;
        text.setValue(activeTemplate.prompt).onChange(async (value) => {
          activeTemplate.prompt = value;
          await this.host.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(l("重置当前模板", "Reset current template"))
      .addButton((button) =>
        button.setButtonText(l("恢复默认", "Reset prompt")).onClick(async () => {
          activeTemplate.prompt = DEFAULT_SYSTEM_PROMPT;
          await this.host.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl).setName(l("讨论侧栏", "Discussion sidebar")).setHeading();

    addReasoningSetting(
      containerEl,
      settings,
      l("讨论思考等级", "Discussion reasoning"),
      settings.discussionReasoningEffort,
      async (value) => {
        settings.discussionReasoningEffort = value;
        await this.host.saveSettings();
        this.host.onSettingsChanged?.();
      }
    );

    addTokenBudgetSetting(
      containerEl,
      l("讨论输出 Token", "Discussion output tokens"),
      l(
        "包含思考 Token；侧栏输入框附近也可以快速修改。",
        "Includes reasoning tokens; it can also be changed beside the sidebar composer."
      ),
      settings.discussionMaxTokens,
      async (value) => {
        settings.discussionMaxTokens = value;
        await this.host.saveSettings();
        this.host.onSettingsChanged?.();
      }
    );

    new Setting(containerEl)
      .setName(l("讨论 System Prompt", "Discussion system prompt"))
      .setDesc(l("目前内置默认提示词先以中文维护。", "The built-in discussion prompt is currently maintained in Chinese."))
      .addTextArea((text) => {
        text.inputEl.rows = 12;
        text.inputEl.cols = 60;
        text.setValue(settings.discussionPrompt).onChange(async (value) => {
          settings.discussionPrompt = value;
          await this.host.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(l("重置讨论提示词", "Reset discussion prompt"))
      .addButton((button) =>
        button.setButtonText(l("恢复默认", "Reset prompt")).onClick(async () => {
          settings.discussionPrompt = DEFAULT_DISCUSSION_PROMPT;
          await this.host.saveSettings();
          this.display();
        })
      );
  }
}

function addReasoningSetting(
  containerEl: HTMLElement,
  settings: AIAutocompleteSettings,
  name: string,
  value: ReasoningEffort,
  onChange: (value: ReasoningEffort) => Promise<void>
): void {
  const l = (zh: string, en: string) => tr(settings.uiLanguage, zh, en);
  new Setting(containerEl)
    .setName(name)
    .setDesc(reasoningDescription(settings, value))
    .addDropdown((dropdown) =>
      dropdown
        .addOption("", l("由 Provider 决定（不传）", "Provider default (do not send)"))
        .addOption("minimal", "Minimal")
        .addOption("low", "Low")
        .addOption("medium", "Medium")
        .addOption("high", "High")
        .setValue(value)
        .onChange(async (next) => {
          await onChange(normalizeReasoningEffort(next));
        })
    );
}

function reasoningDescription(
  settings: AIAutocompleteSettings,
  value: ReasoningEffort
): string {
  const l = (zh: string, en: string) => tr(settings.uiLanguage, zh, en);
  if (!value) {
    return l(
      "不向 pi-ai 传 reasoning 字段，由 Provider/模型使用自己的默认行为。",
      "No reasoning level is passed to pi-ai; the provider/model uses its default behavior."
    );
  }
  if (settings.providerId === "custom" && value === "minimal") {
    return l(
      "向 pi-ai 传 reasoning=minimal；当前 Custom OpenAI-compatible 映射为 reasoning_effort=none。",
      "Sends reasoning=minimal to pi-ai; the current Custom OpenAI-compatible mapping emits reasoning_effort=none."
    );
  }
  return l(
    `向 pi-ai 传 reasoning=${value}；具体 HTTP 字段由 ${settings.providerId} adapter 映射。`,
    `Sends reasoning=${value} to pi-ai; the ${settings.providerId} adapter maps it to the provider-specific HTTP field.`
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
        text.inputEl.value = String(normalizeTokenBudget(text.inputEl.value, value));
      });
    });
}

function addTextModelSetting(
  containerEl: HTMLElement,
  name: string,
  value: string,
  onChange: (value: string) => Promise<void>
): void {
  new Setting(containerEl).setName(name).addText((text) =>
    text.setValue(value).onChange(async (next) => {
      const trimmed = next.trim();
      if (trimmed) await onChange(trimmed);
    })
  );
}

function addCatalogModelSetting(
  containerEl: HTMLElement,
  name: string,
  models: ReturnType<typeof getProviderModels>,
  value: string,
  onChange: (value: string) => Promise<void>
): void {
  new Setting(containerEl).setName(name).addDropdown((dropdown) => {
    if (value && !models.some((model) => model.id === value)) {
      dropdown.addOption(value, `${value} *`);
    }
    for (const model of models) dropdown.addOption(model.id, model.name);
    dropdown.setValue(value).onChange(onChange);
  });
}

function ensureModels(settings: AIAutocompleteSettings): void {
  if (settings.providerId === "custom") return;
  const models = getProviderModels(settings.providerId);
  if (models.length === 0) return;
  if (!models.some((model) => model.id === getProviderModel(settings))) {
    setProviderModel(settings, models[0].id);
  }
  if (!models.some((model) => model.id === getDiscussionProviderModel(settings))) {
    setDiscussionProviderModel(settings, getProviderModel(settings));
  }
}
