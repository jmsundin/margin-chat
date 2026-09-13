import {
  emptyVault, sameVaultFile, validVaultPath,
  type VaultChange, type VaultFile, type VaultSnapshot, type VaultStore, type VaultTransport,
} from "./vaultTypes";

function assignFile(snapshot: VaultSnapshot, path: string, file: VaultFile | null | undefined) {
  if (file) snapshot.files[path] = file;
  else delete snapshot.files[path];
}

function preserveConflict(snapshot: VaultSnapshot, path: string, local: VaultFile | null, remote: VaultFile | null) {
  if (snapshot.conflicts.some((conflict) => conflict.path === path
    && sameVaultFile(conflict.local, local) && sameVaultFile(conflict.remote, remote))) return;
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  snapshot.conflicts.push({ id, path, local, remote, createdAt });
  const backupPath = `_conflicts/${id}/local/${path.split("/").pop()}`;
  if (local) snapshot.files[backupPath] = { ...local };
  snapshot.files[`_conflicts/${id}/conflict.json`] = {
    content: JSON.stringify({ path, createdAt, localDeleted: !local, remoteDeleted: !remote, copy: local ? backupPath : null }, null, 2),
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

/** Apply edits relative to the files the editor actually displayed, not the latest disk revision. */
export function applyVaultEdits(snapshot: VaultSnapshot, next: Record<string, VaultFile>, expected: Record<string, VaultFile>): VaultSnapshot {
  const result = structuredClone(snapshot);
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

  edit(next: Record<string, VaultFile>, expected: Record<string, VaultFile>) {
    return this.store.lock(async () => {
      const snapshot = applyVaultEdits((await this.store.read()) ?? emptyVault(), next, expected);
      await this.store.write(snapshot);
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
      await this.store.write(snapshot);
      return snapshot;
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
        await this.store.write(snapshot);
        const batch: VaultChange[] = [];
        let bytes = 0;
        for (const change of pendingVaultChanges(snapshot)) {
          const size = new TextEncoder().encode(JSON.stringify(change)).length;
          if (batch.length && (bytes + size > 3_000_000 || batch.length >= 40)) break;
          batch.push(change);
          bytes += size;
        }
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
        await this.store.write(snapshot);
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
