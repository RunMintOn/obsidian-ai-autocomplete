import {
  DEFAULT_DISCUSSION_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  type ReasoningEffort,
} from "./ai-client.js";

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
export const MIN_TOKEN_BUDGET = 16;
export const MAX_TOKEN_BUDGET = 65536;

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
  promptTemplates: [createDefaultTemplate(DEFAULT_SYSTEM_PROMPT)],
  activePromptTemplateId: DEFAULT_TEMPLATE_ID,
  discussionPrompt: DEFAULT_DISCUSSION_PROMPT,
};

export function normalizeLoadedSettings(raw: unknown): AIAutocompleteSettings {
  const loaded = (raw ?? {}) as LegacySettings;
  const legacyPrompt = loaded.systemPrompt?.trim();
  const fallbackPrompt = legacyPrompt || DEFAULT_SYSTEM_PROMPT;
  const promptTemplates = normalizeTemplates(loaded.promptTemplates, fallbackPrompt);
  const activePromptTemplateId = resolveActiveTemplateId(
    promptTemplates,
    loaded.activePromptTemplateId
  );
  const baseUrl = loaded.baseUrl?.trim() || DEFAULT_API_BASE_URL;
  const providerId = resolveProviderId(loaded.providerId, baseUrl);

  const providerApiKeys = normalizeStringMap(loaded.providerApiKeys);
  const providerModels = {
    ...DEFAULT_SETTINGS.providerModels,
    ...normalizeStringMap(loaded.providerModels),
  };

  const legacyApiKey = loaded.apiKey?.trim();
  if (legacyApiKey && !providerApiKeys[providerId]) {
    providerApiKeys[providerId] = legacyApiKey;
  }

  const legacyModel = loaded.model?.trim();
  if (legacyModel && !providerModels[providerId]) {
    providerModels[providerId] = legacyModel;
  }

  const discussionProviderModels = {
    ...providerModels,
    ...normalizeStringMap(loaded.discussionProviderModels),
  };

  return {
    uiLanguage: normalizeUiLanguage(loaded.uiLanguage),
    autoEnabled: loaded.autoEnabled ?? loaded.enabled ?? DEFAULT_SETTINGS.autoEnabled,
    eagerness: normalizeEagerness(loaded.eagerness ?? DEFAULT_SETTINGS.eagerness),
    providerId,
    providerApiKeys,
    providerModels,
    discussionProviderModels,
    baseUrl,
    temperature: numberOrDefault(loaded.temperature, DEFAULT_SETTINGS.temperature),
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
    maxPrefixChars: numberOrDefault(
      loaded.maxPrefixChars,
      DEFAULT_SETTINGS.maxPrefixChars
    ),
    maxSuffixChars: numberOrDefault(
      loaded.maxSuffixChars,
      DEFAULT_SETTINGS.maxSuffixChars
    ),
    promptTemplates,
    activePromptTemplateId,
    discussionPrompt: migrateDiscussionPrompt(loaded.discussionPrompt),
  };
}

export function getActivePromptTemplate(
  settings: AIAutocompleteSettings
): PromptTemplate {
  const activeTemplate = settings.promptTemplates.find(
    (template) => template.id === settings.activePromptTemplateId
  );
  return activeTemplate ?? settings.promptTemplates[0];
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
  switch (value) {
    case "none":
      return "minimal";
    case "minimal":
    case "low":
    case "medium":
    case "high":
      return value;
    default:
      return "";
  }
}

export function normalizeTokenBudget(
  value: unknown,
  fallback: number
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(
    MAX_TOKEN_BUDGET,
    Math.max(MIN_TOKEN_BUDGET, Math.round(parsed))
  );
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

function normalizeUiLanguage(value: UiLanguage | undefined): UiLanguage {
  if (value === "en") return "en";
  return "zh";
}

function numberOrDefault(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  return fallback;
}

function resolveActiveTemplateId(
  templates: PromptTemplate[],
  requestedId: string | undefined
): string {
  if (requestedId && templates.some((template) => template.id === requestedId)) {
    return requestedId;
  }
  return templates[0].id;
}

function resolveProviderId(
  configuredProviderId: string | undefined,
  baseUrl: string
): string {
  const providerId = configuredProviderId?.trim();
  if (providerId) return providerId;

  if (normalizeUrl(baseUrl) === normalizeUrl(DEFAULT_API_BASE_URL)) {
    return "openai";
  }
  return "custom";
}

function normalizeTemplates(
  templates: PromptTemplate[] | undefined,
  fallbackPrompt: string
): PromptTemplate[] {
  if (!Array.isArray(templates) || templates.length === 0) {
    return [createDefaultTemplate(fallbackPrompt)];
  }

  const validTemplates: PromptTemplate[] = [];
  for (const template of templates) {
    if (!isPromptTemplate(template)) continue;

    let name = template.name;
    let prompt = template.prompt;
    if (template.id === DEFAULT_TEMPLATE_ID) {
      if (name === "Default") name = "默认";
      prompt = migrateCompletionPrompt(prompt);
    }

    validTemplates.push({ ...template, name, prompt });
  }

  if (validTemplates.length === 0) {
    return [createDefaultTemplate(fallbackPrompt)];
  }
  return validTemplates;
}

function isPromptTemplate(template: PromptTemplate | null | undefined): boolean {
  return Boolean(
    template &&
      typeof template.id === "string" &&
      typeof template.name === "string" &&
      typeof template.prompt === "string"
  );
}

function createDefaultTemplate(prompt: string): PromptTemplate {
  return {
    id: DEFAULT_TEMPLATE_ID,
    name: "默认",
    prompt: migrateCompletionPrompt(prompt),
  };
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
  if (prompt === undefined) return DEFAULT_DISCUSSION_PROMPT;

  const trimmed = prompt.trim();
  if (!trimmed) return DEFAULT_DISCUSSION_PROMPT;
  if (trimmed.startsWith("You are a concise thinking partner inside Obsidian.")) {
    return DEFAULT_DISCUSSION_PROMPT;
  }
  return prompt;
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
