# AI Autocomplete

A lightweight inline AI completion plugin for Obsidian. It renders Copilot-style ghost text directly at the cursor and uses `@earendil-works/pi-ai` for model/provider request handling.

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

The plugin delegates Chat Completions parsing, streaming events, text/thinking separation, and provider compatibility behavior to **pi-ai**. The current UI exposes one configurable OpenAI-compatible pi-ai provider:

- **API base URL** — for example `https://api.openai.com/v1` or `http://127.0.0.1:18180/v1`.
- **API key** — used by pi-ai/OpenAI transport. A placeholder is used for keyless local endpoints.
- **Model** — the exact model id accepted by the endpoint.

Obsidian `requestUrl` is used as pi-ai's HTTP transport so desktop plugins can still reach local/custom endpoints without normal browser CORS restrictions. Response parsing itself is handled by pi-ai.

## Reasoning

Completion and discussion have separate reasoning settings:

- **Provider default (do not send)** — no reasoning level is requested from pi-ai, so the provider-specific reasoning field is omitted.
- **None** — explicitly maps to the provider value `none`.
- **Low / Medium / High** — asks pi-ai for the corresponding normalized thinking level.

pi-ai keeps thinking blocks separate from answer text. The plugin only renders `text` blocks; it never uses internal thinking/reasoning content as a completion fallback.

If a model consumes its full output budget on thinking and returns no text, the plugin reports that condition and suggests using Provider default/None or increasing the token budget.

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

Requires Node 22.

```bash
npm ci
npm run build
```

`npm run build` runs TypeScript typechecking before producing the production bundle. GitHub Actions runs the same build on the development branch and pull requests.

## License

MIT
