# Margin Chat

**Think in the margins.** Margin Chat is an AI notebook where you highlight any passage and ask about it in the margin, so the answer becomes its own linked note instead of scrolling away in a chat. Every note is a plain Markdown file in your own vault, and a map shows how all of it connects.

Use it to study a subject, read papers and books with an AI beside you, research a topic across many sources, or keep a personal knowledge base (a second brain or Zettelkasten) that works with Obsidian.

**Try it at [marginchat.com](https://www.marginchat.com)**, in the browser, as a desktop app for Mac, Windows and Linux, or as a Chrome extension.

![Highlighting a passage and asking AI about it opens the answer as a side document linked to the passage](docs/media/readme/ask-ai-side-document.gif)

## Why Margin Chat

Chats scroll away. Ideas shouldn't.

- **Branch, don't scroll.** Highlight a sentence and ask about it. The answer opens beside the document as a new note, joined to the exact passage it came from, and the original stays where you left it.
- **Keep what you learn.** Every document, AI answer and margin note is a Markdown file in your vault, with Obsidian-style `[[wiki links]]` back to where it came from. Your notes are never locked inside the app.
- **See the shape of it.** Open the map and your notes become a graph you can arrange, cluster and grow.

## Features

### Ask AI about any passage

Select text and choose **Ask AI**. Answer in a side document beside the original, or right in the document. Use OpenAI, Anthropic Claude, Google Gemini, xAI Grok or Hugging Face models with your own keys, or the hosted models on the Plus plan.

### Margin notes

Keep a private thought next to the line that sparked it. Notes sit in the margin beside their passage and are saved as small linked documents.

![Selecting a phrase and adding a margin note beside it](docs/media/readme/margin-note.gif)

### Map view

Every document is a card and every link is a line. Zoom out to see how topics cluster, and zoom in until the cards become documents you can read and edit in place.

- **Canvas**: place notes where you want them, drag to arrange, drag from one card to another to link them.
- **Focus**: center one note and see only what links to and from it.
- **Clusters**: group notes by their links or by meaning, and let AI name each cluster.
- **Search and Explore**: add notes from Wikipedia, the web or an AI answer straight onto the map.

![Zooming the map from clusters of notes into readable document cards](docs/media/readme/map-view.gif)

### Search the whole vault

Press <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + <kbd>K</kbd> to search by words and by meaning. Results open as a preview of the passage itself, with your search terms highlighted, so you find the line, not just the file.

![Searching the vault and previewing matching passages](docs/media/readme/vault-search.gif)

### And the rest

- **Agent mode.** Switch Ask AI to Agent and it works through your notes on its own, searching the vault, reading pasted web pages and PDFs, and showing each step.
- **Your vault, your files.** Connect a folder on your computer (works with an Obsidian vault), sync it to the cloud, or import a zip. PDFs and images become documents you can annotate.
- **Voice typing.** Dictate into any document and watch the words appear while you talk.
- **Chrome extension.** Open your workspace on top of any web page, highlight a passage and ask about it, and save pages and links to your vault with their source.
- **Desktop app.** Electron app for Mac, Windows and Linux that keeps itself up to date.
- **MCP server.** Let Claude Code, Cursor, VS Code and other agents search, read and add to your cloud vault. See [docs/mcp-server.md](docs/mcp-server.md).
- **Bring your chat history.** Import a ChatGPT export and continue any old chat as Markdown in your vault.

## Plans

- **Free**: bring your own AI keys, keep your vault on your device.
- **Cloud**: cloud vault and sync across devices, with your own keys.
- **Plus**: hosted AI with monthly usage credit, plus the cloud vault and the Chrome extension.

Current prices are at [marginchat.com/pricing](https://www.marginchat.com/pricing).

## How it's built

| Part | Where | Stack |
| --- | --- | --- |
| Web app | [`client/`](client) | React 19, Vite, TypeScript, Tiptap editor |
| API | [`server/`](server), [`api/`](api) | Node, Postgres with pgvector, Vercel Blob for vault files |
| Desktop app | [`desktop/`](desktop) | Electron |
| Chrome extension | [`extension/`](extension) | Manifest V3, Vite |
| Shared formats | [`packages/`](packages) | Vault Markdown, frontmatter and relation contracts |

More detail lives in [`docs/`](docs): the Markdown vault format ([markdown-vault.md](docs/markdown-vault.md)), map exploration ([graph-map-exploration.md](docs/graph-map-exploration.md)), search ([search-and-exploration.md](docs/search-and-exploration.md)), billing ([billing.md](docs/billing.md)) and releases ([production-releases.md](docs/production-releases.md)).

## Running it locally

You need [Bun](https://bun.sh) 1.3.9 and Docker (for Postgres).

```sh
bun install
cp .env.example .env          # add at least one AI provider key
bun run db:start              # Postgres with pgvector in Docker
MIGRATION_DATABASE_URL=postgresql://margin_chat:margin_chat@127.0.0.1:5432/margin_chat \
  bun run db:migrate --target local --expected-host 127.0.0.1 --expected-database margin_chat
bun run dev                   # API on :8787 and the web app on http://localhost:5173
```

To work on the frontend only against the live backend, see [docs/local-frontend.md](docs/local-frontend.md).

Other useful commands:

```sh
bun test                      # all tests
bun run build                 # production build of the web app
bun run desktop:install && bun run desktop:dev   # desktop app
bun run build:extension       # Chrome extension; load extension/dist unpacked (see extension/README.md)
```

Every commit on `main` is released to production once CI passes; see [docs/production-releases.md](docs/production-releases.md).
