// Taking a vault folder's files into the vault, and the vault's files back into the folder, apart from where
// they run. The page runs these on the folder it connected (useMarkdownVault); the desktop app runs them in
// its main process to keep the folder and the cloud vault in step. Neither keeps any state of its own here:
// the caller holds what it last read (a FolderReading) and passes it back each time.
import type { VaultSync } from "./vaultSync";
import type { DirectoryStats, VaultFile, VaultSnapshot } from "./vaultTypes";
import type { MarkdownWorkspace } from "./workspaceMarkdown";
import { workspaceFromVault, workspaceVaultFiles } from "./vaultWorkspace";
import { FolderDeletionHeldError, folderDeletionsToHold, type HeldFolderDeletion } from "./folderDeletionGuard";
import {
  FolderUnavailableError, isCompanionPath, listConnectedDirectoryFiles, readConnectedDirectoryCompanions, readDirectoryWorkspace,
  writeConnectedDirectory, type ConnectedFolder, type DirectoryWrite, type LocalDirectoryWorkspace,
} from "./workspaceStorage";
import { scanWhileFolderSettles } from "./fileSnapshot";
import type { VaultFileListing } from "./vaultFileDocuments";
import { toVaultFs } from "./vaultFsAccess";

type DirectoryBaseline = NonNullable<VaultSnapshot["directoryBaselines"]>[string];

/** The folder as last taken in or written: its Markdown, its companions, and the size and date each was read at. */
export interface FolderReading {
  workspace: MarkdownWorkspace | null;
  companions: Record<string, VaultFile>;
  stats: DirectoryStats;
}

/** One look at the folder: its Markdown, the PDFs and images it lists, and its companions. */
export interface FolderScan {
  markdown: LocalDirectoryWorkspace;
  listing: VaultFileListing[];
  companions: { files: Record<string, VaultFile>; stats: DirectoryStats };
}

const NOT_SYNCED_MARKDOWN = /^(?:attachments|_conflicts|\.margin-chat)\//i;

/** What the vault remembers of this folder, as a reading; nothing remembered means the folder is new to this vault. */
export function folderReadingFromBaseline(baseline: DirectoryBaseline | undefined): FolderReading {
  if (!baseline) return { workspace: null, companions: {}, stats: {} };
  return {
    workspace: {
      manifest: baseline.manifest,
      files: Object.fromEntries(Object.entries(baseline.files)
        .filter(([path, file]) => /\.md$/i.test(path) && !NOT_SYNCED_MARKDOWN.test(path) && !file.encoding)
        .map(([path, file]) => [path, file.content])),
    },
    companions: Object.fromEntries(Object.entries(baseline.files).filter(([path]) => isCompanionPath(path))),
    stats: baseline.stats ?? {},
  };
}

/** What the vault keeps of a folder reading, so the next launch knows what the folder held. */
export function folderBaseline(workspace: MarkdownWorkspace, companions: Record<string, VaultFile>, stats: DirectoryStats): DirectoryBaseline {
  const files = {
    ...Object.fromEntries(Object.entries(workspace.files)
      .filter(([path]) => !NOT_SYNCED_MARKDOWN.test(path))
      .map(([path, content]) => [path, { content, contentType: "text/markdown; charset=utf-8" }])),
    ...companions,
  };
  // Stats only ever describe the bytes saved beside them.
  return { manifest: workspace.manifest, files, stats: Object.fromEntries(Object.entries(stats).filter(([path]) => files[path])) };
}

/**
 * Reads a connected folder: its Markdown (files still the size and date they were read at keep the text read
 * then), its PDFs and images, and its companions. `unsynced`, when given, collects the files it leaves alone.
 * A file still being written makes the scan wait and look again (FolderChangingError when it never settles).
 */
export async function scanConnectedFolder(folder: ConnectedFolder, userId: string, previous: FolderReading, unsynced?: string[]): Promise<FolderScan> {
  const fs = toVaultFs(folder);
  const markdown = await scanWhileFolderSettles(fs.name, () => readDirectoryWorkspace(fs, userId, previous.workspace?.manifest,
    previous.workspace?.files, previous.workspace ? previous.stats : undefined));
  const listing = await scanWhileFolderSettles(fs.name, () => { unsynced?.splice(0); return listConnectedDirectoryFiles(fs, "", unsynced); });
  const companions = await scanWhileFolderSettles(fs.name, () => readConnectedDirectoryCompanions(fs, previous.companions, listing, previous.stats));
  return { markdown, listing, companions };
}

/** Whether the folder itself opens; a folder that doesn't is never read as an empty one. */
export async function checkFolderAvailable(folder: ConnectedFolder, folderName: string) {
  const availability = await toVaultFs(folder).availability();
  if (availability !== "available") throw new FolderUnavailableError(folderName, availability);
}

export interface HeldDeletions {
  /** The person's answer for exactly these held paths, if they gave one. */
  choice(key: string): "restore" | "delete" | null;
  /** Called while the scan would delete many files and no answer is given yet. */
  hold(pending: HeldFolderDeletion, key: string): void;
  /** Called once a scan goes through, held or not. */
  release(): void;
}

/**
 * Takes what a scan found into the vault, against what the folder held when it was last read. A scan that
 * would delete many files is held (FolderDeletionHeldError) until the person answers. A folder new to this
 * vault is the person's own copy: where it and the vault hold different versions of a file, the folder's stays
 * current and the vault's goes to history. Returns the new reading.
 */
export async function takeInFolderScan(engine: VaultSync, folder: { id: string; name: string }, previous: FolderReading, scan: FolderScan,
  held: HeldDeletions): Promise<FolderReading> {
  const { markdown: incoming, companions: read } = scan;
  const companions = read.files;
  const stats = { ...incoming.stats, ...read.stats };
  // Settings are parsed/canonicalized with Markdown; preserve raw companion bytes for disk checks.
  const withoutSettings = (files: Record<string, VaultFile>) => Object.fromEntries(Object.entries(files).filter(([path]) => path !== "workspace.json"));
  // A new plain file without a date takes its time on disk, so it lists with recent documents
  // instead of as the oldest one. Both sides use the same dates so unchanged files never look edited.
  const dates = incoming.modifiedAt;
  const next = { ...workspaceVaultFiles(incoming.workspace, true, dates), ...withoutSettings(companions) };
  const expected = { ...(previous.workspace ? workspaceVaultFiles(previous.workspace, true, dates) : {}), ...withoutSettings(previous.companions) };
  const baseline = folderBaseline(incoming.workspace, companions, stats);
  const directory = { id: folder.id, baseline };
  // An empty newly chosen directory is an output destination, not deletion of the vault.
  if (previous.workspace) {
    // A plain file the vault wrote into the folder is held by the vault without an identity header. When the
    // folder changes or deletes it, that applies to the vault's own copy as written, with no header added, so it
    // merges with edits made elsewhere meanwhile instead of against a headed version the vault never held.
    const current = (await engine.read()).files;
    for (const [path, text] of Object.entries(previous.workspace.files)) {
      const vaultCopy = current[path];
      const edited = incoming.workspace.files[path];
      if (!vaultCopy || vaultCopy.encoding || vaultCopy.content !== text || expected[path]?.content === text || edited === text) continue;
      if (edited !== undefined && next[path]?.content === expected[path]?.content) continue;
      expected[path] = vaultCopy;
      if (edited !== undefined) next[path] = { ...vaultCopy, content: edited };
    }
    // A folder that was emptied, moved or unmounted must not delete the vault everywhere.
    const paths = folderDeletionsToHold(next, expected);
    const key = paths.join("\n");
    const choice = paths.length ? held.choice(key) : null;
    if (paths.length && !choice) {
      const pending = { folderName: folder.name, paths };
      held.hold(pending, key);
      throw new FolderDeletionHeldError(pending);
    }
    // Putting them back keeps the vault's copies; the folder write that follows restores them on disk.
    if (choice === "restore") for (const path of paths) next[path] = expected[path];
    held.release();
    await engine.edit(next, expected, directory);
  }
  // A legacy JSON-only folder (no modification times) is an old snapshot instead, so the vault keeps its versions.
  else if (Object.keys(incoming.workspace.files).length || Object.keys(companions).length) {
    await engine.import(next, directory, incoming.modifiedAt ? { keep: "imported", originals: incoming.workspace.files } : {});
  }
  else await engine.rememberDirectory(directory.id, baseline);
  return { workspace: incoming.workspace, companions, stats };
}

/** What to write so the folder holds the vault's files, starting from what it held when last read. */
export function folderWrite(snapshot: VaultSnapshot, previous: FolderReading & { workspace: MarkdownWorkspace }): DirectoryWrite {
  return {
    workspace: workspaceFromVault(snapshot.files, previous.workspace),
    expectedWorkspace: previous.workspace,
    files: snapshot.files,
    expectedFiles: previous.companions,
    stats: previous.stats,
  };
}

/** After a folder write: the vault remembers what the folder now holds, and that is the new reading. */
export async function rememberFolderWrite(engine: VaultSync, folderId: string, write: DirectoryWrite,
  written: { companions: Record<string, VaultFile>; stats: DirectoryStats }): Promise<FolderReading> {
  await engine.rememberDirectory(folderId, folderBaseline(write.workspace, written.companions, written.stats));
  return { workspace: write.workspace, companions: written.companions, stats: written.stats };
}

/** Writes the vault's files into a connected folder and remembers what it then holds. */
export async function writeVaultToFolder(engine: VaultSync, folder: ConnectedFolder, folderId: string, userId: string, snapshot: VaultSnapshot,
  previous: FolderReading & { workspace: MarkdownWorkspace }): Promise<FolderReading> {
  const write = folderWrite(snapshot, previous);
  const written = await writeConnectedDirectory(folder, userId, write);
  return rememberFolderWrite(engine, folderId, write, written);
}
