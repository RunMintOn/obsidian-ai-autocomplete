import {
  contentText,
  createProvider,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { cerebrasProvider } from "@earendil-works/pi-ai/providers/cerebras";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { togetherProvider } from "@earendil-works/pi-ai/providers/together";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { providerFetch } from "./transport.js";

export const NO_SUGGESTION = "NO_SUGGESTION";

export const DEFAULT_SYSTEM_PROMPT = `你是 Obsidian Markdown 编辑器中的行内补全引擎。

你的任务是根据光标前后的内容，返回应该直接插入 <cursor> 位置的文本。

规则：
- 只输出补全文本，不要解释、加标签、加引号或复述问题。
- 保留直接插入所需要的前导空格和换行。
- 不要重复光标前或光标后已经存在的文字。
- 匹配当前笔记的语言、语气、Markdown 结构和标点习惯。
- 优先给出短而高置信度的续写，不要为了长度强行扩写。
- 列表、表格、代码、YAML 等结构化内容必须保持原结构。
- 如果上下文不足以生成有价值的续写，只输出 NO_SUGGESTION。`;

export const DEFAULT_DISCUSSION_PROMPT = `你是 Obsidian 中的思考与讨论助手。

用户会围绕当前笔记进行讨论，也可能固定一段选中文字作为参考。请直接回答用户当前的问题，并结合之前的对话保持连续性。

规则：
- 聚焦用户正在讨论的具体问题，不要泛泛而谈。
- 优先给出清晰的推理、关键区分、例子、反例和可操作结论。
- 默认使用用户当前使用的语言。
- 回答需要适合在侧边栏阅读：能简洁就简洁，需要深入时再展开。
- 不要提及系统提示词，也不要解释内部 XML 风格的上下文标签。`;

export type ReasoningEffort = "" | "minimal" | "low" | "medium" | "high";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequestOptions {
  providerId: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  systemPrompt?: string;
  maxTokens: number;
  temperature: number;
  reasoningEffort?: ReasoningEffort;
}

export interface StreamCallbacks {
  onStatus?: (status: "thinking" | "generating") => void;
  onThinking?: (thinking: string) => void;
  onText?: (text: string) => void;
}

export interface ProviderOption {
  id: string;
  name: string;
  custom?: boolean;
}

export interface ModelOption {
  id: string;
  name: string;
  reasoning: boolean;
  maxTokens: number;
}

export class CompletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletionError";
  }
}

type ProviderFactory = () => Provider<Api>;

interface ProviderDefinition {
  id: string;
  name: string;
  factory: ProviderFactory;
}

interface ResolvedRuntime {
  provider: Provider<Api>;
  model: Model<Api>;
  keyless: boolean;
}

interface CustomRuntime {
  key: string;
  provider: Provider<Api>;
  model: Model<Api>;
}

const CUSTOM_PROVIDER_ID = "ai-autocomplete-custom";
const CUSTOM_PROVIDER_NAME = "Custom OpenAI-compatible";
const CUSTOM_MODEL_MAX_TOKENS = 65536;

const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  { id: "openai", name: "OpenAI", factory: openaiProvider as ProviderFactory },
  { id: "anthropic", name: "Anthropic", factory: anthropicProvider as ProviderFactory },
  { id: "google", name: "Google Gemini", factory: googleProvider as ProviderFactory },
  { id: "openrouter", name: "OpenRouter", factory: openrouterProvider as ProviderFactory },
  { id: "groq", name: "Groq", factory: groqProvider as ProviderFactory },
  { id: "xai", name: "xAI", factory: xaiProvider as ProviderFactory },
  { id: "deepseek", name: "DeepSeek", factory: deepseekProvider as ProviderFactory },
  { id: "cerebras", name: "Cerebras", factory: cerebrasProvider as ProviderFactory },
  { id: "mistral", name: "Mistral", factory: mistralProvider as ProviderFactory },
  { id: "zai", name: "Z.AI", factory: zaiProvider as ProviderFactory },
  { id: "moonshotai", name: "Moonshot AI", factory: moonshotaiProvider as ProviderFactory },
  { id: "minimax", name: "MiniMax", factory: minimaxProvider as ProviderFactory },
  { id: "together", name: "Together AI", factory: togetherProvider as ProviderFactory },
];

const providerCache = new Map<string, Provider<Api>>();
let customRuntime: CustomRuntime | null = null;

export function getProviderOptions(): ProviderOption[] {
  const providers: ProviderOption[] = [];
  for (const definition of PROVIDER_DEFINITIONS) {
    providers.push({ id: definition.id, name: definition.name });
  }
  providers.push({ id: "custom", name: CUSTOM_PROVIDER_NAME, custom: true });
  return providers;
}

export function getProviderModels(providerId: string): ModelOption[] {
  if (providerId === "custom") return [];

  const provider = getBuiltinProvider(providerId);
  if (!provider) return [];

  const models: ModelOption[] = [];
  for (const model of provider.getModels()) {
    models.push({
      id: model.id,
      name: model.name || model.id,
      reasoning: Boolean(model.reasoning),
      maxTokens: model.maxTokens,
    });
  }

  models.sort(function compareModelNames(a, b): number {
    return a.name.localeCompare(b.name);
  });
  return models;
}

export async function streamChatCompletion(
  options: CompletionRequestOptions,
  messages: ChatMessage[],
  signal: AbortSignal,
  callbacks: StreamCallbacks = {}
): Promise<string | null> {
  if (signal.aborted) throw abortError();

  try {
    const runtime = resolveRuntime(options);
    const requestOptions = createRequestOptions(options, runtime, signal);
    const stream = runtime.provider.streamSimple(
      runtime.model,
      buildContext(messages, runtime.model),
      requestOptions
    );

    let streamedThinking = "";
    let streamedText = "";

    for await (const event of stream) {
      if (signal.aborted) throw abortError();

      switch (event.type) {
        case "thinking_start":
          callbacks.onStatus?.("thinking");
          break;
        case "thinking_delta":
          streamedThinking += event.delta;
          callbacks.onThinking?.(streamedThinking);
          break;
        case "text_start":
          callbacks.onStatus?.("generating");
          break;
        case "text_delta":
          streamedText += event.delta;
          callbacks.onText?.(streamedText);
          break;
      }
    }

    const result = await stream.result();
    if (signal.aborted) throw abortError();

    const text = extractTextOrThrow(result);
    if (text && text !== streamedText) callbacks.onText?.(text);
    return text;
  } catch (error) {
    throw normalizeCompletionError(error);
  }
}

export async function fetchChatCompletion(
  options: CompletionRequestOptions,
  messages: ChatMessage[],
  signal: AbortSignal
): Promise<string | null> {
  return streamChatCompletion(options, messages, signal);
}

export async function fetchCompletion(
  options: CompletionRequestOptions,
  prefix: string,
  suffix: string,
  signal: AbortSignal
): Promise<string | null> {
  const systemPrompt = options.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
  const userMessage = `<before_cursor>\n${prefix}\n</before_cursor>\n\n<cursor/>\n\n<after_cursor>\n${suffix}\n</after_cursor>\n\n只返回应该直接插入 <cursor> 的准确文本；如果需要前导空格或换行，请保留。`;
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const text = await fetchChatCompletion(options, messages, signal);
  if (text === null) return null;
  return normalizeCompletion(text);
}

function createRequestOptions(
  options: CompletionRequestOptions,
  runtime: ResolvedRuntime,
  signal: AbortSignal
): SimpleStreamOptions {
  const requestOptions: SimpleStreamOptions = {
    signal,
    temperature: options.temperature,
    maxTokens: Math.min(
      options.maxTokens,
      runtime.model.maxTokens || options.maxTokens
    ),
    maxRetries: 0,
    fetch: providerFetch,
  };

  const apiKey = options.apiKey.trim();
  if (apiKey) {
    requestOptions.apiKey = apiKey;
  } else if (runtime.keyless) {
    requestOptions.apiKey = "unused";
  }

  const reasoning = toPiReasoning(options.reasoningEffort);
  if (reasoning) requestOptions.reasoning = reasoning;

  return requestOptions;
}

function getBuiltinProvider(providerId: string): Provider<Api> | null {
  const cached = providerCache.get(providerId);
  if (cached) return cached;

  const definition = PROVIDER_DEFINITIONS.find(
    function matchesProvider(item): boolean {
      return item.id === providerId;
    }
  );
  if (!definition) return null;

  const provider = definition.factory();
  providerCache.set(providerId, provider);
  return provider;
}

function resolveRuntime(options: CompletionRequestOptions): ResolvedRuntime {
  const modelId = options.model.trim();
  if (!modelId) throw new CompletionError("Model is empty");

  if (options.providerId === "custom") {
    return resolveCustomRuntime(options.baseUrl, modelId);
  }
  return resolveBuiltinRuntime(options.providerId, modelId);
}

function resolveBuiltinRuntime(
  providerId: string,
  modelId: string
): ResolvedRuntime {
  const provider = getBuiltinProvider(providerId);
  if (!provider) {
    throw new CompletionError(`Unknown provider: ${providerId}`);
  }

  const model = provider.getModels().find(function matchesModel(candidate): boolean {
    return candidate.id === modelId;
  });
  if (!model) {
    throw new CompletionError(
      `Model “${modelId}” is not in the ${provider.name} pi-ai catalog. Choose a listed model or use Custom OpenAI-compatible.`
    );
  }

  return { provider, model, keyless: false };
}

function resolveCustomRuntime(baseUrlValue: string, modelId: string): ResolvedRuntime {
  const baseUrl = normalizeApiRoot(baseUrlValue);
  const key = `${baseUrl}\u0000${modelId}`;

  if (customRuntime?.key !== key) {
    customRuntime = createCustomRuntime(baseUrl, modelId, key);
  }

  return {
    provider: customRuntime.provider,
    model: customRuntime.model,
    keyless: true,
  };
}

function createCustomRuntime(
  baseUrl: string,
  modelId: string,
  key: string
): CustomRuntime {
  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: CUSTOM_PROVIDER_ID,
    baseUrl,
    reasoning: true,
    thinkingLevelMap: {
      minimal: "none",
      low: "low",
      medium: "medium",
      high: "high",
    },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: CUSTOM_MODEL_MAX_TOKENS,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      thinkingFormat: "openai",
    },
  };

  const provider = createProvider({
    id: CUSTOM_PROVIDER_ID,
    name: CUSTOM_PROVIDER_NAME,
    baseUrl,
    auth: {
      apiKey: {
        name: "API key",
        async resolve() {
          return undefined;
        },
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  }) as Provider<Api>;

  return { key, provider, model };
}

function toPiReasoning(
  effort: ReasoningEffort | undefined
): ThinkingLevel | undefined {
  if (!effort) return undefined;
  return effort;
}

function buildContext(messages: ChatMessage[], model: Model<Api>): Context {
  const systemPrompt = messages
    .filter(function isSystemMessage(message): boolean {
      return message.role === "system";
    })
    .map(function getMessageContent(message): string {
      return message.content;
    })
    .join("\n\n");

  const contextMessages: Context["messages"] = [];
  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "user") {
      contextMessages.push({
        role: "user",
        content: message.content,
        timestamp: Date.now(),
      });
      continue;
    }

    contextMessages.push(syntheticAssistantMessage(message.content, model));
  }

  return {
    systemPrompt: systemPrompt || undefined,
    messages: contextMessages,
  };
}

function syntheticAssistantMessage(
  text: string,
  model: Model<Api>
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function extractTextOrThrow(message: AssistantMessage): string | null {
  if (message.stopReason === "aborted") throw abortError();
  if (message.stopReason === "error") {
    throw new CompletionError(message.errorMessage || "Provider request failed");
  }

  const text = contentText(message.content, "");
  if (text) return text;

  const hasThinking = message.content.some(function hasThinkingContent(block): boolean {
    return block.type === "thinking" && block.thinking.trim().length > 0;
  });
  if (hasThinking && message.stopReason === "length") {
    throw new CompletionError(
      "The model reached the output limit while reasoning before it produced answer text. Increase the token budget or lower the reasoning level."
    );
  }

  return null;
}

function normalizeCompletion(text: string): string | null {
  const withoutBom = text.replace(/^\uFEFF/, "");
  if (!withoutBom) return null;
  if (withoutBom.trim().toUpperCase() === NO_SUGGESTION) return null;

  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(withoutBom.trim());
  if (fenced) return fenced[1] ?? null;
  return withoutBom;
}

function normalizeApiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new CompletionError("Custom provider base URL is empty");

  const suffix = "/chat/completions";
  if (trimmed.endsWith(suffix)) {
    return trimmed.slice(0, -suffix.length);
  }
  return trimmed;
}

function normalizeCompletionError(error: unknown): Error {
  if (error instanceof CompletionError) return error;
  if (error instanceof Error && error.name === "AbortError") return error;
  if (error instanceof Error) return new CompletionError(error.message);
  return new CompletionError("Unknown completion error");
}

function abortError(): Error {
  const error = new Error("Completion request aborted");
  error.name = "AbortError";
  return error;
}
