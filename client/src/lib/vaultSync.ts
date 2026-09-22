import {
  emptyVault, sameVaultFile, validVaultPath,
  type VaultChange, type VaultFile, type VaultSnapshot, type VaultStore, type VaultTransport,
} from "./vaultTypes";
import { reconcileVaultImportPaths, validateVaultWorkspace, workspaceFromVault } from "./vaultWorkspace";
import type { HistoryImportReceipt } from "./chatHistoryImport";
import { parseMarkdownWorkspace } from "./workspaceMarkdown";

function assignFile(snapshot: VaultSnapshot, path: string, file: VaultFile | null | undefined) {
  if (file) snapshot.files[path] = file;
  else delete snapshot.files[path];
}

function preserveConflict(snapshot: VaultSnapshot, path: string, local: VaultFile | null, remote: VaultFile | null, sourcePath?: string) {
  if (snapshot.conflicts.some((conflict) => conflict.path === path
    && sameVaultFile(conflict.local, local) && sameVaultFile(conflict.remote, remote))) return;
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  snapshot.conflicts.push({ id, path, local, remote, createdAt, ...(sourcePath ? { sourcePath } : {}) });
  const backupPath = `_conflicts/${id}/local/${path.split("/").pop()}`;
  const remotePath = `_conflicts/${id}/remote/${path.split("/").pop()}`;
  if (local) snapshot.files[backupPath] = { ...local };
  if (remote) snapshot.files[remotePath] = { ...remote };
  snapshot.files[`_conflicts/${id}/conflict.json`] = {
    content: JSON.stringify({ path, createdAt, localDeleted: !local, remoteDeleted: !remote, copy: local ? backupPath : null,
      remoteCopy: remote ? remotePath : null, localEncoding: local?.encoding ?? "utf8", remoteEncoding: remote?.encoding ?? "utf8",
      ...(sourcePath ? { sourcePath } : {}) }, null, 2),
    contentType: "application/json",
  };
}

export function pendingVaultChanges(snapshot: VaultSnapshot): VaultChange[] {
  return [...new Set([...Object.keys(snapshot.files), ...Object.keys(snapshot.base)])]
    .sort().flatMap((path) => {
      const file = snapshot.files[path] ?? null;
      const base = snapshot.base[path];
      if (sameVaultFile(file, base?.file)) return [];
      return [{ path, baseRevision: base?.revision ?? null, content: file?.content ?? null,
        ...(file?.encoding ? { encoding: file.encoding } : {}),
        ...(file?.contentType ? { contentType: file.contentType } : {}),
      }];
    });
}

function nextVaultBatch(snapshot: VaultSnapshot): VaultChange[] {
  const changes = pendingVaultChanges(snapshot);
  const byPath = new Map(changes.map((change) => [change.path, change]));
  const previousFiles = Object.fromEntries(Object.entries(snapshot.base)
    .flatMap(([path, entry]) => entry.file ? [[path, entry.file]] : []));
  const previousById = new Map(workspaceFromVault(previousFiles).manifest.files.map((record) => [record.id, record.path]));
  const neighbors = new Map<string, Set<string>>();
  for (const record of workspaceFromVault(snapshot.files).manifest.files) {
    const previousPath = previousById.get(record.id);
    if (!previousPath || previousPath === record.path || !byPath.has(previousPath) || !byPath.has(record.path)) continue;
    // Swaps and rename chains connect more than two paths. Every connected
    // component must publish together, regardless of alphabetical ordering.
    if (!neighbors.has(previousPath)) neighbors.set(previousPath, new Set());
    if (!neighbors.has(record.path)) neighbors.set(record.path, new Set());
    neighbors.get(previousPath)!.add(record.path);
    neighbors.get(record.path)!.add(previousPath);
  }
  const batch: VaultChange[] = [];
  const visited = new Set<string>();
  let bytes = 0;
  for (const change of changes) {
    if (visited.has(change.path)) continue;
    const paths = [change.path];
    const group: VaultChange[] = [];
    while (paths.length) {
      const path = paths.pop()!;
      if (visited.has(path)) continue;
      visited.add(path);
      group.push(byPath.get(path)!);
      paths.push(...neighbors.get(path) ?? []);
    }
    const size = group.reduce((total, item) => total + new TextEncoder().encode(JSON.stringify(item)).length, 0);
    if (batch.length && (bytes + size > 3_000_000 || batch.length + group.length > 40)) break;
    // A binary singleton may use the larger raw-upload endpoint. A connected
    // Markdown rename must fit one JSON commit; splitting it corrupts identity.
    if (group.length > 1) {
      const decodedBytes = group.reduce((total, item) => total + (item.content === null ? 0 : item.encoding === "base64"
        ? item.content.length * 3 / 4 - (item.content.endsWith("==") ? 2 : item.content.endsWith("=") ? 1 : 0)
        : new TextEncoder().encode(item.content).length), 0);
      const bodyBytes = new TextEncoder().encode(JSON.stringify({ changes: group })).length;
      if (decodedBytes > 3 * 1024 * 1024 || bodyBytes > 4 * 1024 * 1024 || group.length > 1000) {
        throw new Error("These linked Markdown renames are too large to sync together. Your files remain saved locally; sync fewer renames at once.");
      }
    }
    batch.push(...group);
    bytes += size;
  }
  return batch;
}

/** Conflicts follow the document's surviving cloud identity, not an obsolete filename. */
function reconcileRemoteRenames(snapshot: VaultSnapshot, remoteFiles: Record<string, VaultFile>) {
  const previousFiles = Object.fromEntries(Object.entries(snapshot.base)
    .flatMap(([path, entry]) => entry.file ? [[path, entry.file]] : []));
  const localById = new Map(workspaceFromVault(snapshot.files).manifest.files.map((record) => [record.id, record.path]));
  const remoteById = new Map(workspaceFromVault(remoteFiles).manifest.files.map((record) => [record.id, record.path]));
  const moves: Array<{ sourcePath?: string; targetPath: string; local: VaultFile | null; remote: VaultFile | null }> = [];
  const previousRecords = workspaceFromVault(previousFiles).manifest.files;
  for (const previous of previousRecords) {
    const localPath = localById.get(previous.id);
    const remotePath = remoteById.get(previous.id);
    if (localPath === remotePath) continue;
    // An external editor can replace/remove identity metadata without moving
    // the file. Let normal same-path reconciliation keep its real remote body.
    if (!remotePath && localPath === previous.path && remoteFiles[previous.path]) continue;
    const local = localPath ? snapshot.files[localPath] : null;
    const remote = remotePath ? remoteFiles[remotePath] : null;
    const localChanged = localPath !== previous.path || !sameVaultFile(local, previousFiles[previous.path]);
    const remoteChanged = remotePath !== previous.path || !sameVaultFile(remote, previousFiles[previous.path]);
    if (!localChanged || !remoteChanged) continue;
    moves.push({ sourcePath: localPath, targetPath: remotePath ?? localPath!, local, remote });
  }
  // Independently restored devices may share an identity without a common
  // revision. Preserve both copies instead of committing duplicate documents.
  const previousIds = new Set(previousRecords.map((record) => record.id));
  for (const [id, localPath] of localById) {
    const remotePath = remoteById.get(id);
    if (previousIds.has(id) || !remotePath || localPath === remotePath) continue;
    moves.push({ sourcePath: localPath, targetPath: remotePath, local: snapshot.files[localPath], remote: remoteFiles[remotePath] });
  }
  // Capture every version before moving anything, including crossed renames.
  const movedSources = new Set(moves.map((move) => move.sourcePath));
  for (const move of moves) {
    preserveConflict(snapshot, move.targetPath, move.local, move.remote, move.sourcePath);
    const occupied = snapshot.files[move.targetPath];
    if (occupied && !movedSources.has(move.targetPath) && !sameVaultFile(occupied, previousFiles[move.targetPath])
      && !sameVaultFile(occupied, move.local) && !sameVaultFile(occupied, move.remote)) {
      preserveConflict(snapshot, move.targetPath, occupied, move.remote);
    }
  }
  for (const move of moves) if (move.sourcePath) delete snapshot.files[move.sourcePath];
  for (const move of moves) assignFile(snapshot, move.targetPath, move.remote);
}

/** Apply edits relative to the files the editor actually displayed, not the latest disk revision. */
export function applyVaultEdits(snapshot: VaultSnapshot, next: Record<string, VaultFile>, expected: Record<string, VaultFile>): VaultSnapshot {
  const result = structuredClone(snapshot);
  next = { ...next };
  expected = { ...expected };
  const nextById = new Map(workspaceFromVault(next).manifest.files.map((record) => [record.id, record.path]));
  // Move the latest local version with a recognized folder rename. Content edits
  // are then reconciled at its new path, so a concurrent local edit is not lost
  // or left behind as a second document carrying the same identity.
  for (const record of workspaceFromVault(expected).manifest.files) {
    const movedPath = nextById.get(record.id);
    if (!movedPath || movedPath === record.path || next[record.path] || expected[movedPath]) continue;
    const current = result.files[record.path];
    if (!current && !result.files[movedPath]) {
      // A rename on disk must not silently reverse a deletion made in the app.
      preserveConflict(result, movedPath, next[movedPath], null, record.path);
      delete next[movedPath];
      continue;
    }
    if (!current || result.files[movedPath]) continue;
    if (workspaceFromVault({ [record.path]: current }).manifest.files[0]?.id !== record.id) continue;
    result.files[movedPath] = current;
    delete result.files[record.path];
    expected[movedPath] = expected[record.path];
    delete expected[record.path];
  }
  for (const path of new Set([...Object.keys(next), ...Object.keys(expected)])) {
    if (!validVaultPath(path)) throw new Error("The vault contains an invalid file path.");
    const previous = expected[path] ?? null;
    const edited = next[path] ?? null;
    if (sameVaultFile(previous, edited)) continue;
    const current = result.files[path] ?? null;
    if (sameVaultFile(current, previous) || sameVaultFile(current, edited)) assignFile(result, path, edited);
    else preserveConflict(result, path, edited, current);
  }
  return result;
}

export class VaultSync {
  constructor(readonly store: VaultStore, readonly transport: VaultTransport) {}

  read() { return this.store.lock(async () => (await this.store.read()) ?? emptyVault()); }

  private async write(snapshot: VaultSnapshot) {
    validateVaultWorkspace(snapshot.files);
    await this.store.write(snapshot);
  }

  edit(next: Record<string, VaultFile>, expected: Record<string, VaultFile>, directory?: {
    id: string; baseline: NonNullable<VaultSnapshot["directoryBaselines"]>[string];
  }) {
    return this.store.lock(async () => {
      const snapshot = applyVaultEdits((await this.store.read()) ?? emptyVault(), next, expected);
      if (directory) snapshot.directoryBaselines = { ...snapshot.directoryBaselines, [directory.id]: structuredClone(directory.baseline) };
      await this.write(snapshot);
      return snapshot;
    });
  }

  rememberDirectory(id: string, baseline: NonNullable<VaultSnapshot["directoryBaselines"]>[string]) {
    return this.store.lock(async () => {
      const snapshot = (await this.store.read()) ?? emptyVault();
      snapshot.directoryBaselines = { ...snapshot.directoryBaselines, [id]: structuredClone(baseline) };
      await this.write(snapshot);
      return snapshot;
    });
  }

  import(files: Record<string, VaultFile>, directory?: {
    id: string; baseline: NonNullable<VaultSnapshot["directoryBaselines"]>[string];
  }) {
    return this.store.lock(async () => {
      const snapshot = (await this.store.read()) ?? emptyVault();
      validateVaultWorkspace(files);
      for (const { path, sourcePath, file } of reconcileVaultImportPaths(files, snapshot.files)) {
        if (!validVaultPath(path) || !validVaultPath(sourcePath)) throw new Error("The imported vault contains an invalid path.");
        const current = snapshot.files[path];
        if (!current) snapshot.files[path] = file;
        else if (!sameVaultFile(current, file)) preserveConflict(snapshot, path, file, current, sourcePath);
      }
      if (directory) snapshot.directoryBaselines = { ...snapshot.directoryBaselines, [directory.id]: structuredClone(directory.baseline) };
      await this.write(snapshot);
      return snapshot;
    });
  }

  resolve(id: string, choice: "local" | "remote" | "current") {
    return this.store.lock(async () => {
      const snapshot = (await this.store.read()) ?? emptyVault();
      const conflict = snapshot.conflicts.find((item) => item.id === id);
      if (!conflict) return snapshot;
      // A newer edit must not disappear when resolving an older conflict.
      if (choice !== "current" && !sameVaultFile(snapshot.files[conflict.path], conflict.remote)) {
        throw new Error("This file changed again. Sync and review its latest version before resolving it.");
      }
      if (choice === "local") assignFile(snapshot, conflict.path, conflict.local);
      snapshot.conflicts = snapshot.conflicts.filter((item) => item.id !== id);
      await this.write(snapshot);
      return snapshot;
    });
  }

  importChatHistory(files: Record<string, VaultFile>): Promise<HistoryImportReceipt> {
    return this.store.lock(async () => {
      const snapshot = structuredClone((await this.store.read()) ?? emptyVault());
      validateVaultWorkspace(files);
      const existing = new Set(workspaceFromVault(snapshot.files).manifest.files.map((file) => file.id));
      const receipt: HistoryImportReceipt = { files: {}, conversationIds: [], skipped: 0 };
      for (const file of workspaceFromVault(files).manifest.files) {
        if (existing.has(file.id)) { receipt.skipped++; continue; }
        if (snapshot.files[file.path]) throw new Error("An imported filename is already in use. Your existing chats have not changed.");
        snapshot.files[file.path] = files[file.path];
        receipt.files[file.path] = files[file.path];
        receipt.conversationIds.push(file.id);
        existing.add(file.id);
      }
      if (receipt.conversationIds.length) await this.write(snapshot);
      return structuredClone(receipt);
    });
  }

  undoChatHistory(receipt: HistoryImportReceipt) {
    return this.store.lock(async () => {
      const snapshot = structuredClone((await this.store.read()) ?? emptyVault());
      const workspace = workspaceFromVault(snapshot.files);
      const state = workspace.manifest.files.length ? parseMarkdownWorkspace(workspace.manifest, workspace.files) : null;
      // A link or branch can be added from another file without changing this chat's bytes.
      const referenced = new Set(Object.values(state?.conversations ?? {}).flatMap((chat) => [
        chat.parentId, chat.branchAnchor?.sourceConversationId, ...(chat.linkedConversationIds ?? []),
      ]).filter(Boolean));
      for (const id of state?.pinnedThreadIds ?? []) referenced.add(id);
      for (const group of Object.values(state?.groups ?? {})) for (const id of group.conversationIds) referenced.add(id);
      const originals = new Map(workspaceFromVault(receipt.files).manifest.files.map((file) => [file.path, file.id]));
      const currentPaths = new Map(workspace.manifest.files.map((file) => [file.id, file.path]));
      let removed = 0;
      let kept = 0;
      for (const [path, original] of Object.entries(receipt.files)) {
        const id = originals.get(path);
        const currentPath = id && currentPaths.get(id);
        if (!currentPath) continue;
        if (currentPath !== path || referenced.has(id) || !sameVaultFile(snapshot.files[path], original)) { kept++; continue; }
        delete snapshot.files[path]; removed++;
      }
      if (removed) await this.write(snapshot);
      return { removed, kept };
    });
  }

  private inFlight: Promise<VaultSnapshot> | null = null;

  sync(): Promise<VaultSnapshot> {
    // A network request may take arbitrarily long. Only local read/modify/write
    // operations hold the shared device lock, so typing remains durably savable.
    if (!this.inFlight) {
      this.inFlight = this.synchronize().finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  private async synchronize(): Promise<VaultSnapshot> {
    let races = 0;
    while (races < 4) {
      const started = await this.read();
      const remote = await this.transport.manifest();
      if (remote.revision < started.remoteRevision) {
        throw new Error("Cloud vault history has changed unexpectedly. Your local files are preserved; restore the cloud vault before syncing.");
      }
      const entries = Object.entries(remote.files);
      for (const [path] of entries) {
        if (!validVaultPath(path)) throw new Error("The cloud vault contains an invalid file path.");
      }
      const incoming = new Map<string, VaultFile | null>();
      const downloads = entries.filter(([path, entry]) => started.base[path]?.revision !== entry.revision);
      let downloadIndex = 0;
      await Promise.all(Array.from({ length: Math.min(8, downloads.length) }, async () => {
        while (downloadIndex < downloads.length) {
          const [path, entry] = downloads[downloadIndex++];
          incoming.set(path, entry.deleted ? null : await this.transport.read(path, entry));
        }
      }));

      const prepared = await this.store.lock(async () => {
        const snapshot = (await this.store.read()) ?? emptyVault();
        // Another tab may have committed or pulled while we fetched. Discard
        // that older response rather than treating it as a cloud history reset.
        if (snapshot.remoteRevision > remote.revision) return null;
        const remoteFiles: Record<string, VaultFile> = {};
        for (const [path, entry] of entries) {
          const base = snapshot.base[path];
          if (base?.revision !== entry.revision && !incoming.has(path)) return null;
          const file = base?.revision === entry.revision ? base.file : incoming.get(path);
          if (file) remoteFiles[path] = file;
        }
        reconcileRemoteRenames(snapshot, remoteFiles);
        for (const [path, entry] of entries) {
          const base = snapshot.base[path];
          if (base?.revision === entry.revision) continue;
          if (!incoming.has(path)) return null;
          const file = incoming.get(path)!;
          const local = snapshot.files[path] ?? null;
          if (sameVaultFile(local, base?.file) || sameVaultFile(local, file)) {
            assignFile(snapshot, path, file);
          } else {
            preserveConflict(snapshot, path, local, file);
            assignFile(snapshot, path, file);
          }
          snapshot.base[path] = { revision: entry.revision, file };
        }
        snapshot.remoteRevision = remote.revision;
        // Persist downloads/conflict copies before publishing further changes.
        await this.write(snapshot);
        const batch = nextVaultBatch(snapshot);
        return { snapshot, batch };
      });
      if (!prepared) { races += 1; continue; }
      if (!prepared.batch.length) return prepared.snapshot;

      let committed;
      try {
        committed = await this.transport.commit(prepared.batch);
      } catch (error) {
        if (!(error && typeof error === "object" && "statusCode" in error && error.statusCode === 409)) throw error;
        races += 1;
        continue;
      }
      for (const change of prepared.batch) {
        const entry = committed.files[change.path];
        if (!entry || entry.deleted !== (change.content === null)) {
          throw new Error("The server did not acknowledge a saved file.");
        }
      }
      const acknowledged = await this.store.lock(async () => {
        const snapshot = (await this.store.read()) ?? emptyVault();
        for (const change of prepared.batch) {
          const entry = committed.files[change.path];
          const latestBase = snapshot.base[change.path];
          // Never overwrite an edit made during the upload. Acknowledge exactly
          // the captured body and leave newer typing pending against that body.
          // Another tab's newer base must not be rolled back by a late response.
          if ((latestBase?.revision ?? null) === change.baseRevision) {
            snapshot.base[change.path] = { revision: entry.revision,
              file: change.content === null ? null : {
                content: change.content,
                ...(change.encoding ? { encoding: change.encoding } : {}),
                ...(change.contentType ? { contentType: change.contentType } : {}),
              } };
          }
        }
        snapshot.remoteRevision = Math.max(snapshot.remoteRevision, committed.revision);
        await this.write(snapshot);
        return snapshot;
      });
      if (!pendingVaultChanges(acknowledged).length) return acknowledged;
      // Drain additional batches without charging successful writes against the
      // bounded conflict retry budget. Each pass reads newly saved local edits.
      races = 0;
    }
    throw new Error("The vault is changing on another device. Your edits are saved locally; sync will retry shortly.");
  }
}
