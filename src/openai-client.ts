import { requestUrl } from "obsidian";

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

export function normalizeChatCompletionsUrl(baseUrl: string): string {
  const trimmed = (baseUrl.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

function abortError(): Error {
  const error = new Error("Completion request aborted");
  error.name = "AbortError";
  return error;
}

function extractMessageContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts = content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = (part as { text?: unknown }).text;
      return typeof value === "string" ? value : "";
    })
    .join("");

  return parts || null;
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
  if (!options.model.trim()) {
    throw new CompletionError("Model is empty");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.apiKey.trim()) {
    headers.Authorization = `Bearer ${options.apiKey.trim()}`;
  }

  const reasoningEffort = options.reasoningEffort?.trim();

  try {
    const response = await requestUrl({
      url: normalizeChatCompletionsUrl(options.baseUrl),
      method: "POST",
      headers,
      body: JSON.stringify({
        model: options.model.trim(),
        messages,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
      throw: false,
    });

    if (signal.aborted) throw abortError();

    if (response.status >= 400) {
      const apiMessage = response.json?.error?.message;
      throw new CompletionError(
        typeof apiMessage === "string"
          ? apiMessage
          : `HTTP ${response.status}: ${response.text.slice(0, 200)}`
      );
    }

    const data = response.json;
    if (data?.error?.message) {
      throw new CompletionError(String(data.error.message));
    }

    return extractMessageContent(data?.choices?.[0]?.message?.content);
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
