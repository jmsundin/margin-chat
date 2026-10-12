# MCP server for outside agents

Margin Chat is an [MCP](https://modelcontextprotocol.io) server at
`https://www.marginchat.com/api/mcp`. With it, agents like Claude Code, Cursor
and VS Code can search and read a member's cloud vault using the same tools
Agent mode uses.

## Who can connect

- Plus, Cloud and admin accounts. Their vault is stored in the cloud, so the
  server can read it. Free accounts and desktop vaults that are never synced
  live only on the member's device, so the server can't reach them.
- Each member makes their own tokens in **Settings → Agents**. A token is shown
  once, is named after the agent it's for, lasts up to a year and can be revoked
  at any time. The table stores only the token's SHA-256 hash
  (`marginchat_mcp_tokens`, migration `0018_mcp_tokens`). Each account can hold
  up to 20 tokens.
- If a member's subscription lapses, their tokens stay but stop working (403)
  until they subscribe again.

## Tools (read-only)

| Tool | What it does |
| --- | --- |
| `search_vault` | Searches by title, words and meaning across documents, notes, chats, uploads and vault PDFs (`server/chat/agent/vaultTools.mjs`). |
| `read_document` | Reads one item by `document_id`. Long text is cut at 60,000 characters. |
| `list_related` | Lists the item's parent, children, typed relations and links in both directions. |
| `search` / `fetch` | The same search and read in the shapes ChatGPT's connectors and deep research expect. |

Private margin comments are never searched or returned. Search by meaning embeds
the query, and that cost goes to the member's own OpenAI key or their Plus
credit, the same as searching in the app.

## Protocol

`server/mcp/index.mjs` implements Streamable HTTP without sessions. Each `POST`
carries one JSON-RPC message and gets back one JSON answer, or `202` for a
notification. `GET` and `DELETE` return `405` because no server stream or
session is ever opened. Supported protocol versions are 2025-11-25, 2025-06-18,
2025-03-26 and 2024-11-05. Requests without a valid token get `401` with
`WWW-Authenticate: Bearer`.

## Connecting a client

Claude Code:

```sh
claude mcp add --transport http margin-chat https://www.marginchat.com/api/mcp \
  --header "Authorization: Bearer mc_mcp_…"
```

Other clients (`.cursor/mcp.json`, `.vscode/mcp.json` and similar):

```json
{ "mcpServers": { "margin-chat": { "type": "http", "url": "https://www.marginchat.com/api/mcp",
  "headers": { "Authorization": "Bearer mc_mcp_…" } } } }
```

ChatGPT and claude.ai connectors sign in with OAuth instead of a pasted token.
That comes in a later step.

## Next steps

1. Writing: `create_document`, `append_to_document`, `add_margin_note` and
   `capture` tools that save through the vault commit path, using tokens with
   scope `write`.
2. OAuth 2.1 (protected-resource metadata, dynamic client registration, PKCE)
   so ChatGPT and claude.ai can connect with a normal sign-in.
