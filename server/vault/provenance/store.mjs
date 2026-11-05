import { createHash } from "node:crypto";
import {
  SIDECAR_SCHEMA,
  appAuthorFor,
  documentLines,
  forwardBlocks,
  inferBlocks,
  summarizeBlocks,
} from "./lines.mjs";

/**
 * Where line authorship lives: one sidecar per (document, revision) in cloud
 * storage beside the vault's history, never in the Markdown. A file's revision
 * id is a hash of its content, so the same text saved twice has the same id;
 * a sidecar is therefore named by the vault revision that saved it as well
 * (`<vault revision>-<file revision>`), and each document has a `head` naming
 * its newest sidecar. Keyed by document id, so renaming a file keeps its history.
 */

const SOURCES = new Set(["editor", "ask-ai", "agent-mode", "mcp", "import", "capture", "external-sync", "system", "backfill"]);
const digest = (value) => createHash("sha256").update(value).digest("hex");

export const ownerActor = (userId) => ({ type: "human", id: String(userId), label: "You" });

export function createProvenanceStore({ storage, prefix, database, readFile }) {
  const base = (userId, documentId) => `${prefix(userId)}/provenance/${digest(String(documentId))}`;
  const headKey = (userId, documentId) => `${base(userId, documentId)}/head.json`;
  const sidecarKey = (userId, documentId, revisionKey) => `${base(userId, documentId)}/revisions/${revisionKey}.json`;
  // One chain per account in this process, so a document's head moves in commit order.
  const chains = new Map();

  async function readJson(key) {
    const record = await storage.read(key);
    if (!record) return { value: null, etag: null };
    try { return { value: JSON.parse(record.bytes.toString("utf8")), etag: record.etag }; } catch { return { value: null, etag: record.etag }; }
  }

  async function readHead(userId, documentId) {
    const { value, etag } = await readJson(headKey(userId, documentId));
    return { head: value?.schema === SIDECAR_SCHEMA && typeof value.revisionKey === "string" ? value : null, etag };
  }

  async function readSidecar(userId, documentId, revisionKey) {
    const { value } = await readJson(sidecarKey(userId, documentId, revisionKey));
    return value?.schema === SIDECAR_SCHEMA && value.documentId === documentId && Array.isArray(value.blocks) ? value : null;
  }

  /** The sidecar for a document's current revision, or null when none was recorded for exactly it. */
  async function current(userId, documentId, revisionId) {
    const { head } = await readHead(userId, documentId);
    if (!head || (revisionId && head.revisionId !== revisionId)) return null;
    return readSidecar(userId, documentId, head.revisionKey);
  }

  async function project(userId, sidecar, isCurrent = true) {
    if (!database?.recordDocumentProvenance) return;
    const lines = sidecar.blocks.flatMap((block) => block.lines.map((line) => ({ ...line, blockId: block.blockId })));
    await database.recordDocumentProvenance({ userId, documentId: sidecar.documentId, revision: sidecar, lines,
      summary: summarizeBlocks(sidecar.blocks), current: isCurrent });
  }

  /** Writes a sidecar and moves the document's head to it unless a newer revision is already there. */
  async function publish(userId, sidecar) {
    await storage.putImmutable(sidecarKey(userId, sidecar.documentId, sidecar.revisionKey), Buffer.from(JSON.stringify(sidecar)), "application/json");
    const pointer = Buffer.from(JSON.stringify({ schema: SIDECAR_SCHEMA, documentId: sidecar.documentId, revisionKey: sidecar.revisionKey,
      revisionId: sidecar.revisionId, vaultRevision: sidecar.vaultRevision, path: sidecar.path }));
    let moved = false;
    for (let attempt = 0; attempt < 4 && !moved; attempt += 1) {
      const { head, etag } = await readHead(userId, sidecar.documentId);
      if (head && head.vaultRevision > sidecar.vaultRevision) break;
      moved = await storage.compareAndSwap(headKey(userId, sidecar.documentId), pointer, etag);
    }
    await project(userId, sidecar, moved);
    return moved;
  }

  /**
   * Records who wrote each line of one saved Markdown file. `context.actor` made
   * the revision; `context.authorFor` decides who wrote its new lines (by
   * default the app's rule: AI blocks are the model's, the rest are Jon's).
   */
  async function recordFile(userId, { path, content, baseRevision, revision, vaultRevision }, context) {
    const file = documentLines(path, content);
    if (!file) return null;
    const owner = ownerActor(userId);
    const revisionKey = `${vaultRevision}-${revision}`;
    const { head } = await readHead(userId, file.documentId);
    if (head?.revisionKey === revisionKey) return readSidecar(userId, file.documentId, revisionKey);
    let parent = null;
    let parentRevisionId = baseRevision ?? null;
    let parentRevisionKey = null;
    // A new path for a known document id is a rename or a re-created file: it continues that document.
    if (head && (head.revisionId === baseRevision || baseRevision === null)) {
      const sidecar = await readSidecar(userId, file.documentId, head.revisionKey);
      if (sidecar) {
        parent = sidecar.blocks;
        parentRevisionId = sidecar.revisionId;
        parentRevisionKey = sidecar.revisionKey;
      }
    }
    if (!parent && baseRevision && readFile) {
      // The parent was saved without a sidecar (before this existed, or a save
      // raced this one): read who wrote it from its wrappers, as the backfill does.
      const previous = await readFile({ userId, path, revision: baseRevision }).catch(() => null);
      const parsed = previous ? documentLines(path, previous.bytes.toString("utf8")) : null;
      if (parsed?.documentId === file.documentId) parent = inferBlocks(parsed, `inferred:${baseRevision}`, owner);
    }
    const blocks = forwardBlocks({ parentBlocks: parent, file, revisionKey, authorFor: context.authorFor ?? appAuthorFor(owner) });
    const sidecar = {
      schema: SIDECAR_SCHEMA, documentId: file.documentId, path, revisionId: revision, revisionKey,
      parentRevisionId, parentRevisionKey, vaultRevision,
      actor: context.actor ?? owner, source: SOURCES.has(context.source) ? context.source : "editor",
      ...(context.reason ? { reason: String(context.reason).slice(0, 280) } : {}),
      createdAt: new Date().toISOString(),
      // The file revision is already a SHA-256 of the saved bytes (with their encoding and type).
      contentHash: `sha256:${revision}`,
      blocks,
    };
    await publish(userId, sidecar);
    return sidecar;
  }

  /** Records every saved Markdown file of one commit. Failures are logged and leave the file's lines protected. */
  function recordCommit(userId, files, context = {}) {
    const previous = chains.get(userId) ?? Promise.resolve();
    const work = previous.then(async () => {
      const results = {};
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
        while (index < files.length) {
          const file = files[index++];
          try {
            const sidecar = await recordFile(userId, file, context);
            if (sidecar) results[file.path] = sidecar;
          } catch (error) {
            console.error("Line authorship not recorded", file.path, error);
          }
        }
      }));
      return results;
    });
    chains.set(userId, work);
    void work.finally(() => { if (chains.get(userId) === work) chains.delete(userId); });
    return work;
  }

  /**
   * The one-time backfill (§10) for one file: a genesis sidecar inferred from
   * its wrappers, only when the document has none. Writes no content revision.
   */
  async function backfillFile(userId, { path, content, revision, vaultRevision }) {
    const file = documentLines(path, content);
    if (!file) return { status: "skipped" };
    const { head } = await readHead(userId, file.documentId);
    if (head) return { status: "exists", documentId: file.documentId };
    const revisionKey = `${vaultRevision}-${revision}`;
    const sidecar = {
      schema: SIDECAR_SCHEMA, documentId: file.documentId, path, revisionId: revision, revisionKey,
      parentRevisionId: null, parentRevisionKey: null, vaultRevision,
      actor: { type: "system", id: "system:backfill", label: "Backfill" }, source: "backfill",
      createdAt: new Date().toISOString(), contentHash: `sha256:${revision}`,
      blocks: inferBlocks(file, revisionKey, ownerActor(userId)),
    };
    await publish(userId, sidecar);
    return { status: "created", documentId: file.documentId, summary: summarizeBlocks(sidecar.blocks) };
  }

  /** Walks a document's sidecars from newest to oldest (for history views and repair). */
  async function chain(userId, documentId, { limit = 200 } = {}) {
    const { head } = await readHead(userId, documentId);
    const revisions = [];
    let key = head?.revisionKey ?? null;
    const seen = new Set();
    while (key && !seen.has(key) && revisions.length < limit) {
      seen.add(key);
      const sidecar = await readSidecar(userId, documentId, key);
      if (!sidecar) break;
      revisions.push(sidecar);
      key = sidecar.parentRevisionKey;
    }
    return revisions;
  }

  return { readHead, readSidecar, current, recordFile, recordCommit, backfillFile, chain, project };
}
