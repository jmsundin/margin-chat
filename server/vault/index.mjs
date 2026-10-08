import { HttpError } from "../lib/errors.mjs";
import { createVaultStorage, digest } from "./storage.mjs";

const MAX_FILES = 5_000_000;
const MAX_COMMIT_BYTES = 3 * 1024 * 1024;
// The file list is split into 256 shards by path hash. A save rewrites the
// shards it touches plus a small root, never the whole list.
const MAX_SHARD_BYTES = 16 * 1024 * 1024;
const SHARD_CACHE_BYTES = 128 * 1024 * 1024;
const REVISION = /^[a-f0-9]{64}$/u;
const SHARD = /^[a-f0-9]{2}$/u;
const INDEX_SCHEMA = 1;
const emptyManifest = () => ({ schemaVersion: 1, revision: 0, files: {} });
const emptyRoot = () => ({ schemaVersion: 2, revision: 0, count: 0, shards: {} });
const shardOf = (path) => digest(path).slice(0, 2);
const missingConfiguration = () => new HttpError(503, "Cloud Markdown storage is not configured. Connect a private Vercel Blob store, or set VAULT_STORAGE_DIR for local development. Your local files remain saved.");

export function validateVaultPath(path) {
  if (typeof path !== "string" || !path || path.length > 512 ||
      /[\\\u0000-\u001f\u007f\ud800-\udfff]/u.test(path) ||
      path.split("/").some((part) => !part || [".", "..", "__proto__", "constructor", "prototype"].includes(part))) {
    throw new HttpError(400, "Vault paths must be safe relative file paths.");
  }
  return path;
}

export class VaultConflictError extends HttpError {
  constructor(conflicts, manifest) {
    super(409, "These files changed on another device. Download their revisions before resolving the conflict.");
    this.conflicts = conflicts;
    this.manifest = manifest;
  }
}

async function mapConcurrent(items, operation, width = 12) {
  let index = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await operation(items[current], current);
    }
  }));
  return results;
}

function validateEntries(files, shard) {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("Invalid stored vault manifest.");
  for (const [path, entry] of Object.entries(files)) {
    validateVaultPath(path);
    if (!entry || !REVISION.test(entry.revision) || typeof entry.deleted !== "boolean") throw new Error("Invalid stored vault file revision.");
    if (shard !== undefined && shardOf(path) !== shard) throw new Error("Invalid stored vault file list shard.");
  }
  return files;
}

/** The stored root: a complete schema 1 file list written before sharding, or a
 * schema 2 root naming each shard's content digest. */
function validateRoot(value) {
  if (value?.schemaVersion === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0) {
    validateEntries(value.files);
    return value;
  }
  if (!value || value.schemaVersion !== 2 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !Number.isSafeInteger(value.count) || !value.shards || typeof value.shards !== "object" || Array.isArray(value.shards)) {
    throw new Error("Invalid stored vault manifest.");
  }
  for (const [id, shard] of Object.entries(value.shards)) {
    if (!SHARD.test(id) || !shard || !REVISION.test(shard.digest) || !Number.isSafeInteger(shard.count) || shard.count < 1 ||
        !Number.isSafeInteger(shard.changedAt) || shard.changedAt < 0 || shard.changedAt > value.revision) throw new Error("Invalid stored vault manifest.");
  }
  return value;
}

const pick = (files, paths) => Object.fromEntries(paths.filter((path) => Object.hasOwn(files, path)).map((path) => [path, files[path]]));

function prepareChanges(changes, trusted = false) {
  if (!Array.isArray(changes) || (!trusted && changes.length > 1000)) throw new HttpError(400, "A commit requires at most 1,000 file changes.");
  const paths = new Set();
  let size = 0;
  return changes.map((change) => {
    const path = validateVaultPath(change?.path);
    if (paths.has(path)) throw new HttpError(400, "A commit cannot change a file twice.");
    paths.add(path);
    if (change.baseRevision !== null && !REVISION.test(change.baseRevision ?? "")) throw new HttpError(400, "Each change needs its actual base revision or null for a new file.");
    if (change.content !== null && typeof change.content !== "string") throw new HttpError(400, "A file needs text content, or null to delete it.");
    if (change.encoding !== undefined && change.encoding !== "base64" && change.encoding !== "utf8") throw new HttpError(400, "Unsupported file encoding.");
    const deleted = change.content === null;
    const encoding = change.encoding === "base64" ? "base64" : "utf8";
    // A repeated four-character capture exhausts the JS regex stack on valid
    // 4 MiB uploads. Check length and a simple alphabet/padding scan instead.
    if (!deleted && encoding === "base64" && (change.content.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(change.content))) throw new HttpError(400, "Invalid base64 attachment.");
    const contentType = change.contentType ?? (/\.md$/iu.test(path) ? "text/markdown; charset=utf-8" : path.endsWith(".json") ? "application/json" : "application/octet-stream");
    if (typeof contentType !== "string" || contentType.length > 160 || !/^[\w.+-]+\/[\w.+-]+(?:; ?charset=[\w-]+)?$/iu.test(contentType)) throw new HttpError(400, "Invalid file content type.");
    const bytes = deleted ? null : Buffer.from(change.content, encoding);
    size += bytes?.length ?? 0;
    if (!trusted && size > MAX_COMMIT_BYTES) throw new HttpError(413, "Sync smaller batches of files (at most 3 MiB per commit).");
    const revision = deleted
      ? digest(`deleted:${path}:${change.baseRevision ?? "new"}`)
      : digest(Buffer.concat([Buffer.from(`${encoding}\n${contentType}\n`), bytes]));
    return { path, baseRevision: change.baseRevision, bytes, entry: { revision, deleted, encoding, contentType, size: bytes?.length ?? 0 } };
  });
}

/** Keep work running after the response where the platform allows it. */
function continueAfterResponse(work, env) {
  const context = globalThis[Symbol.for("@vercel/request-context")]?.get?.();
  if (typeof context?.waitUntil === "function") {
    context.waitUntil(work);
    return true;
  }
  // A long-running server keeps working after it responds; a function without
  // waitUntil may be frozen, so it finishes the work first.
  return !env.VERCEL;
}

export function createVaultService({ database, env = process.env, storage = createVaultStorage(env), codec: codecOverride, backgroundProjection = false } = {}) {
  const configured = Boolean(storage);
  // File bodies are immutable per revision, so a warm server reuses what it
  // already read instead of downloading every file again for each projection.
  const bodies = new Map();
  let bodyBytes = 0;
  const BODY_CACHE_BYTES = 64 * 1024 * 1024;
  async function readBody(key) {
    const hit = bodies.get(key);
    if (hit) {
      bodies.delete(key);
      bodies.set(key, hit);
      return hit;
    }
    const record = await storage.read(key);
    if (record && record.bytes.length <= 1024 * 1024) {
      bodies.set(key, record);
      bodyBytes += record.bytes.length;
      for (const [oldest, cached] of bodies) {
        if (bodyBytes <= BODY_CACHE_BYTES) break;
        bodies.delete(oldest);
        bodyBytes -= cached.bytes.length;
      }
    }
    return record;
  }
  // One projection per account at a time in this process; later requests wait
  // for it and then find the checkpoint current.
  const projections = new Map();
  let codecPromise;
  const codec = () => codecOverride ?? (codecPromise ??= import("@margin-chat/workspace-contracts/markdown"));
  const prefix = (userId) => `vaults/v1/${digest(String(userId))}`;
  const manifestKey = (userId) => `${prefix(userId)}/manifest.json`;
  const shardKey = (userId, hash) => `${prefix(userId)}/shards/${hash}.json`;
  const bodyKey = (userId, path, revision) => `${prefix(userId)}/files/${digest(path)}/${revision}`;

  // Shards are immutable and addressed by content, so a parsed shard stays valid
  // for as long as this process keeps it. Frozen so no caller can alter it.
  const shards = new Map();
  let shardBytes = 0;
  function rememberShard(key, files, size) {
    for (const entry of Object.values(files)) Object.freeze(entry);
    Object.freeze(files);
    if (size > SHARD_CACHE_BYTES / 4) return;
    shards.set(key, { files, size });
    shardBytes += size;
    for (const [oldest, cached] of shards) {
      if (shardBytes <= SHARD_CACHE_BYTES) break;
      shards.delete(oldest);
      shardBytes -= cached.size;
    }
  }
  async function loadShard(userId, id, reference) {
    const key = shardKey(userId, reference.digest);
    const hit = shards.get(key);
    if (hit) {
      shards.delete(key);
      shards.set(key, hit);
      return hit.files;
    }
    const record = await storage.read(key);
    if (!record) throw new Error("A shard of the vault's file list is missing.");
    if (digest(record.bytes) !== reference.digest) throw new Error("A shard of the vault's file list does not match its digest.");
    const value = JSON.parse(record.bytes.toString("utf8"));
    if (value?.schemaVersion !== 1 || value.shard !== id) throw new Error("Invalid stored vault file list shard.");
    rememberShard(key, validateEntries(value.files, id), record.bytes.length);
    return value.files;
  }

  async function readRoot(userId) {
    if (!storage) throw missingConfiguration();
    const record = await storage.read(manifestKey(userId));
    return { root: record ? validateRoot(JSON.parse(record.bytes.toString("utf8"))) : emptyRoot(), etag: record?.etag ?? null };
  }

  /** The current entries for these paths, reading only the shards they live in. */
  async function entriesFor(userId, root, paths) {
    if (root.schemaVersion === 1) return pick(root.files, paths);
    const byShard = new Map();
    for (const path of paths) {
      const id = shardOf(path);
      if (!root.shards[id]) continue;
      if (!byShard.has(id)) byShard.set(id, []);
      byShard.get(id).push(path);
    }
    const entries = {};
    await mapConcurrent([...byShard], async ([id, list]) => Object.assign(entries, pick(await loadShard(userId, id, root.shards[id]), list)));
    return entries;
  }

  /** The complete file list. Only whole-vault work (indexing, a full download) needs it. */
  async function assemble(userId, root) {
    if (root.schemaVersion === 1) return root;
    const ids = Object.keys(root.shards).sort();
    const files = {};
    for (const shard of await mapConcurrent(ids, (id) => loadShard(userId, id, root.shards[id]))) Object.assign(files, shard);
    return { schemaVersion: 1, revision: root.revision, files };
  }

  async function snapshot(userId) {
    const { root, etag } = await readRoot(userId);
    return { manifest: await assemble(userId, root), etag };
  }

  async function readFile({ userId, path, revision }) {
    if (!storage) throw missingConfiguration();
    validateVaultPath(path);
    let entry;
    if (revision !== undefined && revision !== null && !REVISION.test(revision)) throw new HttpError(400, "Invalid file revision.");
    if (!revision) {
      entry = (await entriesFor(userId, (await readRoot(userId)).root, [path]))[path];
      if (!entry || entry.deleted) throw new HttpError(404, "Vault file not found.");
      revision = entry.revision;
    }
    const record = await readBody(bodyKey(userId, path, revision));
    if (!record) throw new HttpError(404, "Vault file revision not found.");
    return { bytes: record.bytes, revision, contentType: entry?.contentType ?? (path.endsWith(".md") ? "text/markdown; charset=utf-8" : path.endsWith(".json") ? "application/json" : "application/octet-stream") };
  }

  /** Publishes a revision. Returns its root, the revision it was built on (equal
   * to the root's when every change was already in the cloud) and the resulting
   * entries for the changed paths. */
  async function applyCommit(userId, changes, { trusted = false, onlyInitialize = false } = {}) {
    if (!storage) throw missingConfiguration();
    const prepared = prepareChanges(changes, trusted);
    const paths = prepared.map((change) => change.path);
    let uploaded = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { root: current, etag } = await readRoot(userId);
      const existing = await entriesFor(userId, current, paths);
      const unchanged = { root: current, previousRevision: current.revision, entries: existing };
      if (onlyInitialize && current.revision !== 0) return unchanged;
      const conflicts = [];
      const effective = [];
      for (const change of prepared) {
        const entry = existing[change.path];
        if ((entry?.revision === change.entry.revision) || (entry?.deleted && change.entry.deleted)) continue;
        if ((entry?.revision ?? null) !== change.baseRevision) conflicts.push(change.path);
        else if (!entry && change.entry.deleted) continue;
        else effective.push(change);
      }
      if (conflicts.length) throw new VaultConflictError(conflicts, { schemaVersion: 1, revision: current.revision, files: pick(existing, conflicts) });
      if (!effective.length) return unchanged;
      const revision = current.revision + 1;
      // Each entry records the revision that last changed it, so a device can ask
      // for only what changed since its last sync. Entries saved before this was
      // recorded changed at or before the current revision.
      const touched = new Map();
      if (current.schemaVersion === 1) {
        // The first save after sharding splits the old single file list.
        for (const [path, entry] of Object.entries(current.files)) {
          const id = shardOf(path);
          if (!touched.has(id)) touched.set(id, {});
          touched.get(id)[path] = entry.changedAt === undefined ? { ...entry, changedAt: current.revision } : entry;
        }
      }
      for (const change of effective) {
        const id = shardOf(change.path);
        if (!touched.has(id)) touched.set(id, { ...(current.shards?.[id] ? await loadShard(userId, id, current.shards[id]) : {}) });
        touched.get(id)[change.path] = { ...change.entry, changedAt: revision };
      }
      const shards = { ...(current.shards ?? {}) };
      const writes = [];
      for (const [id, files] of touched) {
        const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, shard: id, files }));
        if (bytes.length > MAX_SHARD_BYTES) throw new HttpError(413, "This vault's file list has reached the cloud sync size limit. Your local files remain saved and available to export.");
        let changedAt = 0;
        let count = 0;
        for (const entry of Object.values(files)) {
          count += 1;
          changedAt = Math.max(changedAt, entry.changedAt);
        }
        shards[id] = { digest: digest(bytes), changedAt, count };
        writes.push({ key: shardKey(userId, shards[id].digest), bytes, files });
      }
      const next = { schemaVersion: 2, revision, count: 0, shards: Object.fromEntries(Object.keys(shards).sort().map((id) => [id, shards[id]])) };
      for (const shard of Object.values(next.shards)) next.count += shard.count;
      if (next.count > MAX_FILES) throw new HttpError(413, "This vault has reached the cloud sync limit of 5,000,000 files.");
      if (!uploaded) {
        await mapConcurrent(prepared.filter((change) => change.bytes), (change) =>
          storage.putImmutable(bodyKey(userId, change.path, change.entry.revision), change.bytes, change.entry.contentType));
        uploaded = true;
      }
      // Shards and history are written before publishing. Losing a CAS may leave
      // orphans, but no root can ever reference an incomplete upload.
      await mapConcurrent(writes, ({ key, bytes }) => storage.putImmutable(key, bytes, "application/json"));
      const bytes = Buffer.from(JSON.stringify(next));
      await storage.putImmutable(`${prefix(userId)}/history/${digest(bytes)}.json`, bytes, "application/json");
      if (await storage.compareAndSwap(manifestKey(userId), bytes, etag)) {
        for (const { key, bytes: shardBytes, files } of writes) rememberShard(key, files, shardBytes.length);
        const entries = {};
        for (const path of paths) {
          const files = touched.get(shardOf(path));
          const entry = files && Object.hasOwn(files, path) ? files[path] : existing[path];
          if (entry) entries[path] = entry;
        }
        return { root: next, previousRevision: current.revision, entries };
      }
      // Re-read and compare with ORIGINAL per-file bases. Never retag stale edits.
    }
    throw new HttpError(503, "Other devices are updating the vault. Retry this same change shortly.");
  }

  /** Every entry changed after `since`, reading only the shards that changed.
   * A device that has synchronized through `since` reconstructs the full file
   * list from what it already holds. */
  async function changesSince(userId, root, since) {
    const files = {};
    if (since >= root.revision) return files;
    const sources = root.schemaVersion === 1 ? [root.files]
      : await mapConcurrent(Object.keys(root.shards).filter((id) => root.shards[id].changedAt > since), (id) => loadShard(userId, id, root.shards[id]));
    for (const shard of sources) {
      for (const [path, entry] of Object.entries(shard)) if ((entry.changedAt ?? root.revision) > since) files[path] = entry;
    }
    return files;
  }

  function attachmentPaths(attachment) {
    const filename = String(attachment.filename ?? "attachment").replace(/[\\/\u0000-\u001f%:#?]/gu, "_").replace(/^\.+$/u, "attachment").slice(0, 180) || "attachment";
    const id = String(attachment.id);
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) throw new HttpError(400, "Invalid attachment identity.");
    return { path: `Attachments/${id}/${filename === "metadata.json" ? "original-metadata.json" : filename}`, metadataPath: `Attachments/${id}/metadata.json` };
  }

  function attachmentChanges(attachment, bytes, current = {}) {
    const { path, metadataPath } = attachmentPaths(attachment);
    const descriptor = { ...attachment, bytes: undefined, path, sizeBytes: bytes.length };
    return [
      { path, content: bytes.toString("base64"), encoding: "base64", contentType: attachment.mimeType || "application/octet-stream", baseRevision: current[path]?.revision ?? null },
      { path: metadataPath, content: JSON.stringify(descriptor, null, 2), baseRevision: current[metadataPath]?.revision ?? null },
    ];
  }

  /** The current root, after copying a pre-vault workspace into a new vault. */
  async function migrateLegacy(userId) {
    const { root } = await readRoot(userId);
    if (root.revision !== 0) return root;
    const legacy = await database?.loadWorkspace?.(userId);
    const conversations = Object.values(legacy?.state?.conversations ?? {});
    // Authored document content is independent of messages and notes. An explicit
    // document (including its edit history) must survive first-vault migration.
    const onlyDraft = conversations.length === 1 && conversations[0].kind !== "note" &&
      conversations[0].title === "New chat" && !conversations[0].messages?.length &&
      !conversations[0].document &&
      !conversations[0].notes?.length && !conversations[0].documents?.length &&
      !Object.keys(legacy.state.groups ?? {}).length && !legacy.state.pinnedThreadIds?.length;
    const changes = [];
    if (conversations.length && !onlyDraft) {
      const { createMarkdownWorkspace } = await codec();
      const workspace = createMarkdownWorkspace(legacy.state);
      const metadata = { ...workspace.manifest, files: [], workspace: { ...workspace.manifest.workspace, view: { ...workspace.manifest.workspace.view, activeItemId: "", activeRootId: "", railOpen: false } } };
      changes.push(...Object.entries({ ...workspace.files, "workspace.json": JSON.stringify(metadata, null, 2) })
        .map(([path, content]) => ({ path, content, baseRevision: null })));
    }
    // Originals can belong to a workspace retained only on a device. Preserve
    // them even when there is no meaningful server-side conversation to copy.
    const attachments = await database?.listVaultAttachments?.(userId) ?? [];
    for (const attachment of attachments) changes.push(...attachmentChanges(attachment, attachment.bytes));
    return (await applyCommit(userId, changes, { trusted: true, onlyInitialize: true })).root;
  }

  async function readWorkspace(userId, manifest) {
    manifest ??= (await snapshot(userId)).manifest;
    const records = Object.entries(manifest.files).filter(([path, entry]) => !entry.deleted && !/^(?:_conflicts|attachments|\.margin-chat)\//iu.test(path)
      && ((/\.md$/iu.test(path) && entry.encoding !== "base64") || path === "workspace.json"));
    if (!records.length) return null;
    const files = Object.fromEntries(await mapConcurrent(records, async ([path, entry]) => [path, (await readFile({ userId, path, revision: entry.revision })).bytes.toString("utf8")]));
    const metadata = files["workspace.json"] ? JSON.parse(files["workspace.json"]) : undefined;
    delete files["workspace.json"];
    const { discoverMarkdownWorkspace, parseMarkdownWorkspace } = await codec();
    const workspace = discoverMarkdownWorkspace(files, metadata);
    const state = parseMarkdownWorkspace(workspace.manifest, workspace.files);
    if (!state) throw new Error("The saved Markdown could not be indexed. The original files are retained.");
    if (!Object.keys(state.conversations).length) return null;
    const roots = Object.values(state.conversations).filter((conversation) => conversation.parentId === null);
    if (!roots.length) throw new Error("The Markdown relationships contain no root document.");
    // Navigation belongs to this client. Portable sidecars deliberately leave it
    // blank; the database's compatibility projection still needs a valid root.
    state.rootId = roots[0].id;
    state.activeConversationId = roots[0].id;
    state.railOpen = false;
    const rootIds = new Set(roots.map(({ id }) => id));
    state.pinnedThreadIds = (state.pinnedThreadIds ?? []).filter((id) => rootIds.has(id));
    state.groups = Object.fromEntries(Object.entries(state.groups ?? {}).map(([id, group]) => [id, {
      ...group, conversationIds: group.conversationIds.filter((conversationId) => state.conversations[conversationId]),
    }]));
    return state;
  }

  /** Titles, dates and relationships of every Markdown file, so a new device can
   * open recent documents first and fetch the rest only when asked. Summaries are
   * cached per file revision; an unchanged file is never read twice. */
  async function index(userId) {
    const manifest = await assemble(userId, await migrateLegacy(userId));
    const key = `${prefix(userId)}/index.json`;
    const record = await storage.read(key);
    let cached = null;
    try { cached = record ? JSON.parse(record.bytes.toString("utf8")) : null; } catch { cached = null; }
    const previous = cached?.schemaVersion === INDEX_SCHEMA && cached.files && typeof cached.files === "object" ? cached.files : {};
    const markdown = Object.entries(manifest.files).filter(([path, entry]) => !entry.deleted && entry.encoding !== "base64"
      && /\.md$/iu.test(path) && !/^(?:_conflicts|attachments|\.margin-chat)\//iu.test(path));
    const { summarizeMarkdownVaultFile, buildMarkdownVaultIndex } = await codec();
    const files = {};
    let changed = cached?.revision !== manifest.revision || Object.keys(previous).length !== markdown.length;
    await mapConcurrent(markdown, async ([path, entry]) => {
      const known = previous[path];
      if (known?.revision === entry.revision && known.summary) { files[path] = known; return; }
      changed = true;
      const source = (await readFile({ userId, path, revision: entry.revision })).bytes.toString("utf8");
      const summary = summarizeMarkdownVaultFile(path, source);
      if (summary) files[path] = { revision: entry.revision, summary };
    });
    if (changed) {
      // The cache only saves work. Losing a race with another request is harmless.
      await storage.compareAndSwap(key, Buffer.from(JSON.stringify({ schemaVersion: INDEX_SCHEMA, revision: manifest.revision, files })), record?.etag ?? null)
        .catch(() => false);
    }
    const summaries = Object.keys(files).sort().map((path) => files[path].summary);
    return { revision: manifest.revision, entries: buildMarkdownVaultIndex(summaries)
      .map((entry) => ({ ...entry, revision: files[entry.path].revision })) };
  }

  /** Projects `revision` once earlier projections finish. The file list is
   * loaded only when the projection is actually behind. */
  function projectLatest(userId, revision, load, options) {
    const previous = projections.get(userId) ?? Promise.resolve();
    const work = previous.then(() => projectRevision(userId, revision, load, options));
    projections.set(userId, work);
    void work.finally(() => { if (projections.get(userId) === work) projections.delete(userId); });
    return work;
  }

  /** After a save, index in the background where possible so saving never waits on search. */
  async function projectAfterSave(userId, revision, load) {
    const work = projectLatest(userId, revision, load);
    if (backgroundProjection && continueAfterResponse(work, env)) return { status: "queued", revision };
    return work;
  }

  const lazyManifest = (userId, root) => {
    let manifest;
    return () => (manifest ??= assemble(userId, root));
  };

  async function readProjectionFingerprints(userId) {
    const record = await storage.read(`${prefix(userId)}/projection.json`).catch(() => null);
    try {
      const value = record ? JSON.parse(record.bytes.toString("utf8")) : null;
      return { etag: record?.etag ?? null, value: value?.schemaVersion === 1 && Number.isSafeInteger(value.revision) && value.conversations ? value : null };
    } catch { return { etag: record?.etag ?? null, value: null }; }
  }

  async function projectRevision(userId, revision, load, { force = false } = {}) {
    if (!database?.projectVaultState || !revision) return { status: "ready", revision };
    try {
      const checkpoint = database.getVaultProjectionCheckpoint
        ? await database.getVaultProjectionCheckpoint(userId)
        : { revision: await database.getVaultProjectionRevision?.(userId), attachments: {} };
      if (!force && (checkpoint?.revision ?? -1) >= revision) return { status: "ready", revision };
      const manifest = await load();
      const state = await readWorkspace(userId, manifest);
      const attachments = Object.entries(manifest.files).filter(([path, entry]) => !entry.deleted && /^Attachments\/[^/]+\/metadata\.json$/u.test(path));
      const attachmentRevisions = {};
      const originals = (await mapConcurrent(attachments, async ([path, entry]) => {
          const previous = checkpoint?.attachments?.[path];
          if (!force && previous?.metadataRevision === entry.revision &&
              !manifest.files[previous.bodyPath]?.deleted &&
              manifest.files[previous.bodyPath]?.revision === previous.bodyRevision) {
            attachmentRevisions[path] = previous;
            return null;
          }
          const attachment = JSON.parse((await readFile({ userId, path, revision: entry.revision })).bytes.toString("utf8"));
          const bodyEntry = manifest.files[attachment.path];
          if (!bodyEntry || bodyEntry.deleted) throw new Error("An attachment original is missing from the vault.");
          const bytes = (await readFile({ userId, path: attachment.path, revision: bodyEntry.revision })).bytes;
          attachmentRevisions[path] = { metadataRevision: entry.revision, bodyPath: attachment.path, bodyRevision: bodyEntry.revision };
          return { attachment, bytes };
        })).filter(Boolean);
      const deletedAttachmentIds = Object.entries(manifest.files)
        .filter(([path, entry]) => entry.deleted && /^Attachments\/[^/]+\/metadata\.json$/u.test(path))
        .map(([path]) => path.split("/")[1]);
      // Deleting an original is authoritative even while another device's
      // Markdown still references it. Such stale links must not roll back the
      // deletion or keep the entire feature projection pending.
      const deletedIds = new Set(deletedAttachmentIds);
      for (const conversation of Object.values(state?.conversations ?? {})) {
        conversation.documents = (conversation.documents ?? []).filter((document) => !deletedIds.has(document.id));
      }
      // Rewrite only the documents whose content changed since the projected
      // revision. Fingerprints are trusted only for exactly that revision.
      const fingerprints = Object.fromEntries(Object.values(state?.conversations ?? {})
        .map((conversation) => [conversation.id, digest(JSON.stringify(conversation))]));
      const stored = database.getVaultProjectionCheckpoint ? await readProjectionFingerprints(userId) : { etag: null, value: null };
      let unchangedConversationIds;
      if (!force && state && stored.value && stored.value.revision === checkpoint?.revision) {
        const touched = new Set([...originals.map(({ attachment }) => attachment.id), ...deletedIds]);
        unchangedConversationIds = Object.keys(fingerprints).filter((id) => stored.value.conversations[id] === fingerprints[id]
          && !(state.conversations[id].documents ?? []).some((document) => touched.has(document.id)));
      }
      const result = await database.projectVaultState(userId, state, manifest.revision, {
        force, attachments: originals, deletedAttachmentIds, attachmentRevisions,
        ...(database.getVaultProjectionCheckpoint ? { expectedProjectionRevision: checkpoint?.revision ?? -1 } : {}),
        ...(unchangedConversationIds ? { unchangedConversationIds } : {}),
      });
      if (result?.projected === true && database.getVaultProjectionCheckpoint) {
        // Only saves work: a lost race leaves an older revision, which is ignored.
        await storage.compareAndSwap(`${prefix(userId)}/projection.json`,
          Buffer.from(JSON.stringify({ schemaVersion: 1, revision: manifest.revision, conversations: fingerprints })), stored.etag)
          .catch(() => false);
      }
      return { status: "ready", revision };
    } catch (error) {
      console.error("Vault projection pending", error);
      return { status: "pending", revision, error: "Your Markdown is saved. Feature indexes will retry when you next sync." };
    }
  }

  async function saved(userId, { root, previousRevision, entries }, acknowledge) {
    const load = lazyManifest(userId, root);
    const manifest = acknowledge ? { schemaVersion: 1, revision: root.revision, files: entries } : await load();
    return { manifest, previousRevision, projection: await projectAfterSave(userId, root.revision, load) };
  }

  return {
    configured,
    storageKind: storage?.kind ?? null,
    readFile,
    readWorkspace,
    snapshot,
    async index(userId) {
      if (!configured) return { configured: false, revision: 0, entries: [] };
      return { configured: true, ...(await index(userId)) };
    },
    async status(userId) {
      if (!configured) return { configured: false, manifest: emptyManifest() };
      const manifest = await assemble(userId, await migrateLegacy(userId));
      return { configured: true, manifest, projection: await projectLatest(userId, manifest.revision, async () => manifest) };
    },
    /** What changed since a revision this device already synchronized. */
    async changes(userId, since) {
      if (!configured) return { configured: false, revision: 0, files: {} };
      if (!Number.isSafeInteger(since) || since < 0) throw new HttpError(400, "Ask for changes since a saved vault revision.");
      const root = await migrateLegacy(userId);
      return { configured: true, revision: root.revision, files: await changesSince(userId, root, since), projection: await projectLatest(userId, root.revision, lazyManifest(userId, root)) };
    },
    /** With `acknowledge`, the receipt lists only the changed paths instead of the whole vault. */
    async commit(userId, changes, { acknowledge = false } = {}) {
      // Preserve the server's legacy copy before considering a device's first edit.
      await migrateLegacy(userId);
      return saved(userId, await applyCommit(userId, changes), acknowledge);
    },
    async commitBinary(userId, { path, baseRevision, bytes, contentType }, { acknowledge = false } = {}) {
      if (bytes.length > 4 * 1024 * 1024) throw new HttpError(413, "An attachment must be at most 4 MiB.");
      await migrateLegacy(userId);
      return saved(userId, await applyCommit(userId, [{ path, baseRevision, content: Buffer.from(bytes).toString("base64"), encoding: "base64", contentType }], { trusted: true }), acknowledge);
    },
    async rebuild(userId) {
      const manifest = await assemble(userId, await migrateLegacy(userId));
      return { manifest, projection: await projectLatest(userId, manifest.revision, async () => manifest, { force: true }) };
    },
    async persistAttachment({ userId, attachment, bytes }) {
      const root = await migrateLegacy(userId);
      const { path, metadataPath } = attachmentPaths(attachment);
      const current = await entriesFor(userId, root, [path, metadataPath]);
      if (current[metadataPath]?.deleted) throw new VaultConflictError([metadataPath], { schemaVersion: 1, revision: root.revision, files: pick(current, [metadataPath]) });
      const { entries } = await applyCommit(userId, attachmentChanges(attachment, Buffer.from(bytes), current), { trusted: true });
      return { path, revision: entries[path].revision };
    },
    async readAttachment({ userId, documentId }) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(documentId)) throw new HttpError(400, "Invalid attachment identity.");
      const root = await migrateLegacy(userId);
      const path = `Attachments/${documentId}/metadata.json`;
      const entry = (await entriesFor(userId, root, [path]))[path];
      if (!entry || entry.deleted) throw new HttpError(404, "Document original not found.");
      const metadata = JSON.parse((await readFile({ userId, path, revision: entry.revision })).bytes.toString("utf8"));
      const original = typeof metadata.path === "string" ? (await entriesFor(userId, root, [metadata.path]))[metadata.path] : undefined;
      if (!original || original.deleted) throw new HttpError(404, "Document original not found.");
      return { ...metadata, bytes: (await readFile({ userId, path: metadata.path, revision: original.revision })).bytes };
    },
    async deleteAttachment({ userId, documentId }) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(documentId)) throw new HttpError(400, "Invalid attachment identity.");
      const current = await assemble(userId, await migrateLegacy(userId));
      const changes = Object.entries(current.files)
        .filter(([path, entry]) => path.startsWith(`Attachments/${documentId}/`) && !entry.deleted)
        .map(([path, entry]) => ({ path, baseRevision: entry.revision, content: null }));
      const { root } = await applyCommit(userId, changes);
      const projection = await projectLatest(userId, root.revision, lazyManifest(userId, root));
      if (projection.status !== "ready") {
        throw new HttpError(503, "The cloud deletion is saved, but its search index is still pending. Retry deleting this document to finish removing its derived data.");
      }
      return changes.length > 0 || current.files[`Attachments/${documentId}/metadata.json`]?.deleted === true;
    },
  };
}
