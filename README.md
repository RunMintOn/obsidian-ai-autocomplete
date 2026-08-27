# AI Autocomplete

A focused AI writing assistant for Obsidian: Copilot-style inline completion plus a linked discussion sidebar. Provider/model handling is delegated to `@earendil-works/pi-ai`.

## Inline completion

- Pause while typing to get ghost-text completion.
- **Tab** accepts all.
- **Esc** dismisses.
- **Cmd/Ctrl + Right Arrow** accepts the next word/segment.
- Continuing to type a matching prefix consumes that part of the ghost instead of dismissing it.
- Chinese/Japanese/Korean IME composition is handled separately.
- Prefix + suffix are sent as fill-in-the-middle context.
- Inline completion is stateless; discussion history is never included.

Automatic completion can be disabled while the manual trigger remains available. Eagerness is adjustable from 1–5.

## Discussion sidebar

Select a passage and run **Discuss selection in sidebar**. The right sidebar pins that passage as reference; type the actual question in the sidebar.

The sidebar includes:

- pinned reference text
- per-note short in-memory discussion history
- streaming **thinking** when the provider/model exposes it through pi-ai
- streaming final answer text
- **Stop** while generating, preserving received partial output
- quick **Discussion model** selector beside the composer
- quick **Reasoning** selector beside the composer
- quick **Token budget** input beside the composer
- **New**, **Use selection**, and **Clear** controls

Moving the editor cursor, changing the selection, or clicking elsewhere does not clear the discussion.

Completion model and Discussion model are stored separately for each Provider, so choosing a slower reasoning model for discussion does not silently slow down inline completion.

## Provider and model selection

Built-in providers and model catalogs come from pi-ai. Common built-in providers include OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, xAI, DeepSeek, Cerebras, Mistral, Z.AI, Moonshot AI, MiniMax, and Together AI.

Each Provider remembers its own API key and model selections.

Choose **Custom OpenAI-compatible** only for a custom/local endpoint. Custom mode exposes Base URL and free-form model IDs, including local endpoints such as `http://127.0.0.1:18180/v1`.

Desktop requests use a Node `http/https` streaming transport so local endpoints can stream without browser CORS. Mobile falls back to Obsidian `requestUrl`.

## Reasoning semantics

The UI deliberately avoids the ambiguous old `None` label.

- **Provider default / 由 Provider 决定**: no `reasoning` option is passed to pi-ai at all.
- **Minimal**: pi-ai receives `reasoning="minimal"`.
- **Low**: pi-ai receives `reasoning="low"`.
- **Medium**: pi-ai receives `reasoning="medium"`.
- **High**: pi-ai receives `reasoning="high"`.

For built-in providers, pi-ai maps the normalized level to that provider's actual request format.

For **Custom OpenAI-compatible**, the plugin currently declares this explicit map:

```text
pi-ai minimal -> reasoning_effort=none
pi-ai low     -> reasoning_effort=low
pi-ai medium  -> reasoning_effort=medium
pi-ai high    -> reasoning_effort=high
```

The sidebar shows a short hint describing the active mapping.

Reasoning and final answer text are kept separate. Thinking content is shown only in the discussion sidebar's collapsible **Thinking / 思考过程** area; it is never used as inline completion text or as an answer fallback.

Both completion and discussion token budgets accept direct numeric values from **16–65,536** because reasoning models can consume substantial output budget before producing answer text.

## Language and prompts

The plugin UI supports:

- **中文** — current development default
- **English**

The built-in completion and discussion system prompts are currently maintained in Chinese. Existing customized prompts are preserved; old unmodified English defaults are migrated to the new Chinese defaults.

Completion prompt templates support create, duplicate, rename, delete, edit, and reset. Templates only contain prompt text; Provider/model parameters remain separate.

## Default completion context

Each completion request includes up to:

- 2400 characters before the cursor
- 600 characters after the cursor

Stale requests are ignored when the document/cursor no longer matches the initiating state. Normal completion output is not trimmed because leading spaces/newlines can be meaningful.

## Development

Requires Node 22.

```bash
npm install
npm run build
```

The build runs TypeScript typechecking and produces the Obsidian `main.js` bundle. GitHub Actions also produces an installable artifact containing `main.js`, `manifest.json`, and `styles.css`.

## License

MIT
