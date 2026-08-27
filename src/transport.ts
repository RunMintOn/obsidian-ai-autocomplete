import { requestUrl } from "obsidian";

/**
 * Fetch implementation for pi-ai.
 *
 * Desktop Obsidian plugins can use Node's HTTP stack, which bypasses browser
 * CORS and exposes response bytes as they arrive. Mobile does not expose Node,
 * so it falls back to Obsidian requestUrl (buffered, but compatible).
 */
export async function providerFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  if (canUseNodeHttp()) {
    return nodeStreamingFetch(input, init);
  }
  return bufferedObsidianFetch(input, init);
}

function canUseNodeHttp(): boolean {
  try {
    return (
      typeof require === "function" &&
      typeof require("node:http")?.request === "function" &&
      typeof require("node:https")?.request === "function"
    );
  } catch {
    return false;
  }
}

async function nodeStreamingFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  redirectsLeft = 3
): Promise<Response> {
  const resolved = await resolveRequest(input, init);
  if (resolved.signal?.aborted) throw abortError();

  const parsedUrl = new URL(resolved.url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`Unsupported provider URL protocol: ${parsedUrl.protocol}`);
  }

  const transport =
    parsedUrl.protocol === "https:"
      ? require("node:https")
      : require("node:http");

  return new Promise<Response>((resolve, reject) => {
    const headers = { ...resolved.headers };
    // Avoid compressed SSE bodies unless we explicitly add decompression.
    headers["accept-encoding"] = "identity";

    const request = transport.request(
      parsedUrl,
      {
        method: resolved.method,
        headers,
      },
      (response: {
        statusCode?: number;
        statusMessage?: string;
        headers: Record<string, string | string[] | undefined>;
        on(event: string, listener: (...args: any[]) => void): void;
        destroy(error?: Error): void;
      }) => {
        const status = response.statusCode ?? 0;
        const location = firstHeader(response.headers.location);
        if (
          redirectsLeft > 0 &&
          location &&
          [301, 302, 303, 307, 308].includes(status)
        ) {
          response.destroy();
          const redirected = new URL(location, resolved.url).toString();
          const redirectMethod =
            status === 303 || ((status === 301 || status === 302) && resolved.method === "POST")
              ? "GET"
              : resolved.method;
          const redirectInit: RequestInit = {
            ...init,
            method: redirectMethod,
            headers: resolved.headers,
            body: redirectMethod === "GET" ? undefined : resolved.body,
            signal: resolved.signal,
          };
          void nodeStreamingFetch(redirected, redirectInit, redirectsLeft - 1).then(
            resolve,
            reject
          );
          return;
        }

        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            for (const part of value) responseHeaders.append(key, part);
          } else if (typeof value === "string") {
            responseHeaders.set(key, value);
          }
        }

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            response.on("data", (chunk: Uint8Array) => {
              controller.enqueue(
                chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
              );
            });
            response.on("end", () => controller.close());
            response.on("error", (error: Error) => controller.error(error));
          },
          cancel() {
            response.destroy(abortError());
          },
        });

        resolve(
          new Response(stream, {
            status,
            statusText: response.statusMessage,
            headers: responseHeaders,
          })
        );
      }
    );

    const onAbort = () => request.destroy(abortError());
    resolved.signal?.addEventListener("abort", onAbort, { once: true });

    request.on("error", (error: Error) => {
      resolved.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    request.on("close", () => {
      resolved.signal?.removeEventListener("abort", onAbort);
    });

    if (resolved.body !== undefined) request.write(resolved.body);
    request.end();
  });
}

async function bufferedObsidianFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const resolved = await resolveRequest(input, init);
  if (resolved.signal?.aborted) throw abortError();

  const requestPromise = requestUrl({
    url: resolved.url,
    method: resolved.method,
    headers: resolved.headers,
    body: resolved.body,
    throw: false,
  });

  const response = resolved.signal
    ? await raceAbort(requestPromise, resolved.signal)
    : await requestPromise;

  if (resolved.signal?.aborted) throw abortError();
  return new Response(response.arrayBuffer, {
    status: response.status,
    headers: response.headers,
  });
}

async function resolveRequest(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<{
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | ArrayBuffer | undefined;
  signal: AbortSignal | null | undefined;
}> {
  const request = input instanceof Request ? input : null;
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

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
    throw new Error("Unsupported request body from pi-ai transport");
  }

  return {
    url,
    method: init?.method ?? request?.method ?? "GET",
    headers: headerRecord,
    body,
    signal: init?.signal ?? request?.signal,
  };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function abortError(): Error {
  const error = new Error("Completion request aborted");
  error.name = "AbortError";
  return error;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
