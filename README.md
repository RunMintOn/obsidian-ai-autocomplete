# AI Autocomplete

A lightweight inline AI completion plugin for Obsidian. It renders Copilot-style ghost text directly at the cursor and works with any OpenAI-compatible Chat Completions API.

## What it feels like

Pause briefly while typing and a muted suggestion appears inline.

- **Tab** accepts the whole suggestion.
- **Esc** dismisses it.
- **Cmd/Ctrl + Right Arrow** accepts the next word/segment.
- If you keep typing text that matches the suggestion, the matching prefix is consumed and only the remaining ghost text stays visible.
- Chinese/Japanese/Korean IME composition is handled separately so the ghost does not fight the operating system's composition range.

## Provider setup

The plugin intentionally has one provider contract: OpenAI-compatible `POST /chat/completions`.

Configure:

- **API base URL** — for example `https://api.openai.com/v1`, `http://localhost:1234/v1`, or another compatible gateway. If the URL does not already end in `/chat/completions`, the plugin appends it.
- **API key** — optional for local endpoints that do not require authentication.
- **Model** — the exact model name accepted by the endpoint.

This keeps the plugin compatible with OpenAI, OpenRouter, Groq-compatible gateways, LM Studio, vLLM, and other servers that expose the standard Chat Completions shape.

## Completion behavior

The plugin sends a fill-in-the-middle style prompt containing text before and after the cursor. The provider itself does not need a native FIM API.

Default context window sent per request:

- up to 2400 characters before the cursor
- up to 600 characters after the cursor

The request is triggered after a configurable idle delay (650 ms by default). Results are only displayed when the document and cursor are still at the position that initiated the request, so stale completions cannot overwrite newer typing.

Normal model output is not trimmed before insertion. Leading spaces and newlines are preserved because they may be required for correct inline completion.

## Commands

The command palette exposes:

- Trigger inline suggestion
- Accept inline suggestion
- Accept next suggestion segment
- Dismiss inline suggestion
- Toggle auto-completion
- Test provider connection

## Development

```bash
npm ci
npm run build
```

`npm run build` runs TypeScript typechecking before producing the production bundle. GitHub Actions runs the same build on the development branch and pull requests.

## License

MIT
