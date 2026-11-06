import type { VaultSync } from "./vaultSync";
import type { DirectoryStats, VaultFile, VaultSnapshot } from "./vaultTypes";
import type { MarkdownWorkspace } from "./workspaceMarkdown";
import { workspaceFromVault, workspaceVaultFiles } from "./vaultWorkspace";
import { FolderDeletionHeldError, folderDeletionsToHold, type HeldFolderDeletion } from "./folderDeletionGuard";
import type { VaultFileListing } from "./vaultFileDocuments";
import {
  FolderUnavailableError, LocalDirectoryConflictError, isCompanionPath, type DirectoryWrite, type LocalDirectoryStatus, type LocalDirectoryWorkspace,
  getLocalDirectoryStatus, listLocalDirectories, listLocalDirectoryFiles, localDirectoryAvailability, readLocalDirectoryCompanions, readLocalDirectoryWorkspace,
  writeLocalDirectory, type RememberedLocalDirectory,
} from "./workspaceStorage";

/**
 * How the mirror reaches the connected folder. The web client binds these to the
 * folder remembered for an account (`createFolderAccess`); the desktop app's main
 * process binds them to the folder it owns.
 */
export interface FolderAccess {
  status(): Promise<LocalDirectoryStatus>;
  directories(): Promise<RememberedLocalDirectory[]>;
  availability(directoryId: string): Promise<"available" | "missing" | "refused">;
  readWorkspace(fallbackManifest: MarkdownWorkspace["manifest"] | undefined, previousFiles: Record<string, string> | undefined, directoryId: string, stats: DirectoryStats): Promise<LocalDirectoryWorkspace | null>;
  listFiles(directoryId: string): Promise<VaultFileListing[] | null>;
  readCompanions(known: Record<string, VaultFile>, directoryId: string, listing: VaultFileListing[], stats: DirectoryStats): Promise<{ files: Record<string, VaultFile>; stats: DirectoryStats } | null>;
  write(write: DirectoryWrite, directoryId: string): Promise<{ status: LocalDirectoryStatus; companions: Record<string, VaultFile>; stats: DirectoryStats } | null>;
}

/** The folder remembered for `userId` on this device, through the browser's folder API or the desktop bridge. */
export function createFolderAccess(userId: string): FolderAccess {
  return {
    status: () => getLocalDirectoryStatus(userId),
    directories: () => listLocalDirectories(userId).catch(() => []),
    availability: (directoryId) => localDirectoryAvailability(userId, directoryId),
    readWorkspace: (fallbackManifest, previousFiles, directoryId, stats) => readLocalDirectoryWorkspace(userId, fallbackManifest, previousFiles, directoryId, stats),
    listFiles: (directoryId) => listLocalDirectoryFiles(userId, directoryId),
    readCompanions: (known, directoryId, listing, stats) => readLocalDirectoryCompanions(userId, known, directoryId, listing, stats),
    write: (write, directoryId) => writeLocalDirectory(userId, write, directoryId),
  };
}

export interface FolderMirrorEvents {
  /** The folder's status and the folders remembered on this device, whenever they are looked up. */
  onStatus?(status: LocalDirectoryStatus, directories: RememberedLocalDirectory[]): void;
  /** Whether the remembered folder itself can't be opened right now (moved, unplugged, refused). */
  onUnavailable?(unavailable: boolean): void;
  /** A scan that would delete many documents waits for an answer (`resolveHeldDeletion`); null once answered or moot. */
  onHeldDeletion?(held: HeldFolderDeletion | null): void;
}

/**
 * Keeps a connected folder and the vault engine in step: reads what changed in
 * the folder into the vault (with the deletion guard), and writes the vault
 * back into the folder, remembering per folder what was last read so unchanged
 * files cost only their size and date. This is the logic the web client ran in
 * its vault hook; the desktop app's main process runs the same code against the
 * folder it owns (`docs/desktop-vault-sync.md`).
 */
export class FolderMirror {
  private folder: MarkdownWorkspace | null = null;
  private folderId: string | null = null;
  private companions: Record<string, VaultFile> = {};
  /** The size and date each file in `folder` and `companions` was read at. */
  private stats: DirectoryStats = {};
  /** PDFs and images in the connected folder, including ones too large to sync. */
  private files: VaultFileListing[] = [];
  private heldKey: string | null = null;
  private heldChoice: { key: string; choice: "restore" | "delete" } | null = null;

  constructor(private readonly engine: VaultSync, private readonly access: FolderAccess, private readonly events: FolderMirrorEvents = {}) {}

  /** The connected folder's id once it has been read, for watchers and baselines. */
  get connectedId() { return this.folderId; }
  /** Files in the folder that are not Markdown, as last listed. */
  get localFiles() { return this.files; }
  /** The folder's Markdown as last incorporated, to build a write from the vault's files. */
  get lastRead() { return this.folder; }

  forget() {
    this.folderId = null; this.folder = null; this.companions = {}; this.stats = {}; this.files = [];
  }

  forgetHeldDeletion() {
    this.heldChoice = null;
    if (this.heldKey === null) return;
    this.heldKey = null;
    this.events.onHeldDeletion?.(null);
  }

  /** Answer a held scan: the next read writes the files back, or lets the deletion through. */
  resolveHeldDeletion(choice: "restore" | "delete") {
    if (this.heldKey === null) return false;
    this.heldChoice = { key: this.heldKey, choice };
    return true;
  }

  /**
   * Whether the connected folder can be read now: one is chosen, access is allowed, and the folder itself opens.
   * Reads no files, so it can run before the workspace shows. Returns the folder's status when it can be read.
   */
  async checkAccess() {
    const status = await this.access.status();
    this.events.onStatus?.(status, await this.access.directories());
    if (status.permission !== "granted" || !status.directoryId) {
      this.forget();
      this.events.onUnavailable?.(false);
      this.forgetHeldDeletion();
      return null;
    }
    // A folder that can't be opened is not an empty folder: nothing is imported, deleted or written until it is back.
    const availability = await this.access.availability(status.directoryId);
    this.events.onUnavailable?.(availability !== "available");
    if (availability !== "available") throw new FolderUnavailableError(status.directoryName ?? "your vault folder", availability);
    return { ...status, directoryId: status.directoryId };
  }

  /** Reads what changed in the folder into the vault. Throws FolderDeletionHeldError while a large deletion waits. */
  async read() {
    const status = await this.checkAccess();
    if (!status) return;
    if (this.folderId !== status.directoryId) {
      this.forgetHeldDeletion();
      const baseline = (await this.engine.read()).directoryBaselines?.[status.directoryId];
      this.folder = baseline ? {
        manifest: baseline.manifest,
        files: Object.fromEntries(Object.entries(baseline.files)
          .filter(([path, file]) => /\.md$/i.test(path) && !/^(?:attachments|_conflicts|\.margin-chat)\//i.test(path) && !file.encoding)
          .map(([path, file]) => [path, file.content])),
      } : null;
      this.companions = baseline ? Object.fromEntries(Object.entries(baseline.files).filter(([path]) => isCompanionPath(path))) : {};
      this.stats = baseline?.stats ?? {};
      this.folderId = status.directoryId;
    }
    // Files still the size and date they were read at keep the text read then; the rest are read now.
    const incoming = await this.access.readWorkspace(this.folder?.manifest, this.folder?.files, status.directoryId, this.stats);
    if (!incoming) return;
    const listing = await this.access.listFiles(status.directoryId);
    if (!listing) return;
    const read = await this.access.readCompanions(this.companions, status.directoryId, listing, this.stats);
    if (!read) return;
    const companions = read.files;
    const stats = { ...incoming.stats, ...read.stats };
    this.files = listing;
    // Settings are parsed/canonicalized with Markdown; preserve raw companion bytes for disk checks.
    const withoutSettings = (files: Record<string, VaultFile>) => Object.fromEntries(Object.entries(files).filter(([path]) => path !== "workspace.json"));
    // A new plain file without a date takes its time on disk, so it lists with recent documents
    // instead of as the oldest one. Both sides use the same dates so unchanged files never look edited.
    const dates = incoming.modifiedAt;
    const next = { ...workspaceVaultFiles(incoming.workspace, true, dates), ...withoutSettings(companions) };
    const expected = { ...(this.folder ? workspaceVaultFiles(this.folder, true, dates) : {}), ...withoutSettings(this.companions) };
    const baseline = folderBaseline(incoming.workspace, companions, stats);
    const directory = { id: status.directoryId, baseline };
    // An empty newly chosen directory is an output destination, not deletion of the vault.
    if (this.folder) {
      // A folder that was emptied, moved or unmounted must not delete the vault everywhere.
      const held = folderDeletionsToHold(next, expected);
      const key = held.join("\n");
      const choice = this.heldChoice?.key === key ? this.heldChoice.choice : null;
      if (held.length && !choice) {
        const pending = { folderName: status.directoryName ?? "your vault folder", paths: held };
        if (this.heldKey !== key) {
          this.heldKey = key;
          this.events.onHeldDeletion?.(pending);
        }
        throw new FolderDeletionHeldError(pending);
      }
      // Putting them back keeps the vault's copies; the folder write below restores them on disk.
      if (choice === "restore") for (const path of held) next[path] = expected[path];
      this.forgetHeldDeletion();
      await this.engine.edit(next, expected, directory);
    }
    // A folder connected for the first time is the person's own copy: where it and the vault hold different
    // versions of a file, the folder's stays current and the vault's goes to history. A legacy JSON-only
    // folder (no modification times) is an old snapshot instead, so the vault keeps its versions.
    else if (Object.keys(incoming.workspace.files).length || Object.keys(companions).length) {
      await this.engine.import(next, directory, incoming.modifiedAt ? { keep: "imported", originals: incoming.workspace.files } : {});
    }
    else await this.engine.rememberDirectory(directory.id, baseline);
    this.folder = incoming.workspace;
    this.companions = companions;
    this.stats = stats;
  }

  /** Writes the vault into the folder. Returns the folder's status after the write, or null when nothing was written. */
  async write(snapshot: VaultSnapshot): Promise<LocalDirectoryStatus | null> {
    if (!this.folder || !this.folderId) return null;
    const directoryId = this.folderId;
    const workspace = workspaceFromVault(snapshot.files, this.folder);
    let written: Awaited<ReturnType<FolderAccess["write"]>>;
    try {
      written = await this.access.write({ workspace, expectedWorkspace: this.folder, files: snapshot.files, expectedFiles: this.companions, stats: this.stats }, directoryId);
    } catch (error) {
      // A file that changed under the write is read again next time, whatever its size and date.
      if (error instanceof LocalDirectoryConflictError) {
        const changed = new Set(error.paths);
        this.stats = Object.fromEntries(Object.entries(this.stats).filter(([path]) => !changed.has(path)));
      }
      throw error;
    }
    if (!written) return null;
    await this.engine.rememberDirectory(directoryId, folderBaseline(workspace, written.companions, written.stats));
    this.folder = workspace;
    this.companions = written.companions;
    this.stats = written.stats;
    return written.status;
  }
}

export function folderBaseline(workspace: MarkdownWorkspace, companions: Record<string, VaultFile>, stats: DirectoryStats) {
  const files = {
    ...Object.fromEntries(Object.entries(workspace.files)
      .filter(([path]) => !/^(?:attachments|_conflicts|\.margin-chat)\//i.test(path))
      .map(([path, content]) => [path, { content, contentType: "text/markdown; charset=utf-8" }])),
    ...companions,
  };
  // Stats only ever describe the bytes saved beside them.
  return { manifest: workspace.manifest, files, stats: Object.fromEntries(Object.entries(stats).filter(([path]) => files[path])) };
}
