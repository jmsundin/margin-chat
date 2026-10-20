import { createHash, randomBytes } from "node:crypto";
import { VAULT_TOOL_DEFINITIONS, createVaultTools } from "../chat/agent/vaultTools.mjs";
import { HttpError } from "../lib/errors.mjs";
import { WRITE_TOOL_DEFINITIONS, createWriteTools } from "./writeTools.mjs";

/**
 * Margin Chat as an MCP server: outside agents (Claude Code, Cursor, ChatGPT and
 * other MCP clients) search and read the member's cloud vault with the same
 * tools Agent mode uses and, with a write token, add documents to it. Streamable HTTP without sessions: every POST carries one
 * JSON-RPC message and gets one JSON answer, which suits serverless functions.
 */

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const MCP_TOKEN_TTL_MS = 365 * 86400_000;
export const MCP_BODY_LIMIT = 256 * 1024;
const TOKEN_PATTERN = /^Bearer (mc_mcp_[A-Za-z0-9_-]{43})$/u;
const NAME_LIMIT = 80;
// One read is returned whole to the calling agent, which manages its own context.
const READ_CHARACTERS = 60_000;
const SERVER_INFO = { name: "margin-chat", title: "Margin Chat", version: "1.0.0" };
const INSTRUCTIONS = [
  "Margin Chat holds the user's documents, notes, chats, PDFs and the map of how they connect.",
  "Use search_vault to find material by words or meaning, read_document to read one by its document_id,",
  "and list_related to see its parent, children, typed relations and links.",
  "Private margin comments and documents the user hid from AI are never included.",
].join(" ");
const READ_ONLY_NOTE = "This connection is read-only.";
const WRITE_NOTE = "With create_document and append_to_document you can add to the vault; existing text is never changed or deleted. Search before creating, so you don't duplicate a document that already exists.";

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** Plus, Cloud and admin accounts have a cloud vault for agents to reach. */
export function canUseMcp(user) {
  return user?.role === "admin" || user?.billing?.accessKind === "subscription";
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const TITLES = { search_vault: "Search vault", read_document: "Read document", list_related: "List connections" };

// ChatGPT's connectors and deep research look for tools named exactly search and fetch.
const CHATGPT_TOOLS = [
  {
    name: "search",
    title: "Search",
    description: "Search the user's Margin Chat vault (documents, notes, chats and PDFs) by keyword or meaning. Returns matching documents; read one with fetch.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "A few keywords or a short phrase." } }, required: ["query"], additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "fetch",
    title: "Fetch",
    description: "Read one document from the user's Margin Chat vault by the id that search returned.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "A document id from search." } }, required: ["id"], additionalProperties: false },
    annotations: READ_ONLY,
  },
];

export const MCP_TOOLS = [
  ...VAULT_TOOL_DEFINITIONS.map(({ name, description, parameters }) => ({
    name, title: TITLES[name], description, inputSchema: parameters, annotations: READ_ONLY,
  })),
  ...CHATGPT_TOOLS,
];
const TOOL_NAMES = new Set(MCP_TOOLS.map((tool) => tool.name));
const WRITE_TOOL_NAMES = new Set(WRITE_TOOL_DEFINITIONS.map((tool) => tool.name));

/** The tools a token may use: everyone reads; a write token can also add. */
export function mcpToolsFor(scope) {
  return scope === "write" ? [...MCP_TOOLS, ...WRITE_TOOL_DEFINITIONS] : MCP_TOOLS;
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** A chat's text for fetch: one line per message, as an agent would quote it. */
function documentText(document) {
  if (typeof document.text === "string") return document.text;
  const messages = (document.messages ?? []).map((message) => `${message.role}: ${message.content}`).join("\n\n");
  return document.file_text ? `${document.file_text}\n\n${messages}`.trim() : messages;
}

export function createMcpService({ database, vaultService, passageService, createUsageContext }) {
  function workspaceFor(user, signal) {
    return {
      userId: user.id, vault: vaultService, database,
      ...(passageService?.available ? { passages: {
        // Search by meaning embeds the query: billed to the member's own key or Plus credit, like search in the app.
        search: async (query, options = {}) => passageService.search({ userId: user.id, query, ...options,
          context: await createUsageContext({ user, signal, operation: "mcp-search" }) }),
        readFile: (fileId) => passageService.readFile({ userId: user.id, fileId }),
      } } : {}),
    };
  }

  async function callTool(user, name, args, signal) {
    const writing = WRITE_TOOL_NAMES.has(name);
    if (!TOOL_NAMES.has(name) && !(writing && user.token?.scope === "write")) {
      throw new RpcError(-32602, writing ? `${name} needs an agent token that can add documents. Make one in Margin Chat: Settings, Agents.` : `Unknown tool: ${name}`);
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new RpcError(-32602, "Tool arguments must be an object.");
    if (!vaultService?.configured) return { ok: false, error: "This Margin Chat server has no cloud vault storage configured." };
    if (writing) return createWriteTools({ userId: user.id, vault: vaultService, agentName: user.token?.name }).run(name, args);
    // The agent reaches the whole vault: the member chose that by making the token.
    const tools = createVaultTools({
      chatRequest: { ai: { agentScope: "workspace" }, conversation: { id: "", ancestorContext: [] } },
      workspace: workspaceFor(user, signal), snapshots: new Map(), readCharacters: READ_CHARACTERS,
    });
    if (name === "search") {
      const found = await tools.run("search_vault", { query: args.query });
      if (found.ok === false) return found;
      return { results: found.results.map((hit) => ({ id: hit.document_id, title: hit.title ?? "Untitled", text: hit.snippet ?? "" })) };
    }
    if (name === "fetch") {
      const read = await tools.run("read_document", { document_id: args.id });
      if (!read.found) return { ok: false, error: read.error ?? "No document has that id." };
      const { document } = read;
      return { id: document.document_id, title: document.title ?? "Untitled", text: documentText(document),
        metadata: { kind: document.kind ?? null, parent_id: document.parent_id ?? null, updated_at: document.updated_at ?? null,
          truncated: Boolean(document.truncated) } };
    }
    return tools.run(name, args);
  }

  /** The answer to one JSON-RPC message, or null for a notification. */
  async function respond(message, user, { signal } = {}) {
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Send one JSON-RPC 2.0 message per request." } };
    }
    const isRequest = typeof message.method === "string" && message.id !== undefined && message.id !== null;
    // Notifications, and answers to requests we never make, need no reply.
    if (!isRequest) return null;
    const { id, method } = message;
    const params = message.params ?? {};
    try {
      let result;
      if (method === "initialize") {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : null;
        result = {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: `${INSTRUCTIONS} ${user.token?.scope === "write" ? WRITE_NOTE : READ_ONLY_NOTE}`,
        };
      } else if (method === "ping") {
        result = {};
      } else if (method === "tools/list") {
        result = { tools: mcpToolsFor(user.token?.scope) };
      } else if (method === "tools/call") {
        const output = await callTool(user, params.name, params.arguments ?? {}, signal);
        const failed = output?.ok === false;
        result = {
          content: [{ type: "text", text: failed ? output.error : JSON.stringify(output) }],
          ...(failed ? { isError: true } : { structuredContent: output }),
        };
      } else {
        throw new RpcError(-32601, `Method not found: ${method}`);
      }
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      if (error instanceof RpcError) return { jsonrpc: "2.0", id, error: { code: error.code, message: error.message } };
      throw error;
    }
  }

  return {
    respond,

    /** Who a request's Bearer token belongs to; throws 401 or 403 otherwise. */
    async authenticate(request) {
      const match = TOKEN_PATTERN.exec(String(request.headers.authorization ?? ""));
      if (!match) throw new HttpError(401, "Connect with a Margin Chat agent token: Settings, Connect agents.");
      const user = await database.authenticateMcpToken(hash(match[1]));
      if (!user) throw new HttpError(401, "This agent token was revoked or has expired. Make a new one in Margin Chat: Settings, Connect agents.");
      if (!canUseMcp(user)) throw new HttpError(403, "Connecting agents to your vault comes with the Plus and Cloud plans.");
      return user;
    },

    list(userId) {
      return database.listMcpTokens(userId);
    },

    async issue(user, input) {
      if (!canUseMcp(user)) throw new HttpError(403, "Connecting agents to your vault comes with the Plus and Cloud plans.");
      const name = typeof input?.name === "string" ? input.name.trim().replace(/\s+/gu, " ") : "";
      if (!name || name.length > NAME_LIMIT) throw new HttpError(400, `Name the token in 1 to ${NAME_LIMIT} characters, such as "Claude Code on my laptop".`);
      const scope = input?.scope ?? "read";
      if (scope !== "read" && scope !== "write") throw new HttpError(400, "A token's access is read or write.");
      const token = `mc_mcp_${randomBytes(32).toString("base64url")}`;
      const summary = await database.createMcpToken({
        userId: user.id, name, tokenHash: hash(token), scope, expiresAt: new Date(Date.now() + MCP_TOKEN_TTL_MS),
      });
      return { token, summary };
    },

    async revoke(userId, id) {
      if (!await database.deleteMcpToken({ userId, id })) throw new HttpError(404, "That agent token doesn't exist or was already revoked.");
    },
  };
}
