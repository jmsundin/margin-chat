import { randomUUID } from "node:crypto";
import {
  DOCUMENT_RELATION_TYPES,
  discoverMarkdownWorkspace,
  isSafeMarkdownPath,
  parseMarkdownWorkspace,
  readFrontmatterValue,
  renderFrontmatterEntry,
  setFrontmatterEntries,
} from "@margin-chat/workspace-contracts";

/**
 * Tools that let an agent with a write token add to the vault. Agents only ever add:
 * they make new documents and append to existing ones; nothing is replaced or deleted.
 * Every change is saved through the vault's normal commit, so a conflicting edit from
 * another device is refused rather than overwritten, and open apps pick it up on sync.
 */

export const MAX_WRITE_CHARACTERS = 100_000;
const TITLE_CHARACTERS = 120;
const RELATION_IDS = DOCUMENT_RELATION_TYPES.map((type) => type.id);
const DOCUMENT_END = "<!-- margin-chat-document-end -->";
const ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export const WRITE_TOOL_DEFINITIONS = [
  {
    name: "create_document",
    title: "Create document",
    description: "Create a new document in the user's Margin Chat vault from Markdown. Optionally connect it on the map to existing documents with typed relations (for example part-of an existing project document). Returns the new document_id.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The document's title." },
        content: { type: "string", description: "The document's body in Markdown. Don't repeat the title as a heading." },
        relations: {
          type: "array",
          description: "Optional links from the new document to existing ones.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: RELATION_IDS, description: "How the new document relates to the target." },
              document_id: { type: "string", description: "An existing document_id from search_vault." },
            },
            required: ["type", "document_id"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
    annotations: ADDITIVE,
  },
  {
    name: "append_to_document",
    title: "Append to document",
    description: "Add Markdown to the end of an existing document or note in the user's Margin Chat vault. Existing text is never changed. Chats can't be appended to.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "Exact document ID from search_vault." },
        content: { type: "string", description: "Markdown to add at the end." },
      },
      required: ["document_id", "content"],
      additionalProperties: false,
    },
    annotations: ADDITIVE,
  },
];

const fail = (error) => ({ ok: false, error });

/** A file name a title can live under: no path separators or characters other systems refuse. */
export function documentFileName(title) {
  const base = title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|#^[\]]+/gu, " ").replace(/\s+/gu, " ").trim()
    .replace(/^\.+/u, "").slice(0, TITLE_CHARACTERS).trim();
  return base || "Untitled";
}

/** True when the file still reads as exactly one item with this identity. */
function readsAs(path, source, id) {
  try {
    const { manifest, files } = discoverMarkdownWorkspace({ [path]: source });
    return manifest.files.length === 1 && manifest.files[0].id === id && parseMarkdownWorkspace(manifest, files) !== null;
  } catch {
    return false;
  }
}

/** The text with `addition` placed at the end of its readable body, or null when it has no such place. */
export function appendToSource(source, addition) {
  const end = source.lastIndexOf(DOCUMENT_END);
  if (end !== -1) {
    // After the last block: the app reads it as a new paragraph block written by the user.
    return `${source.slice(0, end).replace(/\s*$/u, "")}\n\n${addition}\n\n${source.slice(end)}`;
  }
  if (readFrontmatterValue(source, "margin-chat") === undefined) {
    // A plain Markdown file, as Obsidian or an agent writes it.
    return `${source.replace(/\s*$/u, "")}\n\n${addition}`;
  }
  const note = /\n<\/user>\s*$/u.exec(source);
  if (note && /<user note-id="/u.test(source)) {
    return `${source.slice(0, note.index).replace(/\s*$/u, "")}\n\n${addition}\n\n</user>\n`;
  }
  return null;
}

export function createWriteTools({ userId, vault, agentName, quotaBytes, now = () => new Date() }) {
  const entries = async () => (await vault.index(userId)).entries;

  async function commit(change) {
    try {
      await vault.commit(userId, [change], { quotaBytes });
      return null;
    } catch (error) {
      if (error?.statusCode === 409) return fail("That document changed on another device just now. Read it again, then retry.");
      if (error?.statusCode === 413) return fail(error.message);
      throw error;
    }
  }

  async function create(args) {
    const title = typeof args.title === "string" ? args.title.trim().replace(/\s+/gu, " ") : "";
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!title) return fail("Give the document a title.");
    if (content.length > MAX_WRITE_CHARACTERS) return fail(`Documents can hold at most ${MAX_WRITE_CHARACTERS} characters at a time.`);
    const relations = Array.isArray(args.relations) ? args.relations : [];
    if (relations.length > 20) return fail("Link a new document to at most 20 others.");
    const listed = await entries();
    const byId = new Map(listed.filter((entry) => entry.type === "conversation").map((entry) => [entry.id, entry]));
    const links = new Map();
    for (const relation of relations) {
      if (!RELATION_IDS.includes(relation?.type)) return fail(`Relation types are ${RELATION_IDS.join(", ")}.`);
      const target = byId.get(String(relation.document_id ?? ""));
      if (!target) return fail(`No document has the id ${relation.document_id}.`);
      const link = `[[${target.path.replace(/\.md$/iu, "")}|${target.title.replace(/[[\]|]/gu, " ")}]]`;
      links.set(relation.type, [...new Set([...(links.get(relation.type) ?? []), link])]);
    }
    const taken = new Set(listed.map((entry) => entry.path.toLowerCase()));
    const base = documentFileName(title);
    let path = `${base}.md`;
    for (let copy = 2; taken.has(path.toLowerCase()); copy += 1) path = `${base} ${copy}.md`;
    if (!isSafeMarkdownPath(path)) return fail("That title can't be used as a file name. Try a shorter, plainer title.");
    const id = `mcp-${randomUUID()}`;
    const stamp = now().toISOString();
    const frontmatter = [
      renderFrontmatterEntry("margin-chat-id", id),
      renderFrontmatterEntry("title", title),
      renderFrontmatterEntry("created", stamp),
      renderFrontmatterEntry("updated", stamp),
      ...(agentName ? [renderFrontmatterEntry("created-by", agentName)] : []),
      ...[...links].map(([type, targets]) => renderFrontmatterEntry(type, targets)),
    ];
    // The body starts right after the frontmatter and has no final newline, so it reads back exactly as written.
    const source = `---\n${frontmatter.join("\n")}\n---\n${content}`;
    if (!readsAs(path, source, id)) return fail("That content couldn't be saved as a Margin Chat document.");
    const failed = await commit({ path, content: source, baseRevision: null });
    return failed ?? { ok: true, document_id: id, title, path };
  }

  async function append(args) {
    const id = String(args.document_id ?? "");
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!content) return fail("There's nothing to append.");
    if (content.length > MAX_WRITE_CHARACTERS) return fail(`Append at most ${MAX_WRITE_CHARACTERS} characters at a time.`);
    const entry = (await entries()).find((candidate) => candidate.id === id && candidate.type === "conversation");
    if (!entry) return { document_id: id, found: false, ok: false, error: "No document has that id." };
    const { bytes, revision } = await vault.readFile({ userId, path: entry.path, revision: entry.revision });
    const source = bytes.toString("utf8");
    const appended = appendToSource(source, content);
    if (appended === null) return fail("This item is a chat, which can't be appended to. Create a new document instead.");
    const next = setFrontmatterEntries(appended, { updated: renderFrontmatterEntry("updated", now().toISOString()) });
    if (!readsAs(entry.path, next, id)) return fail("That content couldn't be added without damaging the document.");
    const failed = await commit({ path: entry.path, content: next, baseRevision: revision });
    return failed ?? { ok: true, document_id: id, title: entry.title };
  }

  const handlers = { create_document: create, append_to_document: append };
  return {
    has: (name) => Object.hasOwn(handlers, name),
    async run(name, args) {
      try {
        return await handlers[name](args);
      } catch (error) {
        console.error("MCP write tool failed", error);
        return fail("The vault couldn't be saved just now. Nothing was changed.");
      }
    },
  };
}
