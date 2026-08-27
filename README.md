# AI Autocomplete

A focused AI writing assistant for Obsidian: Copilot-style inline completion plus an optional linked discussion sidebar. Provider/model handling is delegated to `@earendil-works/pi-ai`.

## Inline completion

Pause briefly while typing and a muted suggestion appears at the cursor.

- **Tab** accepts the whole suggestion.
- **Esc** dismisses it.
- **Cmd/Ctrl + Right Arrow** accepts the next word/segment.
- Continuing to type a matching prefix consumes that part of the ghost text instead of dismissing it.
- Chinese/Japanese/Korean IME composition is handled separately.
- Prefix + suffix context is sent as a fill-in-the-middle style prompt.

Automatic completion can be disabled without disabling manual completion. Bind **AI Autocomplete: Trigger inline suggestion** from Obsidian **Settings → Hotkeys**.

Inline completion is deliberately stateless. Discussion history is never included in completion requests.

## Eagerness

Automatic completion has a 1–5 eagerness setting:

- **1** — conservative
- **3** — balanced default
- **5** — eager

Eagerness changes automatic trigger delay and minimum context only. Manual trigger bypasses the automatic threshold.

## Discussion sidebar

Discussion is intentionally separate from inline completion.

Select a passage in a Markdown note and run **AI Autocomplete: Discuss selection in sidebar**. The right sidebar opens and pins the selected passage as reference context. The selection is not sent as a question automatically; type the actual question in the sidebar.

The sidebar provides:

- pinned reference text from the editor
- per-note short discussion history
- a normal multi-line question box
- immediate **Thinking… / Generating…** status
- streaming answer updates on supported desktop transports
- **Stop** while a response is running; received partial text is kept
- **New** to clear the current note's discussion
- **Use selection** to replace the pinned reference with the latest editor selection
- **Clear** to remove the pinned reference

Moving the editor cursor, changing selection, or clicking elsewhere does not dismiss the sidebar answer. Discussion state is kept in memory for the current Obsidian session and is not written into the Vault.

## Providers and models

The settings page exposes pi-ai providers directly. Built-in providers currently include common choices such as OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, xAI, DeepSeek, Cerebras, Mistral, Z.AI, Moonshot AI, MiniMax, and Together AI.

For a built-in provider:

1. choose **Provider**
2. enter that provider's API key
3. choose **Model** from the pi-ai catalog

Each provider remembers its own API key and model selection.

Choose **Custom OpenAI-compatible** only for a custom/local endpoint. That mode exposes **API base URL** and a free-form **Model** field, so endpoints such as `http://127.0.0.1:18180/v1` remain supported.

pi-ai owns provider-specific request formatting, streaming parsing, model metadata, and text/thinking separation. Internal thinking blocks are never used as note completion text.

## Reasoning and token budget

Completion and discussion have separate reasoning controls:

- **Provider default (do not send)** — no explicit reasoning level is requested
- **Minimal / None (provider-specific)**
- **Low**
- **Medium**
- **High**

Reasoning models may spend a large part of the output budget before producing answer text. Both completion and discussion token budgets are direct numeric inputs accepting **16–65,536** tokens instead of a narrow slider.

If a model reaches the output limit while still reasoning and returns no answer text, the plugin reports that condition instead of exposing internal reasoning as the answer.

## Completion prompt templates

Completion templates contain only a name and a system prompt. Provider/model settings remain global.

The settings page supports selecting, creating, duplicating, renaming, deleting, editing, and resetting templates. Discussion has a separate editable system prompt.

## Default completion context

Each completion request includes up to:

- 2400 characters before the cursor
- 600 characters after the cursor

Stale requests are ignored when the document/cursor no longer matches the initiating state. Normal model output is not trimmed before insertion because leading spaces/newlines can be meaningful.

## Commands

- Trigger inline suggestion
- Accept inline suggestion
- Accept next suggestion segment
- Dismiss inline suggestion
- Open AI discussion sidebar
- Discuss selection in sidebar
- Start new discussion for current note
- Toggle automatic completion
- Test provider connection

## Development

Requires Node 22.

```bash
npm install
npm run build
```

`npm run build` runs TypeScript typechecking before producing the production bundle. GitHub Actions builds an installable Obsidian artifact on the development branch and pull requests.

## License

MIT
