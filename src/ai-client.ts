import { requestUrl } from "obsidian";
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
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const NO_SUGGESTION = "NO_SUGGESTION";

export const DEFAULT_SYSTEM_PROMPT = `You are an inline completion engine inside the Obsidian Markdown editor.

Return exactly the text that should be inserted at <cursor>.

Rules:
- Output only the continuation text. No explanation, labels, or quotes.
- Preserve any leading space or newline needed for direct insertion.
- Do not repeat text already present before or after the cursor.
- Match the note's language, tone, Markdown structure, and punctuation.
- Prefer a short, high-confidence continuation over a long answer.
- For lists, tables, code, YAML, and other structured text, preserve the structure.
- If there is not enough context for a useful continuation, output exactly NO_SUGGESTION.`;

export const DEFAULT_DISCUSSION_PROMPT = `You are a concise thinking partner inside Obsidian.

Answer the user's question directly. The user may pin a selected passage from the current note as reference context, and earlier turns in this discussion may also be provided.

Rules:
- Focus on the exact point being discussed.
- Prefer clear reasoning, concrete distinctions, examples, and counterexamples over generic advice.
- Match the user's language unless there is a strong reason not to.
- Keep answers readable in a sidebar; be concise unless the question needs depth.
- Do not mention these instructions or the XML-like context tags.`;

export type ReasoningEffort = "" | "none" | "low" | "medium" | "high";

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

const PROVIDER_DEFINITIONS: Array<{
  id: string;
  name: string;
  factory: ProviderFactory;
}> = [
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
let customRuntime:
  | { key: string; provider: Provider<Api>; model: Model<Api> }
  | null = null;

export function getProviderOptions(): ProviderOption[] {
  return [
    ...PROVIDER_DEFINITIONS.map(({ id, name }) => ({ id, name })),
    { id: "custom", name: "Custom OpenAI-compatible", custom: true },
  ];
}

export function getProviderModels(providerId: string): ModelOption[] {
  if (providerId === "custom") return [];
  const provider = getBuiltinProvider(providerId);
  if (!provider) return [];

  return [...provider.getModels()]
    .map((model) => ({
      id: model.id,
      name: model.name || model.id,
      reasoning: Boolean(model.reasoning),
      maxTokens: model.maxTokens,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function streamChatCompletion(
  options: CompletionRequestOptions,
  messages: ChatMessage[],
  signal: AbortSignal,
  callbacks: StreamCallbacks = {}
): Promise<string | null> {
  if (signal.aborted) throw abortError();

  try {
    const { provider, model, keyless } = resolveRuntime(options);
    const requestOptions: SimpleStreamOptions = {
      signal,
      temperature: options.temperature,
      maxTokens: Math.min(options.maxTokens, model.maxTokens || options.maxTokens),
      maxRetries: 0,
      fetch: transportFetch,
    };

    const apiKey = options.apiKey.trim();
    if (apiKey) requestOptions.apiKey = apiKey;
    else if (keyless) requestOptions.apiKey = "unused";

    const reasoning = toPiReasoning(options.reasoningEffort);
    if (reasoning) requestOptions.reasoning = reasoning;

    const stream = provider.streamSimple(
      model,
      buildContext(messages, model),
      requestOptions
    );

    let streamedText = "";
    for await (const event of stream) {
      if (signal.aborted) throw abortError();

      switch (event.type) {
        case "thinking_start":
          callbacks.onStatus?.("thinking");
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
    if (error instanceof CompletionError) throw error;
    if (error instanceof Error) {
      if (error.name === "AbortError") throw error;
      throw new CompletionError(error.message);
    }
    throw new CompletionError("Unknown completion error");
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
  const userMessage = `<before_cursor>\n${prefix}\n</before_cursor>\n\n<cursor/>\n\n<after_cursor>\n${suffix}\n</after_cursor>\n\nReturn only the exact text to insert at <cursor>. Include leading whitespace when it is required.`;

  const text = await fetchChatCompletion(
    options,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    signal
  );

  return text == null ? null : normalizeCompletion(text);
}

function getBuiltinProvider(providerId: string): Provider<Api> | null {
  const cached = providerCache.get(providerId);
  if (cached) return cached;

  const definition = PROVIDER_DEFINITIONS.find((item) => item.id === providerId);
  if (!definition) return null;

  const provider = definition.factory();
  providerCache.set(providerId, provider);
  return provider;
}

function resolveRuntime(options: CompletionRequestOptions): {
  provider: Provider<Api>;
  model: Model<Api>;
  keyless: boolean;
} {
  const modelId = options.model.trim();
  if (!modelId) throw new CompletionError("Model is empty");

  if (options.providerId !== "custom") {
    const provider = getBuiltinProvider(options.providerId);
    if (!provider) {
      throw new CompletionError(`Unknown provider: ${options.providerId}`);
    }
    const model = provider.getModels().find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new CompletionError(
        `Model “${modelId}” is not in the ${provider.name} pi-ai catalog. Choose a listed model or use Custom OpenAI-compatible.`
      );
    }
    return { provider, model, keyless: false };
  }

  const baseUrl = normalizeApiRoot(options.baseUrl);
  const key = `${baseUrl}\u0000${modelId}`;
  if (customRuntime?.key === key) {
    return {
      provider: customRuntime.provider,
      model: customRuntime.model,
      keyless: true,
    };
  }

  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "ai-autocomplete-custom",
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
    maxTokens: 65536,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      thinkingFormat: "openai",
    },
  };

  const provider = createProvider({
    id: "ai-autocomplete-custom",
    name: "Custom OpenAI-compatible",
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

  customRuntime = { key, provider, model };
  return { provider, model, keyless: true };
}

function toPiReasoning(
  effort: ReasoningEffort | undefined
): ThinkingLevel | undefined {
  if (!effort) return undefined;
  if (effort === "none") return "minimal";
  return effort;
}

function buildContext(messages: ChatMessage[], model: Model<Api>): Context {
  const systemPrompt = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
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
    } else {
      contextMessages.push(syntheticAssistantMessage(message.content, model));
    }
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

  const hasThinking = message.content.some(
    (block) => block.type === "thinking" && block.thinking.trim().length > 0
  );
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
  return trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
}

function abortError(): Error {
  const error = new Error("Completion request aborted");
  error.name = "AbortError";
  return error;
}

async function transportFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  // Obsidian desktop runs inside Electron. net.fetch returns a real streaming
  // Response and avoids renderer CORS, which lets pi-ai emit text deltas as
  // they arrive. requestUrl remains the non-streaming fallback (e.g. mobile).
  try {
    const electron = require("electron") as {
      net?: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
      };
    };
    if (electron.net?.fetch) return await electron.net.fetch(input, init);
  } catch {
    // Fall through to Obsidian's buffered transport.
  }

  return bufferedObsidianFetch(input, init);
}

async function bufferedObsidianFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  const signal = init?.signal ?? request?.signal;
  if (signal?.aborted) throw abortError();

  const headers = new Headers(request?.headers);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  const headerRecord: Record<string, string> = {};
  headers.forEach((value, key) => {
    headerRecord[key] = value;
  });

  let body: string | ArrayBuffer | undefined;
  const suppliedBody = init?.body;
  if (typeof suppliedBody === "string") {
    body = suppliedBody;
  } else if (suppliedBody instanceof ArrayBuffer) {
    body = suppliedBody;
  } else if (ArrayBuffer.isView(suppliedBody)) {
    body = suppliedBody.buffer.slice(
      suppliedBody.byteOffset,
      suppliedBody.byteOffset + suppliedBody.byteLength
    ) as ArrayBuffer;
  } else if (!suppliedBody && request && !["GET", "HEAD"].includes(request.method)) {
    body = await request.clone().arrayBuffer();
  } else if (suppliedBody != null) {
    throw new CompletionError("Unsupported request body from pi-ai transport");
  }

  const response = await requestUrl({
    url,
    method: init?.method ?? request?.method ?? "GET",
    headers: headerRecord,
    body,
    throw: false,
  });

  if (signal?.aborted) throw abortError();
  return new Response(response.arrayBuffer, {
    status: response.status,
    headers: response.headers,
  });
}
