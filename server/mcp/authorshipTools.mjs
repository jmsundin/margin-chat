import {
  PROTECTED_AUTHORS,
  diffSequences,
  documentLines,
  forwardBlocks,
  inferBlocks,
  summarizeBlocks,
} from "../vault/provenance/lines.mjs";
import { ownerActor } from "../vault/provenance/store.mjs";
import {
  UpdateRefused,
  applyOperations,
  assertProtectedLinesKept,
  changeCounts,
  cleanReason,
  rewriteSource,
  validateOperations,
  MAX_NEW_TEXT,
  MAX_OPERATIONS,
} from "../vault/provenance/update.mjs";

/**
 * Line authorship for connected apps: who wrote each line (get_document_blame,
 * read_document with include_authorship) and line edits to what the member
 * didn't write (update_document). The member's lines, and lines whose author is
 * unknown, can't be changed, moved or deleted unless the member set the
 * document's agent editing to "open" in the app; no tool here can change that.
 */

const REVISION = /^[a-f0-9]{64}$/u;
// What read_document returns per line, at most, before it stops adding authorship.
const AUTHORSHIP_CHARACTERS = 60_000;
const ORIGIN_LOOKUPS = 40;

const lineHashes = { type: "array", items: { type: "string" }, description: "The sha256 of each line being replaced, in order, as read." };

export const BLAME_TOOL_DEFINITION = {
  name: "get_document_blame",
  title: "Who wrote each line",
  description: "Show who wrote each line of a document or note: the user, Margin Chat's AI, a connected app, an import, or Unknown. Lines by the user or Unknown can't be changed with update_document. Call this (or read_document with include_authorship) before drafting an update.",
  inputSchema: {
    type: "object",
    properties: {
      document_id: { type: "string", description: "Exact document ID from search_vault." },
      block_id: { type: "string", description: "Optional: only this block." },
    },
    required: ["document_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export const UPDATE_TOOL_DEFINITION = {
  name: "update_document",
  title: "Update document",
  description: [
    "Edit lines of a document or note in the user's Margin Chat vault that the user didn't write, such as text an AI or another app added.",
    "Workflow: read_document with include_authorship (or get_document_blame) → change only lines not by the user → update_document with the revision and line hashes you read.",
    "Lines the user wrote can't be changed, moved or deleted: if any operation touches one, nothing is applied and the error lists those lines. You may insert new lines between theirs, or add a suggestion as a new block.",
    "Chats, PDFs and uploaded files can't be updated. No titles, frontmatter, renames or deletions.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      document_id: { type: "string", description: "Exact document ID from search_vault." },
      base_revision_id: { type: "string", description: "The revision_id you read. If the document changed since, the update is refused; read again and retry." },
      reason: { type: "string", description: "Optional, at most 280 characters: why, kept with the revision." },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: MAX_OPERATIONS,
        description: "Applied together to the revision you read; line numbers are that revision's, 0-based within each block. Operations on one block may not overlap.",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["replace_lines", "insert_lines", "delete_lines", "append_block"] },
            block_id: { type: "string", description: "The block's id (not for append_block)." },
            start_line: { type: "integer", minimum: 0, description: "replace_lines, delete_lines: first line of the inclusive range." },
            end_line: { type: "integer", minimum: 0, description: "replace_lines, delete_lines: last line of the inclusive range." },
            after_line: { type: "integer", minimum: -1, description: "insert_lines: insert after this line; -1 inserts before the first." },
            expected_sha256: lineHashes,
            new_text: { type: "string", maxLength: MAX_NEW_TEXT, description: "Markdown; may span several lines. Empty with replace_lines deletes the range." },
          },
          required: ["op"],
          additionalProperties: false,
        },
      },
    },
    required: ["document_id", "base_revision_id", "operations"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

const fail = (code, status, error, details = {}) => ({ ok: false, code, status, error, ...details });
const publicAuthor = (author) => ({ type: author.type, label: author.label ?? (author.type === "human" ? "You" : author.type === "unknown" ? "Unknown" : null) });

export function createAuthorshipTools({ userId, vault, database, actor = null, quotaBytes, now = () => new Date() }) {
  let listed;
  const entries = () => (listed ??= vault.index(userId).then((index) => index.entries.filter((entry) => entry.type === "conversation")));
  let hidden;
  const hiddenIds = () => (hidden ??= Promise.all([
    entries().then((items) => items.filter((entry) => entry.hiddenFromAI).map((entry) => entry.id)),
    database?.listAIHiddenIds ? database.listAIHiddenIds({ userId }) : [],
  ]).then(([fromFiles, stored]) => new Set([...fromFiles, ...stored])));

  /** The document as it is now: its file, revision, parsed lines and current line authors. */
  async function load(id) {
    const entry = (await entries()).find((candidate) => candidate.id === id);
    if (!entry || (await hiddenIds()).has(id)) return { missing: true };
    const { bytes, revision } = await vault.readFile({ userId, path: entry.path });
    const source = bytes.toString("utf8");
    const file = documentLines(entry.path, source);
    if (!file || file.documentId !== id) return { entry, source, revision, file: null };
    const sidecar = await vault.provenance?.current(userId, id, revision).catch(() => null);
    // Without a recorded sidecar, read the wrappers as the backfill does: never guess in an agent's favour.
    const blocks = sidecar?.blocks ?? inferBlocks(file, `inferred:${revision}`, ownerActor(userId));
    return { entry, source, revision, file, blocks, inferred: !sidecar };
  }

  async function originTimes(userId_, documentId, blocks) {
    const keys = [...new Set(blocks.flatMap((block) => block.lines.map((line) => line.originRevisionId)))].filter((key) => !key.startsWith("inferred:"));
    const times = {};
    await Promise.all(keys.slice(0, ORIGIN_LOOKUPS).map(async (key) => {
      const sidecar = await vault.provenance?.readSidecar(userId_, documentId, key).catch(() => null);
      if (sidecar?.createdAt) times[key] = sidecar.createdAt;
    }));
    return times;
  }

  async function blame(args) {
    const id = String(args.document_id ?? "");
    const loaded = await load(id);
    if (loaded.missing) return { document_id: id, found: false, ok: false, error: "No document has that id, or it is outside what the user allowed for AI." };
    if (!loaded.file) return fail("UNSUPPORTED_KIND", 400, "Only documents and notes have line authorship; chats and files don't.");
    const wanted = args.block_id === undefined ? loaded.blocks : loaded.blocks.filter((block) => block.blockId === String(args.block_id));
    if (args.block_id !== undefined && !wanted.length) return fail("BLOCK_NOT_FOUND", 404, `No block ${args.block_id} in this document.`);
    const times = await originTimes(userId, id, wanted);
    return {
      document_id: id, revision_id: loaded.revision, agent_edit: loaded.file.agentEdit,
      summary: summarizeBlocks(loaded.blocks),
      ...(loaded.inferred ? { inferred: true } : {}),
      blocks: wanted.map((block) => ({ block_id: block.blockId, lines: block.lines.map((line) => ({
        i: line.i, sha256: line.sha256, author: publicAuthor(line.author),
        origin_revision_id: line.originRevisionId, origin_at: times[line.originRevisionId] ?? null,
      })) })),
    };
  }

  /** What read_document adds with include_authorship: the revision, totals and each block's lines with their authors. */
  async function readAuthorship(id) {
    const loaded = await load(id);
    if (loaded.missing || !loaded.file) return null;
    const byId = new Map(loaded.blocks.map((block) => [block.blockId, block]));
    let budget = AUTHORSHIP_CHARACTERS;
    let truncated = false;
    const blocks = [];
    for (const block of loaded.file.blocks) {
      const lines = block.lines;
      const cost = lines.reduce((total, line) => total + line.length + 100, 0);
      if (cost > budget) { truncated = true; break; }
      budget -= cost;
      const authors = byId.get(block.blockId)?.lines ?? [];
      blocks.push({ block_id: block.blockId, lines: lines.map((text, index) => ({
        i: index, text, sha256: authors[index]?.sha256, author: publicAuthor(authors[index]?.author ?? { type: "unknown" }),
        origin_revision_id: authors[index]?.originRevisionId ?? null,
      })) });
    }
    const summary = summarizeBlocks(loaded.blocks);
    return { revision_id: loaded.revision, agent_edit: loaded.file.agentEdit,
      authorship: { humanLines: summary.humanLines, unknownLines: summary.unknownLines, totalLines: summary.totalLines },
      blocks, ...(truncated ? { authorship_truncated: true } : {}) };
  }

  async function update(args) {
    const id = String(args.document_id ?? "");
    const base = String(args.base_revision_id ?? "");
    if (!REVISION.test(base)) return fail("INVALID_OPERATIONS", 400, "base_revision_id is the revision_id you read.");
    try {
      const operations = validateOperations(args.operations);
      const loaded = await load(id);
      if (loaded.missing) return { document_id: id, found: false, ok: false, error: "No document has that id, or it is outside what the user allowed for AI." };
      const { file } = loaded;
      if (!file || file.hasOriginal) {
        return fail("UNSUPPORTED_KIND", 400, "Chats, PDFs and uploaded files can't be updated. Create a new document or append a note instead.");
      }
      if (file.agentEdit === "locked") {
        return fail("DOCUMENT_LOCKED", 403, "The user locked this document against edits by connected apps. You can still append to it.");
      }
      if (loaded.revision !== base) {
        return fail("STALE_REVISION", 409, "This document changed since you read it. Read it again, then retry.", { current_revision_id: loaded.revision });
      }
      const blocks = applyOperations({ file, blocks: loaded.blocks, operations, policy: file.agentEdit });
      const next = { ...file, blocks };
      const authored = forwardBlocks({ parentBlocks: loaded.blocks, file: next, revisionKey: "pending", authorFor: () => actor });
      assertProtectedLinesKept({ before: loaded.blocks, after: authored, policy: file.agentEdit });
      const source = rewriteSource({ source: loaded.source, file, blocks, sidecarBlocks: authored, now: now() });
      if (source === null) return fail("UNEDITABLE", 422, "This document couldn't be changed that way without damaging it. Nothing was changed.");
      let receipt;
      try {
        receipt = await vault.commit(userId, [{ path: loaded.entry.path, content: source, baseRevision: loaded.revision }], {
          quotaBytes, authorship: { wait: true, actor, source: "mcp", reason: cleanReason(args.reason), authorFor: () => actor },
        });
      } catch (error) {
        if (error?.statusCode === 409) return fail("STALE_REVISION", 409, "This document changed on another device just now. Read it again, then retry.");
        if (error?.statusCode === 413) return fail("TOO_LARGE", 413, error.message);
        throw error;
      }
      const sidecar = receipt?.authorship?.[loaded.entry.path];
      const summary = summarizeBlocks(sidecar?.blocks ?? authored);
      return {
        ok: true, document_id: id,
        revision_id: sidecar?.revisionId ?? receipt?.manifest?.files?.[loaded.entry.path]?.revision ?? null,
        previous_revision_id: loaded.revision,
        changed: changeCounts(file.blocks, blocks, diffSequences),
        authorship: { humanLines: summary.humanLines, totalLines: summary.totalLines },
        ...(receipt?.projection && receipt.projection.status !== "ready" ? { projection: "pending" } : {}),
      };
    } catch (error) {
      if (error instanceof UpdateRefused) return fail(error.code, error.status, error.message, error.details);
      throw error;
    }
  }

  /** Authorship totals for search results, keyed by document id. */
  async function summaries(ids) {
    if (!ids.length || !database?.readDocumentAuthorship) return {};
    return database.readDocumentAuthorship({ userId, documentIds: ids }).catch(() => ({}));
  }

  return { blame, update, readAuthorship, summaries };
}

/** Whether a document's totals pass search_vault's `author` filter. */
export function matchesAuthorFilter(filter, totals) {
  if (!filter || filter === "any") return true;
  if (!totals) return false;
  if (filter === "mine") return totals.humanLines > 0;
  if (filter === "not-mine") return totals.humanLines === 0;
  return (totals[`${filter}Lines`] ?? 0) > 0;
}

export { PROTECTED_AUTHORS };
