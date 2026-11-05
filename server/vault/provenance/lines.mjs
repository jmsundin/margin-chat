import { createHash } from "node:crypto";
import {
  discoverMarkdownWorkspace,
  getDocumentBlockAuthorship,
  parseMarkdownWorkspace,
  readAgentEditPolicy,
  readFrontmatterValue,
} from "@margin-chat/workspace-contracts";

/**
 * Line authorship: who wrote each line of a document, worked out the way `git
 * blame` does it. A revision's lines are diffed against its parent's; a line
 * that survives unchanged keeps the author it had, and a new or changed line
 * belongs to whoever made this revision. Nothing here is written into the
 * Markdown itself, and no model is ever called.
 */

export const SIDECAR_SCHEMA = 1;
/** Line authors that count as Jon's own words for the agent-edit gate. */
export const PROTECTED_AUTHORS = new Set(["human", "unknown"]);
export const AUTHOR_TYPES = ["human", "ai", "agent", "import", "system", "unknown"];

export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Physical lines of a block's Markdown: split on \n, a trailing \r dropped, nothing else changed. */
export function splitLines(text) {
  return String(text ?? "").split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

/** The context hash of each line: its neighbours disambiguate repeated and blank lines. */
export function contextHashes(lines) {
  return lines.map((line, index) => sha256(`${lines[index - 1] ?? ""}\n${line}\n${lines[index + 1] ?? ""}`));
}

/**
 * Myers' O(ND) diff of two sequences of keys. Returns one entry per element, in
 * order: `equal` (with both indexes), `delete` (old index) or `insert` (new index).
 */
export function diffSequences(before, after) {
  const n = before.length;
  const m = after.length;
  let start = 0;
  while (start < n && start < m && before[start] === after[start]) start += 1;
  let endBefore = n;
  let endAfter = m;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore -= 1; endAfter -= 1; }
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  const middle = myers(a, b);
  const result = [];
  for (let index = 0; index < start; index += 1) result.push({ type: "equal", before: index, after: index });
  for (const step of middle) {
    if (step.type === "equal") result.push({ type: "equal", before: step.before + start, after: step.after + start });
    else if (step.type === "delete") result.push({ type: "delete", before: step.before + start });
    else result.push({ type: "insert", after: step.after + start });
  }
  for (let offset = 0; offset < n - endBefore; offset += 1) result.push({ type: "equal", before: endBefore + offset, after: endAfter + offset });
  return result;
}

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((_, index) => ({ type: "insert", after: index }));
  if (!m) return a.map((_, index) => ({ type: "delete", before: index }));
  const max = n + m;
  const offset = max;
  let v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  const steps = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const previous = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && previous[offset + k - 1] < previous[offset + k + 1]);
    const priorK = down ? k + 1 : k - 1;
    const priorX = previous[offset + priorK];
    const priorY = priorX - priorK;
    while (x > priorX && y > priorY) { x -= 1; y -= 1; steps.push({ type: "equal", before: x, after: y }); }
    if (down) { y -= 1; steps.push({ type: "insert", after: y }); }
    else { x -= 1; steps.push({ type: "delete", before: x }); }
  }
  while (x > 0 && y > 0) { x -= 1; y -= 1; steps.push({ type: "equal", before: x, after: y }); }
  return steps.reverse();
}

/** The block wrapper a block's line authors summarize to (§5.3): all Jon's → user, none → ai, both → mixed. */
export function wrapperFor(lines) {
  const human = lines.filter((line) => PROTECTED_AUTHORS.has(line.author.type)).length;
  if (!lines.length || human === lines.length) return "user";
  return human ? "mixed" : "ai";
}

const actorOf = (author) => ({ type: author.type, id: author.id ?? null, label: author.label ?? null });

/**
 * A Markdown vault file read as the lines that authorship covers. A document's
 * blocks keep their own ids; a note or plain Markdown file is one block (its
 * body). Chat transcripts, margin comments and frontmatter are not covered.
 * Returns null for files that aren't documents or notes, or that don't parse.
 */
export function documentLines(path, source) {
  if (typeof source !== "string" || !/\.md$/iu.test(path)) return null;
  let state;
  let record;
  try {
    const { manifest, files } = discoverMarkdownWorkspace({ [path]: source });
    if (manifest.files.length !== 1 || manifest.files[0].type !== "conversation") return null;
    [record] = manifest.files;
    state = parseMarkdownWorkspace(manifest, files);
  } catch {
    return null;
  }
  const conversation = state?.conversations?.[record.id];
  if (!conversation) return null;
  const plain = readFrontmatterValue(source, "margin-chat") === undefined;
  const policy = readAgentEditPolicy(source);
  const base = { documentId: record.id, path, plain, agentEdit: policy };
  const document = conversation.document;
  if (document && Array.isArray(document.blocks)) {
    const generations = new Map((document.generations ?? []).map((generation) => [generation.id, generation]));
    return {
      ...base, kind: "document",
      blocks: document.blocks.map((block) => {
        const generation = block.generationId ? generations.get(block.generationId) : undefined;
        return {
          blockId: block.id,
          wrapper: getDocumentBlockAuthorship(block, conversation.messages ?? []),
          origin: block.origin ?? null,
          model: generation ? { id: `${generation.serviceId}:${generation.modelId}`, label: generation.modelId } : null,
          lines: splitLines(block.content),
        };
      }),
    };
  }
  const body = (conversation.notes ?? []).find((note) => note.kind === "standalone");
  if (conversation.kind === "note" && body) {
    return { ...base, kind: "note", blocks: [{ blockId: body.id, wrapper: "user", origin: null, model: null, lines: splitLines(body.content) }] };
  }
  return null;
}

const LEGACY_AI = { type: "ai", id: "ai:legacy", label: "AI" };
const UNKNOWN = { type: "unknown", id: null, label: "Unknown" };

/**
 * The author a line has when nothing better is known (§10): from the block
 * wrapper it sits in. Lines Jon may have touched are `unknown`, which the gate
 * protects exactly like his own.
 */
export function inferredAuthor(block, file, owner) {
  if (file.plain) return UNKNOWN;
  if (block.wrapper === "user") return owner;
  if (block.wrapper === "ai") return block.model ? { type: "ai", id: block.model.id, label: block.model.label } : LEGACY_AI;
  return UNKNOWN;
}

/** Sidecar blocks for a file inferred from its wrappers alone (the backfill, and any revision whose parent has no sidecar). */
export function inferBlocks(file, revisionKey, owner) {
  return file.blocks.map((block) => {
    const contexts = contextHashes(block.lines);
    const author = inferredAuthor(block, file, owner);
    return {
      blockId: block.blockId, kind: block.wrapper,
      lines: block.lines.map((line, index) => ({ i: index, sha256: sha256(line), ctx: contexts[index], author: actorOf(author), originRevisionId: revisionKey })),
    };
  });
}

/**
 * The commit-time ("forward") pass: lines unchanged from the parent keep their
 * author and origin; a line moved within the document keeps its own; every
 * other line is new in this revision and gets `authorFor(block)`.
 */
export function forwardBlocks({ parentBlocks, file, revisionKey, authorFor }) {
  const parentById = new Map((parentBlocks ?? []).map((block) => [block.blockId, block]));
  const pending = [];
  const consumed = new Set();
  const next = file.blocks.map((block) => {
    const contexts = contextHashes(block.lines);
    const hashes = block.lines.map(sha256);
    const parent = parentById.get(block.blockId);
    const lines = new Array(block.lines.length);
    if (parent) {
      for (const step of diffSequences(parent.lines.map((line) => line.sha256), hashes)) {
        if (step.type !== "equal") continue;
        const kept = parent.lines[step.before];
        consumed.add(kept);
        lines[step.after] = { i: step.after, sha256: hashes[step.after], ctx: contexts[step.after], author: kept.author, originRevisionId: kept.originRevisionId };
      }
    }
    hashes.forEach((hash, index) => { if (!lines[index]) pending.push({ block, lines, index, hash, ctx: contexts[index], isNewBlock: !parent }); });
    return { blockId: block.blockId, kind: block.wrapper, lines };
  });
  // A line that left one place and appeared in another, byte for byte, moved: it keeps its author.
  const moved = new Map();
  for (const block of parentBlocks ?? []) {
    for (const line of block.lines) {
      if (consumed.has(line)) continue;
      if (!moved.has(line.sha256)) moved.set(line.sha256, []);
      moved.get(line.sha256).push(line);
    }
  }
  for (const item of pending) {
    const candidates = moved.get(item.hash);
    let source = null;
    if (candidates?.length && item.hash !== sha256("")) {
      const sameContext = candidates.findIndex((line) => line.ctx === item.ctx);
      source = candidates.splice(sameContext >= 0 ? sameContext : 0, 1)[0];
    }
    const author = source ? source.author : actorOf(authorFor(item.block, { isNewBlock: item.isNewBlock }));
    item.lines[item.index] = { i: item.index, sha256: item.hash, ctx: item.ctx, author, originRevisionId: source ? source.originRevisionId : revisionKey };
  }
  return next;
}

/**
 * Who wrote a new line that arrived in an app commit (§5.2). The browser saves
 * the editor, Ask AI, Agent mode and imports together, so the block says who
 * wrote it: an unedited AI block is the model's, a newly imported block is the
 * importer's, and everything else Jon typed, pasted or synced from a folder he
 * owns. Edits arriving from Obsidian or a desktop folder look the same as the
 * editor's and are his too: only he writes there, and if that is ever wrong the
 * result is a line an agent can't change, never one it can.
 */
export function appAuthorFor(owner) {
  return (block, { isNewBlock }) => {
    if (block.wrapper === "ai") return block.model ? { type: "ai", id: block.model.id, label: block.model.label } : LEGACY_AI;
    if (block.origin && typeof block.origin === "object" && block.origin.type === "import" && isNewBlock) {
      return { type: "import", id: `import:${block.origin.source ?? "web"}`, label: block.origin.label ?? "Import" };
    }
    return owner;
  };
}

/** Totals for a document's current lines, as search results and the header show them. */
export function summarizeBlocks(blocks) {
  const summary = { humanLines: 0, aiLines: 0, agentLines: 0, importLines: 0, systemLines: 0, unknownLines: 0, totalLines: 0 };
  for (const block of blocks) {
    for (const line of block.lines) {
      summary.totalLines += 1;
      summary[`${line.author.type}Lines`] = (summary[`${line.author.type}Lines`] ?? 0) + 1;
    }
  }
  return summary;
}
