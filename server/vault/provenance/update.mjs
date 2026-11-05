import { randomUUID } from "node:crypto";
import {
  decodeReadableMarkdown,
  encodeReadableMarkdown,
  isReadableMarkdown,
  markedBlockIds,
  renderFrontmatterEntry,
  setFrontmatterEntries,
} from "@margin-chat/workspace-contracts";
import { PROTECTED_AUTHORS, documentLines, forwardBlocks, sha256, splitLines, wrapperFor } from "./lines.mjs";

/**
 * Line-level edits by a connected app (MCP `update_document`). Every operation
 * names its lines by the revision the agent read, and every line it replaces or
 * deletes must still hash to what the agent saw. Under the default policy no
 * operation may touch a line the member wrote (or one whose author is unknown):
 * if any does, nothing is applied. Insertions are never modifications.
 * Deterministic: no model is called anywhere here.
 */

export const MAX_OPERATIONS = 50;
export const MAX_NEW_TEXT = 20_000;
const REASON_CHARACTERS = 280;
const SNIPPET = 80;

export class UpdateRefused extends Error {
  constructor(code, status, message, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const refuse = (code, status, message, details) => { throw new UpdateRefused(code, status, message, details); };
const integer = (value) => Number.isSafeInteger(value);

/** Checks the shape of `operations` before anything is read. */
export function validateOperations(operations) {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_OPERATIONS) {
    refuse("INVALID_OPERATIONS", 400, `Send 1 to ${MAX_OPERATIONS} operations.`);
  }
  return operations.map((operation, index) => {
    const at = `Operation ${index + 1}`;
    if (!operation || typeof operation !== "object") refuse("INVALID_OPERATIONS", 400, `${at} must be an object.`);
    const op = operation.op;
    if (!["replace_lines", "insert_lines", "delete_lines", "append_block"].includes(op)) {
      refuse("INVALID_OPERATIONS", 400, `${at}: op is replace_lines, insert_lines, delete_lines or append_block.`);
    }
    const text = op === "delete_lines" ? "" : operation.new_text;
    if (typeof text !== "string") refuse("INVALID_OPERATIONS", 400, `${at} needs new_text.`);
    if (text.length > MAX_NEW_TEXT) refuse("INVALID_OPERATIONS", 400, `${at}: new_text can be at most ${MAX_NEW_TEXT} characters.`);
    if (op === "append_block") {
      if (!text.trim()) refuse("INVALID_OPERATIONS", 400, `${at}: append_block needs some text.`);
      return { index, op, text };
    }
    if (typeof operation.block_id !== "string" || !operation.block_id) refuse("INVALID_OPERATIONS", 400, `${at} needs a block_id.`);
    if (op === "insert_lines") {
      if (!integer(operation.after_line) || operation.after_line < -1) refuse("INVALID_OPERATIONS", 400, `${at}: after_line is -1 or a line number.`);
      if (!text.length) refuse("INVALID_OPERATIONS", 400, `${at}: insert_lines needs new_text.`);
      return { index, op, blockId: operation.block_id, after: operation.after_line, text };
    }
    const { start_line: start, end_line: end, expected_sha256: expected } = operation;
    if (!integer(start) || !integer(end) || start < 0 || end < start) refuse("INVALID_OPERATIONS", 400, `${at}: start_line and end_line are an inclusive range.`);
    if (!Array.isArray(expected) || expected.length !== end - start + 1 || expected.some((hash) => typeof hash !== "string")) {
      refuse("INVALID_OPERATIONS", 400, `${at}: expected_sha256 lists the hash of each line in the range, in order.`);
    }
    return { index, op, blockId: operation.block_id, start, end, expected, text };
  });
}

/** Each operation's span of base lines in its block: [from, to) replaced, or an insertion point. */
function spans(operations) {
  const byBlock = new Map();
  for (const operation of operations) {
    if (operation.op === "append_block") continue;
    if (!byBlock.has(operation.blockId)) byBlock.set(operation.blockId, []);
    byBlock.get(operation.blockId).push(operation.op === "insert_lines"
      ? { operation, from: operation.after + 1, to: operation.after + 1, insert: true }
      : { operation, from: operation.start, to: operation.end + 1, insert: false });
  }
  for (const list of byBlock.values()) {
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) {
        const [x, y] = [list[a], list[b]];
        // Two insertions at one point are fine (in order); anything else that meets overlaps.
        const overlap = x.insert && y.insert ? false
          : x.insert ? y.from < x.from && x.from < y.to
            : y.insert ? x.from < y.from && y.from < x.to
              : x.from < y.to && y.from < x.to;
        if (overlap) refuse("OVERLAPPING_OPERATIONS", 400, `Operations ${x.operation.index + 1} and ${y.operation.index + 1} touch the same lines of block ${x.operation.blockId}.`);
      }
    }
  }
  return byBlock;
}

const snippet = (line) => line.length > SNIPPET ? `${line.slice(0, SNIPPET - 1)}…` : line;

/**
 * Applies `operations` to a working copy of `file` (as read at the base
 * revision) whose current authorship is `blocks`. Returns the new block texts,
 * or throws UpdateRefused naming what blocked it. `policy` is the document's
 * agent-edit setting; "open" lets operations touch the member's lines.
 */
export function applyOperations({ file, blocks, operations, policy, createBlockId = () => `mcp-${randomUUID()}` }) {
  const authorship = new Map(blocks.map((block) => [block.blockId, block]));
  const byBlock = spans(operations);
  const offending = [];
  const next = file.blocks.map((block) => ({ ...block, lines: [...block.lines] }));
  for (const [blockId, list] of byBlock) {
    const target = next.find((block) => block.blockId === blockId);
    if (!target) refuse("BLOCK_NOT_FOUND", 404, `No block ${blockId} in this document. Read it again with include_authorship or get_document_blame.`);
    const base = file.blocks.find((block) => block.blockId === blockId).lines;
    const authors = authorship.get(blockId)?.lines ?? [];
    for (const { operation, from, to, insert } of list) {
      if (insert) {
        if (from > base.length) refuse("LINE_OUT_OF_RANGE", 400, `Operation ${operation.index + 1}: block ${blockId} has ${base.length} lines.`);
        continue;
      }
      if (to > base.length) refuse("LINE_OUT_OF_RANGE", 400, `Operation ${operation.index + 1}: block ${blockId} has ${base.length} lines.`);
      for (let line = from; line < to; line += 1) {
        if (sha256(base[line]) !== operation.expected[line - from]) {
          refuse("LINE_CHANGED", 409, `Line ${line} of block ${blockId} isn't what you read. Read the document again, then retry.`,
            { block_id: blockId, line });
        }
        const author = authors[line]?.author ?? { type: "unknown", label: "Unknown" };
        if (PROTECTED_AUTHORS.has(author.type) && policy !== "open" && offending.length < 10) {
          offending.push({ block_id: blockId, line, author_label: author.label ?? (author.type === "human" ? "You" : "Unknown"), snippet: snippet(base[line]) });
        }
      }
    }
    // Apply from the bottom up so earlier line numbers stay valid; insertions
    // at one point keep the order they were sent in.
    const ordered = [...list].sort((a, b) => b.from - a.from || (a.insert === b.insert ? b.operation.index - a.operation.index : a.insert ? 1 : -1));
    for (const { operation, from, to } of ordered) {
      const lines = operation.op === "delete_lines" || (operation.op === "replace_lines" && operation.text === "") ? [] : splitLines(operation.text);
      target.lines.splice(from, to - from, ...lines);
    }
  }
  if (offending.length) {
    refuse("PROTECTED_AUTHORSHIP", 403,
      "This update changes lines the user wrote, so nothing was changed. Edit only lines get_document_blame shows as not theirs, insert new lines around theirs, or add your suggestion as a new block.",
      { protected_lines: offending });
  }
  for (const operation of operations) {
    if (operation.op !== "append_block") continue;
    if (file.kind === "note") next[next.length - 1].lines.push("", ...splitLines(operation.text));
    else next.push({ blockId: createBlockId(), wrapper: "ai", origin: null, model: null, lines: splitLines(operation.text), added: true });
  }
  return next;
}

/**
 * The member's lines must come through untouched and in the same order, whatever
 * the operations said: checked again on the diff of the result, so no bug in
 * applying operations can slip a change to them past the gate.
 */
export function assertProtectedLinesKept({ before, after, policy }) {
  if (policy === "open") return;
  const kept = (blocks) => blocks.flatMap((block) => block.lines.filter((line) => PROTECTED_AUTHORS.has(line.author.type))
    .map((line) => `${block.blockId}\u0000${line.sha256}\u0000${line.originRevisionId}`));
  const was = kept(before);
  const now = kept(after);
  if (was.length !== now.length || was.some((line, index) => line !== now[index])) {
    refuse("PROTECTED_AUTHORSHIP", 403, "This update would move or change lines the user wrote, so nothing was changed.");
  }
}

function escapeForCompact(value) {
  return JSON.stringify(value);
}

/**
 * The file's new Markdown with its blocks set to `blocks`, written the way the
 * app writes it (the same portable format, wrappers derived from line authors),
 * and `updated` set to `now`. Returns null when the file can't be edited this way.
 */
export function rewriteSource({ source, file, blocks, sidecarBlocks, now }) {
  const readable = isReadableMarkdown(source);
  let compact = readable ? decodeReadableMarkdown(source) : source;
  if (file.kind === "note") {
    const before = file.blocks[0].lines.join("\n");
    const after = blocks[0].lines.join("\n");
    const at = compact.lastIndexOf(before);
    if (at < 0 || compact.slice(at + before.length).trim() !== "") return null;
    compact = compact.slice(0, at) + after + compact.slice(at + before.length);
  } else {
    const wrapper = new Map(sidecarBlocks.map((block) => [block.blockId, wrapperFor(block.lines)]));
    const stamp = now.toISOString();
    for (const block of blocks) {
      if (block.added) continue;
      const original = file.blocks.find((candidate) => candidate.blockId === block.blockId);
      const content = block.lines.join("\n");
      if (original.lines.join("\n") === content) continue;
      const marker = new RegExp(`^<!-- margin-chat-document-block (.+) -->\\r?\\n`, "gm");
      const ending = `\n<!-- margin-chat-document-block-end ${JSON.stringify(block.blockId)} -->`;
      let found = null;
      for (const match of compact.matchAll(marker)) {
        let metadata;
        try { metadata = JSON.parse(match[1]); } catch { continue; }
        if (metadata?.id !== block.blockId) continue;
        const contentStart = match.index + match[0].length;
        const contentEnd = compact.indexOf(ending, contentStart);
        if (contentEnd < 0 || compact.slice(contentStart, contentEnd).replace(/\r\n/g, "\n") !== original.lines.join("\n")) return null;
        found = { start: match.index, contentEnd, metadata };
        break;
      }
      if (!found) return null;
      const { contentLength: _length, ...metadata } = found.metadata;
      const authorship = wrapper.get(block.blockId);
      const next = { ...metadata, updatedAt: stamp, ...(authorship ? { authorship } : {}), contentLength: content.length };
      compact = `${compact.slice(0, found.start)}<!-- margin-chat-document-block ${escapeForCompact(next)} -->\n${content}${compact.slice(found.contentEnd)}`;
    }
    const added = blocks.filter((block) => block.added);
    if (added.length) {
      const end = "<!-- margin-chat-document-end -->";
      const at = compact.indexOf(end);
      if (at < 0 || compact.indexOf(end, at + 1) >= 0) return null;
      const text = added.map((block) => {
        const content = block.lines.join("\n");
        const metadata = { id: block.blockId, kind: "markdown", createdAt: stamp, updatedAt: stamp, authorship: wrapper.get(block.blockId) ?? "ai", contentLength: content.length };
        return `<!-- margin-chat-document-block ${escapeForCompact(metadata)} -->\n${content}\n<!-- margin-chat-document-block-end ${JSON.stringify(block.blockId)} -->\n\n`;
      }).join("");
      compact = compact.slice(0, at) + text + compact.slice(at);
    }
  }
  let result = readable ? encodeReadableMarkdown(compact, { referencedBlockIds: markedBlockIds(source) }) : compact;
  result = setFrontmatterEntries(result, { updated: renderFrontmatterEntry("updated", now.toISOString()) });
  // Read it back: exactly the intended lines, nothing else changed.
  const reread = documentLines(file.path, result);
  if (!reread || reread.documentId !== file.documentId || reread.blocks.length !== blocks.length
    || reread.blocks.some((block, index) => block.blockId !== blocks[index].blockId || block.lines.join("\n") !== blocks[index].lines.join("\n"))) return null;
  return result;
}

/** Counts of lines added, modified and deleted between two versions of a document's blocks. */
export function changeCounts(beforeBlocks, afterBlocks, diff) {
  const counts = { added: 0, modified: 0, deleted: 0 };
  const before = new Map(beforeBlocks.map((block) => [block.blockId, block.lines]));
  for (const block of afterBlocks) {
    const old = before.get(block.blockId) ?? [];
    before.delete(block.blockId);
    let inserted = 0;
    let removed = 0;
    const flush = () => {
      const modified = Math.min(inserted, removed);
      counts.modified += modified;
      counts.added += inserted - modified;
      counts.deleted += removed - modified;
      inserted = 0;
      removed = 0;
    };
    for (const step of diff(old, block.lines)) {
      if (step.type === "equal") flush();
      else if (step.type === "insert") inserted += 1;
      else removed += 1;
    }
    flush();
  }
  for (const lines of before.values()) counts.deleted += lines.length;
  return counts;
}

export function cleanReason(reason) {
  return typeof reason === "string" && reason.trim() ? reason.trim().slice(0, REASON_CHARACTERS) : undefined;
}

export { forwardBlocks };
