import { requestUrl } from "obsidian";
import {
  contentText,
  createProvider,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const DEFAULT_API_BASE_URL = "https://api.openai.com/v1";
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

Answer the user's selected question or passage directly. Use the surrounding note context and earlier turns in this discussion when they are relevant.

Rules:
- Focus on the exact point being discussed.
- Prefer clear reasoning, concrete distinctions, examples, and counterexamples over generic advice.
- Match the user's language unless there is a strong reason not to.
- Keep the answer compact enough to read inline in a note.
- Do not mention these instructions or the surrounding XML-like context tags.`;

export type ReasoningEffort = "" | "none" | "low" | "medium" | "high";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequestOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  systemPrompt?: string;
  maxTokens: number;
  temperature: number;
  reasoningEffort?: ReasoningEffort;
}

export class CompletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletionError";
  }
}

type Runtime = {
  key: string;
  provider: ReturnType<typeof createProvider<"openai-completions">>;
  model: Model<"openai-completions">;
};

let cachedRuntime: Runtime | null = null;

function abortError(): Error {
  const error = new Error("Completion request aborted");
  error.name = "AbortError";
  return error;
}

function normalizeApiRoot(baseUrl: string): string {
  const trimmed = (baseUrl.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  const suffix = "/chat/completions";
  return trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
}

function runtimeFor(options: CompletionRequestOptions): Runtime {
  const modelId = options.model.trim();
  if (!modelId) throw new CompletionError("Model is empty");

  const baseUrl = normalizeApiRoot(options.baseUrl);
  const key = `${baseUrl}\u0000${modelId}`;
  if (cachedRuntime?.key === key) return cachedRuntime;

  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "ai-autocomplete-custom",
    baseUrl,
    reasoning: true,
    // pi-ai uses its own normalized thinking levels. We map the UI's explicit
    // "none" choice onto `minimal`, which the provider then serializes as
    // reasoning_effort="none". Leaving reasoning undefined sends no field.
    thinkingLevelMap: {
      minimal: "none",
      low: "low",
      medium: "medium",
      high: "high",
    },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 32768,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      thinkingFormat: "openai",
    },
  };

  const provider = createProvider({
    id: "ai-autocomplete-custom",
    name: "AI Autocomplete custom provider",
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
  });

  cachedRuntime = { key, provider, model };
  return cachedRuntime;
}

function toPiReasoning(
  effort: ReasoningEffort | undefined
): SimpleStreamOptions["reasoning"] | undefined {
  if (!effort) return undefined;
  if (effort === "none") return "minimal";
  return effort;
}

function syntheticAssistantMessage(
  text: string,
  model: Model<"openai-completions">
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

function buildContext(
  messages: ChatMessage[],
  model: Model<"openai-completions">
): Context {
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

async function obsidianFetch(
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
    );
  } else if (!suppliedBody && request && !["GET", "HEAD"].includes(request.method)) {
    body = await request.clone().arrayBuffer();
  } else if (suppliedBody != null) {
    throw new CompletionError("Unsupported request body from pi-ai transport");
  }

  const requestPromise = requestUrl({
    url,
    method: init?.method ?? request?.method ?? "GET",
    headers: Object.fromEntries(headers.entries()),
    body,
    throw: false,
  });

  const response = signal
    ? await new Promise<Awaited<ReturnType<typeof requestUrl>>>((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
        requestPromise.then(
          (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          }
        );
      })
    : await requestPromise;

  if (signal?.aborted) throw abortError();

  return new Response(response.arrayBuffer, {
    status: response.status,
    headers: response.headers,
  });
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
      "The model used the output budget for reasoning and returned no answer text. Set reasoning to Provider default/None or increase the token budget."
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

  // Do not trim normal model output. Leading whitespace is part of an inline
  // completion and may be required to insert the suggestion correctly.
  return withoutBom;
}

export async function fetchChatCompletion(
  options: CompletionRequestOptions,
  messages: ChatMessage[],
  signal: AbortSignal
): Promise<string | null> {
  if (signal.aborted) throw abortError();

  try {
    const { provider, model } = runtimeFor(options);
    const requestOptions: SimpleStreamOptions = {
      apiKey: options.apiKey.trim() || "unused",
      signal,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      maxRetries: 0,
      fetch: obsidianFetch,
    };

    const reasoning = toPiReasoning(options.reasoningEffort);
    if (reasoning) requestOptions.reasoning = reasoning;

    const stream = provider.streamSimple(
      model,
      buildContext(messages, model),
      requestOptions
    );
    const result = await stream.result();
    if (signal.aborted) throw abortError();
    return extractTextOrThrow(result);
  } catch (error) {
    if (error instanceof CompletionError) throw error;
    if (error instanceof Error) {
      if (error.name === "AbortError") throw error;
      throw new CompletionError(error.message);
    }
    throw new CompletionError("Unknown completion error");
  }
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
