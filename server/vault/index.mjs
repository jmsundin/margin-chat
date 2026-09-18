import { HttpError } from "../lib/errors.mjs";
import { createVaultStorage, digest } from "./storage.mjs";

const MAX_FILES = 10_000;
const MAX_COMMIT_BYTES = 3 * 1024 * 1024;
const REVISION = /^[a-f0-9]{64}$/u;
const emptyManifest = () => ({ schemaVersion: 1, revision: 0, files: {} });
const missingConfiguration = () => new HttpError(503, "Cloud Markdown storage is not configured. Connect a private Vercel Blob store, or set VAULT_STORAGE_DIR for local development. Your local files remain saved.");

export function validateVaultPath(path) {
  if (typeof path !== "string" || !path || path.length > 512 ||
      /[\\\u0000-\u001f\u007f]/u.test(path) ||
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

function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !value.files || typeof value.files !== "object" || Array.isArray(value.files)) throw new Error("Invalid stored vault manifest.");
  for (const [path, entry] of Object.entries(value.files)) {
    validateVaultPath(path);
    if (!entry || !REVISION.test(entry.revision) || typeof entry.deleted !== "boolean") throw new Error("Invalid stored vault file revision.");
  }
  return value;
}

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
    if (!deleted && encoding === "base64" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(change.content)) throw new HttpError(400, "Invalid base64 attachment.");
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

export function createVaultService({ database, env = process.env, storage = createVaultStorage(env), codec: codecOverride } = {}) {
  const configured = Boolean(storage);
  let codecPromise;
  const codec = () => codecOverride ?? (codecPromise ??= import("@margin-chat/workspace-contracts/markdown"));
  const prefix = (userId) => `vaults/v1/${digest(String(userId))}`;
  const manifestKey = (userId) => `${prefix(userId)}/manifest.json`;
  const bodyKey = (userId, path, revision) => `${prefix(userId)}/files/${digest(path)}/${revision}`;

  async function snapshot(userId) {
    if (!storage) throw missingConfiguration();
    const record = await storage.read(manifestKey(userId));
    return { manifest: record ? validateManifest(JSON.parse(record.bytes.toString("utf8"))) : emptyManifest(), etag: record?.etag ?? null };
  }

  async function readFile({ userId, path, revision }) {
    if (!storage) throw missingConfiguration();
    validateVaultPath(path);
    let entry;
    if (revision !== undefined && revision !== null && !REVISION.test(revision)) throw new HttpError(400, "Invalid file revision.");
    if (!revision) {
      entry = (await snapshot(userId)).manifest.files[path];
      if (!entry || entry.deleted) throw new HttpError(404, "Vault file not found.");
      revision = entry.revision;
    }
    const record = await storage.read(bodyKey(userId, path, revision));
    if (!record) throw new HttpError(404, "Vault file revision not found.");
    return { bytes: record.bytes, revision, contentType: entry?.contentType ?? (path.endsWith(".md") ? "text/markdown; charset=utf-8" : path.endsWith(".json") ? "application/json" : "application/octet-stream") };
  }

  async function commitFiles(userId, changes, { trusted = false, onlyInitialize = false } = {}) {
    if (!storage) throw missingConfiguration();
    const prepared = prepareChanges(changes, trusted);
    let uploaded = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await snapshot(userId);
      if (onlyInitialize && current.manifest.revision !== 0) return current.manifest;
      const conflicts = [];
      const effective = [];
      for (const change of prepared) {
        const existing = current.manifest.files[change.path];
        if ((existing?.revision === change.entry.revision) || (existing?.deleted && change.entry.deleted)) continue;
        if ((existing?.revision ?? null) !== change.baseRevision) conflicts.push(change.path);
        else if (!existing && change.entry.deleted) continue;
        else effective.push(change);
      }
      if (conflicts.length) throw new VaultConflictError(conflicts, current.manifest);
      if (!effective.length) return current.manifest;
      if (!uploaded) {
        await mapConcurrent(prepared.filter((change) => change.bytes), (change) =>
          storage.putImmutable(bodyKey(userId, change.path, change.entry.revision), change.bytes, change.entry.contentType));
        uploaded = true;
      }
      const next = { schemaVersion: 1, revision: current.manifest.revision + 1, files: { ...current.manifest.files } };
      for (const change of effective) next.files[change.path] = change.entry;
      if (Object.keys(next.files).length > MAX_FILES) throw new HttpError(413, "This vault has reached the current 10,000-file sync limit.");
      const bytes = Buffer.from(JSON.stringify(next));
      // History is written before publishing. Losing a CAS may leave an orphan,
      // but no manifest can ever reference an incompletely uploaded revision.
      await storage.putImmutable(`${prefix(userId)}/history/${digest(bytes)}.json`, bytes, "application/json");
      if (await storage.compareAndSwap(manifestKey(userId), bytes, current.etag)) return next;
      // Re-read and compare with ORIGINAL per-file bases. Never retag stale edits.
    }
    throw new HttpError(503, "Other devices are updating the vault. Retry this same change shortly.");
  }

  function attachmentChanges(attachment, bytes, current = emptyManifest()) {
    const filename = String(attachment.filename ?? "attachment").replace(/[\\/\u0000-\u001f%:#?]/gu, "_").replace(/^\.+$/u, "attachment").slice(0, 180) || "attachment";
    const id = String(attachment.id);
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) throw new HttpError(400, "Invalid attachment identity.");
    const path = `Attachments/${id}/${filename === "metadata.json" ? "original-metadata.json" : filename}`;
    const metadataPath = `Attachments/${id}/metadata.json`;
    const descriptor = { ...attachment, bytes: undefined, path, sizeBytes: bytes.length };
    return [
      { path, content: bytes.toString("base64"), encoding: "base64", contentType: attachment.mimeType || "application/octet-stream", baseRevision: current.files[path]?.revision ?? null },
      { path: metadataPath, content: JSON.stringify(descriptor, null, 2), baseRevision: current.files[metadataPath]?.revision ?? null },
    ];
  }

  async function migrateLegacy(userId) {
    const current = await snapshot(userId);
    if (current.manifest.revision !== 0) return current.manifest;
    const legacy = await database?.loadWorkspace?.(userId);
    const conversations = Object.values(legacy?.state?.conversations ?? {});
    const onlyDraft = conversations.length === 1 && conversations[0].kind !== "note" &&
      conversations[0].title === "New chat" && !conversations[0].messages?.length &&
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
    return commitFiles(userId, changes, { trusted: true, onlyInitialize: true });
  }

  async function readWorkspace(userId, manifest) {
    manifest ??= (await snapshot(userId)).manifest;
    const records = Object.entries(manifest.files).filter(([path, entry]) => !entry.deleted && !/^(?:_conflicts|attachments)\//iu.test(path)
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

  async function projectLatest(userId, manifest, { force = false } = {}) {
    if (!database?.projectVaultState || !manifest.revision) return { status: "ready", revision: manifest.revision };
    try {
      if (!force && (await database.getVaultProjectionRevision?.(userId) ?? -1) >= manifest.revision) return { status: "ready", revision: manifest.revision };
      const state = await readWorkspace(userId, manifest);
      const attachments = Object.entries(manifest.files).filter(([path, entry]) => !entry.deleted && /^Attachments\/[^/]+\/metadata\.json$/u.test(path));
      const originals = await mapConcurrent(attachments, async ([path, entry]) => {
          const attachment = JSON.parse((await readFile({ userId, path, revision: entry.revision })).bytes.toString("utf8"));
          const bodyEntry = manifest.files[attachment.path];
          if (!bodyEntry || bodyEntry.deleted) throw new Error("An attachment original is missing from the vault.");
          const bytes = (await readFile({ userId, path: attachment.path, revision: bodyEntry.revision })).bytes;
          return { attachment, bytes };
        });
      const deletedAttachmentIds = Object.entries(manifest.files)
        .filter(([path, entry]) => entry.deleted && /^Attachments\/[^/]+\/metadata\.json$/u.test(path))
        .map(([path]) => path.split("/")[1]);
      await database.projectVaultState(userId, state, manifest.revision, { force, attachments: originals, deletedAttachmentIds });
      return { status: "ready", revision: manifest.revision };
    } catch (error) {
      console.error("Vault projection pending", error);
      return { status: "pending", revision: manifest.revision, error: "Your Markdown is saved. Feature indexes will retry when you next sync." };
    }
  }

  return {
    configured,
    storageKind: storage?.kind ?? null,
    readFile,
    readWorkspace,
    snapshot,
    async status(userId) {
      if (!configured) return { configured: false, manifest: emptyManifest() };
      const manifest = await migrateLegacy(userId);
      return { configured: true, manifest, projection: await projectLatest(userId, manifest) };
    },
    async commit(userId, changes) {
      // Preserve the server's legacy copy before considering a device's first edit.
      await migrateLegacy(userId);
      const manifest = await commitFiles(userId, changes);
      return { manifest, projection: await projectLatest(userId, manifest) };
    },
    async commitBinary(userId, { path, baseRevision, bytes, contentType }) {
      if (bytes.length > 4 * 1024 * 1024) throw new HttpError(413, "An attachment must be at most 4 MiB.");
      await migrateLegacy(userId);
      const manifest = await commitFiles(userId, [{ path, baseRevision, content: Buffer.from(bytes).toString("base64"), encoding: "base64", contentType }], { trusted: true });
      return { manifest, projection: await projectLatest(userId, manifest) };
    },
    async rebuild(userId) {
      const manifest = await migrateLegacy(userId);
      return { manifest, projection: await projectLatest(userId, manifest, { force: true }) };
    },
    async persistAttachment({ userId, attachment, bytes }) {
      const current = await migrateLegacy(userId);
      const metadataPath = `Attachments/${attachment.id}/metadata.json`;
      if (current.files[metadataPath]?.deleted) throw new VaultConflictError([metadataPath], current);
      const changes = attachmentChanges(attachment, Buffer.from(bytes), current);
      const manifest = await commitFiles(userId, changes, { trusted: true });
      return { path: changes[0].path, revision: manifest.files[changes[0].path].revision };
    },
    async readAttachment({ userId, documentId }) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(documentId)) throw new HttpError(400, "Invalid attachment identity.");
      const manifest = await migrateLegacy(userId);
      const path = `Attachments/${documentId}/metadata.json`;
      const entry = manifest.files[path];
      if (!entry || entry.deleted) throw new HttpError(404, "Document original not found.");
      const metadata = JSON.parse((await readFile({ userId, path, revision: entry.revision })).bytes.toString("utf8"));
      const original = manifest.files[metadata.path];
      if (!original || original.deleted) throw new HttpError(404, "Document original not found.");
      return { ...metadata, bytes: (await readFile({ userId, path: metadata.path, revision: original.revision })).bytes };
    },
    async deleteAttachment({ userId, documentId }) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(documentId)) throw new HttpError(400, "Invalid attachment identity.");
      const current = await migrateLegacy(userId);
      const changes = Object.entries(current.files)
        .filter(([path, entry]) => path.startsWith(`Attachments/${documentId}/`) && !entry.deleted)
        .map(([path, entry]) => ({ path, baseRevision: entry.revision, content: null }));
      if (!changes.length) return false;
      await commitFiles(userId, changes);
      return true;
    },
  };
}
