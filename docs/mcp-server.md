# MCP server for outside agents

Margin Chat is an [MCP](https://modelcontextprotocol.io) server at
`https://www.marginchat.com/api/mcp`. With it, agents like Claude Code, Cursor
and VS Code can search and read a member's cloud vault using the same tools
Agent mode uses. With a write token, they can also add documents.

This page is the technical reference. Step-by-step setup for each AI app
(Claude, Claude Code, ChatGPT, Gemini, Meta Muse, Muse Code, Cursor and VS Code)
is at [marginchat.com/connect](https://www.marginchat.com/connect)
(`client/src/components/landing/ConnectAppsPage.tsx`).

## Who can connect

- Plus, Cloud and admin accounts. Their vault is stored in the cloud, so the
  server can read it. Free accounts and desktop vaults that are never synced
  live only on the member's device, so the server can't reach them.
- Each member makes their own tokens in **Profile → Agents**. A token is shown
  once, is named after the agent it's for, lasts up to a year and can be revoked
  at any time. The table stores only the token's SHA-256 hash
  (`marginchat_mcp_tokens`, migration `0018_mcp_tokens`). Each account can hold
  up to 20 tokens.
- If a member's subscription lapses, their tokens stay but stop working (403)
  until they subscribe again.

## Reading tools (every token)

| Tool | What it does |
| --- | --- |
| `search_vault` | Searches by title, words and meaning across documents, notes, chats, uploads and vault PDFs (`server/chat/agent/vaultTools.mjs`). |
| `read_document` | Reads one item by `document_id`. Long text is cut at 60,000 characters. |
| `list_related` | Lists the item's parent, children, typed relations and links in both directions. |
| `search` / `fetch` | The same search and read in the shapes ChatGPT's connectors and deep research expect. |

## Writing tools (tokens that can add documents)

When a member makes a token, they choose whether it **Can create documents and
add to them**. That choice is the token's `write` scope. Agents only add: nothing
is ever replaced or deleted.

| Tool | What it does |
| --- | --- |
| `create_document` | Writes a new plain Markdown file at the vault root, named after the title (`Title.md`, then `Title 2.md` and so on). Its frontmatter holds `margin-chat-id: mcp-<uuid>`, `title`, `created`, `updated` and `created-by` (the token's name). Optional `relations` add typed links such as `part-of: ["[[Launch plan]]"]`, which show on the map. |
| `append_to_document` | Adds Markdown at the end of a document, as a new paragraph block after its last block, or at the end of a note or plain file. Chats are refused. |

Both tools save with the vault's normal commit (`server/mcp/writeTools.mjs`).
An append is based on the file's current revision, so if another device edited
the file at the same moment, the append is refused and the agent is told to read
again. Before saving, each new or changed file is parsed back, and anything that
wouldn't read as the same item is refused. Open apps pick up changes on their
next sync, which runs every 15 seconds.

Documents the user marks "Hide from AI" (frontmatter `hide-from-ai: true`) are
never searched or returned. Search by meaning embeds
the query, and that cost goes to the member's own OpenAI key or their Plus
credit, the same as searching in the app.

## Protocol

`server/mcp/index.mjs` implements Streamable HTTP without sessions. Each `POST`
carries one JSON-RPC message and gets back one JSON answer, or `202` for a
notification. `GET` and `DELETE` return `405` because no server stream or
session is ever opened. Supported protocol versions are 2025-11-25, 2025-06-18,
2025-03-26 and 2024-11-05. Requests without a valid token get `401` with
`WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`,
which is how connectors find the sign-in described below.

## Connecting a client

Claude Code:

```sh
claude mcp add --scope user --transport http margin-chat https://www.marginchat.com/api/mcp \
  --header "Authorization: Bearer mc_mcp_…"
```

To save every Claude Code session into the vault automatically, see
[Save Claude Code sessions automatically](claude-code-autosave.md).

`--scope user` makes it work in every folder; without it Claude Code only
uses it in the folder where the command ran.

Cursor (`~/.cursor/mcp.json`) and most other clients:

```json
{ "mcpServers": { "margin-chat": { "url": "https://www.marginchat.com/api/mcp",
  "headers": { "Authorization": "Bearer mc_mcp_…" } } } }
```

VS Code (`.vscode/mcp.json`) names the top-level key `servers`:

```json
{ "servers": { "margin-chat": { "type": "http", "url": "https://www.marginchat.com/api/mcp",
  "headers": { "Authorization": "Bearer mc_mcp_…" } } } }
```

Use the `www.` host. `marginchat.com` redirects to it, and some clients (Meta
Muse among them) refuse to follow the redirect.

## Signing in from ChatGPT and claude.ai (OAuth)

ChatGPT and claude.ai add Margin Chat as a custom connector with the address
`https://www.marginchat.com/api/mcp`. They don't need a token; they use OAuth 2.1
as the MCP authorization spec describes (`server/mcp/oauth.mjs`):

1. The first request gets `401`, whose header points to
   `/.well-known/oauth-protected-resource` (RFC 9728). That names this site as
   the authorization server, and `/.well-known/oauth-authorization-server`
   (RFC 8414) lists the endpoints below. On Vercel both paths are rewritten to
   the API handler (`vercel.json`).
2. The connector registers itself at `POST /api/oauth/register` (RFC 7591).
   Clients are public (`token_endpoint_auth_method: none`), and redirect URIs
   must be HTTPS, or plain HTTP to localhost for desktop agents.
3. It sends the member to `/oauth/authorize`, the app's consent page
   (`client/src/components/OAuthConsent.tsx`). The member signs in if needed and
   sees "Connect {app} to your vault?". When the connector asks for
   `vault:write`, a checkbox lets the member also allow adding documents. It
   starts checked and can be turned off. The page's answer goes to
   `POST /api/oauth/authorization`, which only the app itself can call.
4. The connector swaps the code at `POST /api/oauth/token` with PKCE (S256
   only). Codes last 10 minutes and work once. It gets a 1-hour access token
   (`mc_mcp_…`) and a refresh token (`mc_mcpr_…`). Each refresh replaces both
   tokens. A connection left unused for 90 days has to sign in again.
5. `POST /api/oauth/revoke` (RFC 7009) ends a connection.

A connection is stored as a row in `marginchat_mcp_tokens` with its
`client_id`. Only hashes are kept (migration `0019_mcp_oauth`, which also adds
`marginchat_oauth_clients` and `marginchat_oauth_codes`). Connecting the same app
again replaces its earlier connection. Connections appear in **Profile →
Agents** as "Signed-in app" and can be revoked there like tokens, and they count
toward the 20 per account. The same plan rule applies: only Plus, Cloud and
admin accounts can approve a connection.

Scopes are `vault:read` (the reading tools) and `vault:write` (the writing tools
as well).
