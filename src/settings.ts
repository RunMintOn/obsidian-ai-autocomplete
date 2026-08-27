import {
  DEFAULT_DISCUSSION_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  type ReasoningEffort,
} from "./ai-client";

export type UiLanguage = "zh" | "en";

export interface PromptTemplate {
  id: string;
  name: string;
  prompt: string;
}

export interface AIAutocompleteSettings {
  uiLanguage: UiLanguage;
  autoEnabled: boolean;
  eagerness: number;
  providerId: string;
  providerApiKeys: Record<string, string>;
  providerModels: Record<string, string>;
  discussionProviderModels: Record<string, string>;
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
  apiKey?: string;
  model?: string;
};

export const DEFAULT_API_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_TEMPLATE_ID = "default";

export const DEFAULT_SETTINGS: AIAutocompleteSettings = {
  uiLanguage: "zh",
  autoEnabled: true,
  eagerness: 3,
  providerId: "openai",
  providerApiKeys: {},
  providerModels: { openai: "gpt-4o-mini" },
  discussionProviderModels: { openai: "gpt-4o-mini" },
  baseUrl: DEFAULT_API_BASE_URL,
  temperature: 0.2,
  maxTokens: 256,
  discussionMaxTokens: 4096,
  completionReasoningEffort: "",
  discussionReasoningEffort: "",
  maxPrefixChars: 2400,
  maxSuffixChars: 600,
  promptTemplates: [
    {
      id: DEFAULT_TEMPLATE_ID,
      name: "默认",
      prompt: DEFAULT_SYSTEM_PROMPT,
    },
  ],
  activePromptTemplateId: DEFAULT_TEMPLATE_ID,
  discussionPrompt: DEFAULT_DISCUSSION_PROMPT,
};

export function normalizeLoadedSettings(raw: unknown): AIAutocompleteSettings {
  const loaded = (raw ?? {}) as LegacySettings;
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

  const baseUrl = loaded.baseUrl?.trim() || DEFAULT_API_BASE_URL;
  const providerId =
    loaded.providerId?.trim() ||
    (normalizeUrl(baseUrl) === normalizeUrl(DEFAULT_API_BASE_URL)
      ? "openai"
      : "custom");

  const providerApiKeys = normalizeStringMap(loaded.providerApiKeys);
  const providerModels = {
    ...DEFAULT_SETTINGS.providerModels,
    ...normalizeStringMap(loaded.providerModels),
  };

  if (loaded.apiKey?.trim() && !providerApiKeys[providerId]) {
    providerApiKeys[providerId] = loaded.apiKey.trim();
  }
  if (loaded.model?.trim() && !providerModels[providerId]) {
    providerModels[providerId] = loaded.model.trim();
  }

  const discussionProviderModels = {
    ...providerModels,
    ...normalizeStringMap(loaded.discussionProviderModels),
  };

  return {
    uiLanguage: loaded.uiLanguage === "en" ? "en" : "zh",
    autoEnabled: loaded.autoEnabled ?? loaded.enabled ?? DEFAULT_SETTINGS.autoEnabled,
    eagerness: normalizeEagerness(loaded.eagerness ?? DEFAULT_SETTINGS.eagerness),
    providerId,
    providerApiKeys,
    providerModels,
    discussionProviderModels,
    baseUrl,
    temperature:
      typeof loaded.temperature === "number"
        ? loaded.temperature
        : DEFAULT_SETTINGS.temperature,
    maxTokens: normalizeTokenBudget(loaded.maxTokens, DEFAULT_SETTINGS.maxTokens),
    discussionMaxTokens: normalizeTokenBudget(
      loaded.discussionMaxTokens,
      DEFAULT_SETTINGS.discussionMaxTokens
    ),
    completionReasoningEffort: normalizeReasoningEffort(
      loaded.completionReasoningEffort
    ),
    discussionReasoningEffort: normalizeReasoningEffort(
      loaded.discussionReasoningEffort
    ),
    maxPrefixChars:
      typeof loaded.maxPrefixChars === "number"
        ? loaded.maxPrefixChars
        : DEFAULT_SETTINGS.maxPrefixChars,
    maxSuffixChars:
      typeof loaded.maxSuffixChars === "number"
        ? loaded.maxSuffixChars
        : DEFAULT_SETTINGS.maxSuffixChars,
    promptTemplates,
    activePromptTemplateId,
    discussionPrompt: migrateDiscussionPrompt(loaded.discussionPrompt),
  };
}

export function getActivePromptTemplate(
  settings: AIAutocompleteSettings
): PromptTemplate {
  return (
    settings.promptTemplates.find(
      (template) => template.id === settings.activePromptTemplateId
    ) ?? settings.promptTemplates[0]
  );
}

export function getProviderApiKey(settings: AIAutocompleteSettings): string {
  return settings.providerApiKeys[settings.providerId] ?? "";
}

export function setProviderApiKey(
  settings: AIAutocompleteSettings,
  value: string
): void {
  settings.providerApiKeys = {
    ...settings.providerApiKeys,
    [settings.providerId]: value,
  };
}

/** Completion model for the active provider. */
export function getProviderModel(settings: AIAutocompleteSettings): string {
  return settings.providerModels[settings.providerId] ?? "";
}

export function setProviderModel(
  settings: AIAutocompleteSettings,
  value: string
): void {
  settings.providerModels = {
    ...settings.providerModels,
    [settings.providerId]: value,
  };
}

/** Discussion model is intentionally separate from inline completion. */
export function getDiscussionProviderModel(
  settings: AIAutocompleteSettings
): string {
  return (
    settings.discussionProviderModels[settings.providerId] ??
    getProviderModel(settings)
  );
}

export function setDiscussionProviderModel(
  settings: AIAutocompleteSettings,
  value: string
): void {
  settings.discussionProviderModels = {
    ...settings.discussionProviderModels,
    [settings.providerId]: value,
  };
}

export function normalizeEagerness(value: number): number {
  return Math.min(5, Math.max(1, Math.round(value)));
}

export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  if (value === "none") return "minimal"; // migrate the old ambiguous label
  return value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
    ? value
    : "";
}

export function normalizeTokenBudget(
  value: unknown,
  fallback: number
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(65536, Math.max(16, Math.round(parsed)));
}

export function createTemplateId(): string {
  return `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function uniqueTemplateName(
  templates: PromptTemplate[],
  preferredName: string
): string {
  const names = new Set(templates.map((template) => template.name));
  if (!names.has(preferredName)) return preferredName;

  let index = 2;
  while (names.has(`${preferredName} ${index}`)) index += 1;
  return `${preferredName} ${index}`;
}

function normalizeTemplates(
  templates: PromptTemplate[] | undefined,
  fallbackPrompt: string
): PromptTemplate[] {
  if (!Array.isArray(templates) || templates.length === 0) {
    return [
      {
        id: DEFAULT_TEMPLATE_ID,
        name: "默认",
        prompt: migrateCompletionPrompt(fallbackPrompt),
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
    .map((template) => ({
      ...template,
      name:
        template.id === DEFAULT_TEMPLATE_ID && template.name === "Default"
          ? "默认"
          : template.name,
      prompt:
        template.id === DEFAULT_TEMPLATE_ID
          ? migrateCompletionPrompt(template.prompt)
          : template.prompt,
    }));

  return valid.length > 0
    ? valid
    : [
        {
          id: DEFAULT_TEMPLATE_ID,
          name: "默认",
          prompt: migrateCompletionPrompt(fallbackPrompt),
        },
      ];
}

function migrateCompletionPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (
    trimmed.startsWith(
      "You are an inline completion engine inside the Obsidian Markdown editor."
    ) && trimmed.includes("NO_SUGGESTION")
  ) {
    return DEFAULT_SYSTEM_PROMPT;
  }
  return prompt || DEFAULT_SYSTEM_PROMPT;
}

function migrateDiscussionPrompt(prompt: string | undefined): string {
  const trimmed = prompt?.trim() ?? "";
  if (!trimmed) return DEFAULT_DISCUSSION_PROMPT;
  if (trimmed.startsWith("You are a concise thinking partner inside Obsidian.")) {
    return DEFAULT_DISCUSSION_PROMPT;
  }
  return prompt as string;
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") output[key] = entry;
  }
  return output;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
