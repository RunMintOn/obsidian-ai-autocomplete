# AI Autocomplete

A lightweight inline AI completion plugin for Obsidian. It renders Copilot-style ghost text directly at the cursor and works with any OpenAI-compatible Chat Completions API.

## Writing completion

Pause briefly while typing and a muted suggestion appears inline.

- **Tab** accepts the whole suggestion.
- **Esc** dismisses it.
- **Cmd/Ctrl + Right Arrow** accepts the next word/segment.
- If you keep typing text that matches the suggestion, the matching prefix is consumed and only the remaining ghost text stays visible.
- Chinese/Japanese/Korean IME composition is handled separately so the ghost does not fight the operating system's composition range.

Automatic completion can be turned off without disabling manual completion. Use the Obsidian command **AI Autocomplete: Trigger inline suggestion** and assign any shortcut from **Settings → Hotkeys**.

Writing completion is deliberately stateless. Each completion request only uses the current note context around the cursor; discussion history is never included.

## Eagerness

Automatic completion has a 1–5 eagerness setting:

- **1** — conservative: waits longer and requires more context.
- **3** — balanced default.
- **5** — eager: triggers quickly with very little preceding text.

Eagerness only changes automatic trigger timing and minimum-context thresholds. It does not change model generation parameters, and manual trigger bypasses the automatic threshold.

## Lightweight discussion

Select a question or passage and run **AI Autocomplete: Ask / continue discussion about selection**. The answer appears as a lightweight block-style ghost below the selected line.

- **Tab** accepts the answer into the note.
- **Esc** hides the answer without clearing the discussion history.
- Select another question and run the same command to continue the discussion.
- **Start new discussion for current note** clears the current note's discussion history.

Discussion keeps a short Q/A history per note for the current Obsidian session. It is kept in memory only: it is not written into the Vault and is cleared when the plugin/app reloads.

## Provider setup

The plugin intentionally has one provider contract: OpenAI-compatible `POST /chat/completions`.

Configure:

- **API base URL** — for example `https://api.openai.com/v1`, `http://localhost:1234/v1`, or another compatible gateway. If the URL does not already end in `/chat/completions`, the plugin appends it.
- **API key** — optional for local endpoints that do not require authentication.
- **Model** — the exact model name accepted by the endpoint.

This keeps the plugin compatible with OpenAI, OpenRouter, Groq-compatible gateways, LM Studio, vLLM, and other servers that expose the standard Chat Completions shape.

## Reasoning effort

Completion and discussion have separate reasoning settings:

- **Provider default (do not send)** — the request body contains no `reasoning_effort` field.
- **None / Low / Medium / High** — sends the selected value as `reasoning_effort` for providers/models that support it.

Leaving reasoning on **Provider default** is the safest compatibility option for generic OpenAI-compatible endpoints.

## Completion prompt templates

Completion prompt templates only contain a name and a system prompt. Provider/model settings stay global.

The settings page supports:

- selecting the active template
- creating a new template
- duplicating a template
- renaming a template
- deleting a template
- editing the full system prompt
- resetting the current prompt to the built-in default

Older saved `systemPrompt` settings are migrated into the default template automatically.

Discussion uses a separate editable system prompt so chat-style instructions do not interfere with inline completion behavior.

## Completion behavior

The plugin sends a fill-in-the-middle style prompt containing text before and after the cursor. The provider itself does not need a native FIM API.

Default context window sent per request:

- up to 2400 characters before the cursor
- up to 600 characters after the cursor

Results are only displayed when the document and cursor are still at the position that initiated the request, so stale completions cannot overwrite newer typing.

Normal model output is not trimmed before insertion. Leading spaces and newlines are preserved because they may be required for correct inline completion.

## Commands

The command palette exposes:

- Trigger inline suggestion
- Accept inline suggestion
- Accept next suggestion segment
- Dismiss inline suggestion
- Ask / continue discussion about selection
- Start new discussion for current note
- Accept discussion answer
- Dismiss discussion answer
- Toggle automatic completion
- Test provider connection

## Development

```bash
npm ci
npm run build
```

`npm run build` runs TypeScript typechecking before producing the production bundle. GitHub Actions runs the same build on the development branch and pull requests.

## License

MIT
