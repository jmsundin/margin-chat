import { VAULT_TOOL_DEFINITIONS, createVaultTools, vaultToolAccess } from "./vaultTools.mjs";

function clipText(value, maximum = 220) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function safeSnapshot(item) {
  const note = typeof item.content === "string";
  return {
    id: item.id,
    title: String(item.title ?? ""),
    kind: note ? "note" : "chat",
    parentId: item.parentId ?? null,
    updatedAt: item.updatedAt ?? "",
    branchAnchor: item.branchAnchor ? { quote: item.branchAnchor.quote, prompt: item.branchAnchor.prompt } : null,
    messages: note ? [{ id: `${item.id}-body`, role: "user", content: item.content }] : (item.messages ?? [])
      .filter((message) => message.role !== "system")
      .map(({ id, role, content }) => ({ id, role, content })),
  };
}

function permittedSnapshots(chatRequest) {
  const ai = chatRequest.ai ?? { contextScope: "conversation", selectedConversationIds: [] };
  const selected = new Set(ai.selectedConversationIds ?? []);
  const workspace = (chatRequest.workspaceContext ?? []).filter((item) => chatRequest.contextPrepared ||
    ai.contextScope === "workspace" || (ai.contextScope === "selected" && selected.has(item.id)));
  const items = [
    ...workspace,
    ...(chatRequest.conversation.ancestorContext ?? []),
    { ...chatRequest.conversation, messages: chatRequest.messages },
  ];
  // Local request state is authoritative. Never load the database as a fallback:
  // a missing snapshot does not grant access to the rest of a user's workspace.
  return new Map(items.map((item) => [item.id, safeSnapshot(item)]));
}

function summarize(item) {
  return {
    conversation_id: item.id,
    kind: item.kind,
    title: item.title,
    parent_id: item.parentId,
    updated_at: item.updatedAt,
    message_count: item.messages.length,
    preview: clipText(item.messages.at(-1)?.content, 160),
  };
}

/** Provider-neutral definitions; each adapter wraps them in its own tool format. */
export const AGENT_TOOL_DEFINITIONS = [
  {
    name: "search_conversations",
    description: "Search only the permitted local conversation and note snapshot supplied for this request. Private margin annotations are excluded.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Text to find in permitted titles and content." } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "list_recent_conversations",
    description: "List recent conversations and notes within this request's permitted local snapshot.",
    parameters: { type: "object", properties: { limit: { type: "integer", description: "Number of items, from 1 to 10." } }, required: ["limit"], additionalProperties: false },
  },
  {
    name: "get_conversation",
    description: "Read a conversation or note from this request's permitted local snapshot. Other content is unavailable.",
    parameters: { type: "object", properties: { conversation_id: { type: "string", description: "Exact permitted conversation or note ID." } }, required: ["conversation_id"], additionalProperties: false },
  },
];

/** The tools offered to this request: the snapshot tools, plus the vault tools when the user's AI context allows them. */
export function agentToolDefinitions(chatRequest, workspace = null) {
  return vaultToolAccess(chatRequest, workspace) ? [...AGENT_TOOL_DEFINITIONS, ...VAULT_TOOL_DEFINITIONS] : AGENT_TOOL_DEFINITIONS;
}

/** `workspace` is `{ userId, vault, database }` for a signed-in request, or null. */
export function createAgentToolExecutor({ chatRequest, workspace = null }) {
  const snapshots = permittedSnapshots(chatRequest);
  let remainingCharacters = chatRequest.ai?.mode === "fast" ? 6_000 : chatRequest.ai?.mode === "thorough" ? 24_000 : 12_000;
  const vaultTools = createVaultTools({ chatRequest, workspace, snapshots, readCharacters: Math.floor(remainingCharacters / 3) });

  return async function executeTool(name, args = {}) {
    let result;
    if (name === "search_conversations") {
      const query = String(args.query ?? "").trim().toLowerCase();
      const tokens = query.split(/\s+/).filter(Boolean);
      const matches = query ? [...snapshots.values()].map((item) => {
        const title = item.title.toLowerCase();
        const text = [title, item.branchAnchor?.quote, item.branchAnchor?.prompt, ...item.messages.map((message) => message.content)].join("\n").toLowerCase();
        const score = tokens.reduce((sum, token) => sum + (title.includes(token) ? 3 : text.includes(token) ? 1 : 0), 0);
        return { item, score };
      }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score) : [];
      result = { query, matches: matches.slice(0, 6).map(({ item }) => summarize(item)), total_matches: matches.length, truncated: matches.length > 6 };
    } else if (name === "list_recent_conversations") {
      const count = Math.max(1, Math.min(10, Math.floor(Number(args.limit)) || 5));
      const items = [...snapshots.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      result = { conversations: items.slice(0, count).map(summarize), total_returned: Math.min(count, items.length), truncated: items.length > count };
    } else if (name === "get_conversation") {
      const item = snapshots.get(String(args.conversation_id ?? ""));
      if (!item) result = { conversation_id: String(args.conversation_id ?? ""), found: false };
      else {
        const messages = item.messages.slice(-12).map((message) => ({ ...message, content: clipText(message.content, 700) }));
        const truncated = messages.length < item.messages.length || item.messages.slice(-12).some((message) => message.content.length > 700);
        result = { found: true, conversation: {
          id: item.id, kind: item.kind, title: item.title, parent_id: item.parentId,
          updated_at: item.updatedAt, branch_anchor: item.branchAnchor,
          messages, message_count: item.messages.length,
          truncated_message_count: item.messages.length - messages.length, truncated,
        } };
      }
    } else if (vaultTools?.has(name)) {
      result = await vaultTools.run(name, args);
    } else result = { ok: false, error: "Unknown workspace tool." };
    const size = JSON.stringify(result).length;
    if (size > remainingCharacters) return { ok: false, truncated: true, error: "The context budget for workspace tools is exhausted. Answer from the supplied context and disclose any missing information." };
    remainingCharacters -= size;
    return result;
  };
}

const quoted = (value, maximum = 80) => `\u201c${clipText(value, maximum) || "Untitled"}\u201d`;
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : word.endsWith("h") ? "es" : "s"}`;

function describeVaultStep(name, args, output, exhausted) {
  if (output?.ok === false && !exhausted) return { label: "Couldn't reach your saved vault", detail: null };
  if (name === "search_vault") {
    const total = output.total_matches ?? 0;
    return { label: `Searched your vault for ${quoted(args.query)}`, detail: exhausted ? null : `${plural(total, "result")}${output.truncated && total >= 8 ? "+" : ""}` };
  }
  if (exhausted) return { label: name === "read_document" ? "Tried to read a document" : "Tried to check a document's connections", detail: null };
  if (!output?.found) return { label: output?.error ? "Tried to open a document outside the allowed context" : "Couldn't find a document", detail: null };
  return name === "read_document"
    ? { label: `Read ${quoted(output.document?.title)}`, detail: output.document?.truncated ? "Shortened to fit" : null }
    : { label: `Checked what's connected to ${quoted(output.document?.title)}`, detail: plural(output.total_related ?? 0, "connection") };
}

/** A short, human-readable line for the run log. Never includes tool output text. */
export function describeAgentStep(name, args = {}, output = {}) {
  const exhausted = output?.ok === false && output?.truncated;
  const base = VAULT_TOOL_DEFINITIONS.some((tool) => tool.name === name) ? describeVaultStep(name, args, output, exhausted)
    : name === "search_conversations" ? { label: `Searched for ${quoted(args.query)}`, detail: exhausted ? null : plural(output.total_matches ?? 0, "match") }
    : name === "list_recent_conversations" ? { label: "Listed recent chats and notes", detail: exhausted ? null : plural(output.total_returned ?? 0, "item") }
    : name === "get_conversation" ? (output?.found
      ? { label: `Read ${quoted(output.conversation?.title)}`, detail: output.conversation?.truncated ? "Shortened to fit" : null }
      : { label: "Tried to open an item outside the permitted context", detail: null })
    : { label: "Tried a tool that isn't available", detail: null };
  const failed = output?.ok === false || ((name === "get_conversation" || name === "read_document" || name === "list_related") && !output?.found);
  return { kind: "tool", tool: name, label: base.label, ...(exhausted ? { detail: "Context budget for tools used up" } : base.detail ? { detail: base.detail } : {}),
    ok: !failed };
}
