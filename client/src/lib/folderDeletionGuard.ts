import type { VaultFile } from "./vaultTypes";
import { workspaceFromVault } from "./vaultWorkspace";

/** One folder scan may remove up to this many files without asking first. */
export const FOLDER_DELETIONS_WITHOUT_ASKING = 10;
/** Or up to this share of the folder's files, once at least three are missing. */
export const FOLDER_DELETION_SHARE_WITHOUT_ASKING = 0.2;

export interface HeldFolderDeletion {
  folderName: string;
  /** Vault paths that disappeared from the folder, sorted. */
  paths: string[];
}

function markdownIds(files: Record<string, VaultFile>) {
  try {
    return new Map(workspaceFromVault(files).manifest.files.map((record) => [record.id, record.path]));
  } catch {
    return new Map<string, string>();
  }
}

/**
 * Files a folder scan would delete when there are so many that the folder was more
 * likely emptied, moved or unmounted than tidied by hand. A file that moved within
 * the folder keeps its identity (or, for PDFs and images, its bytes) and is not counted.
 * Returns nothing when the scan may be applied without asking.
 */
export function folderDeletionsToHold(next: Record<string, VaultFile>, expected: Record<string, VaultFile>): string[] {
  const counted = Object.keys(expected).filter((path) => path !== "workspace.json");
  let missing = counted.filter((path) => !next[path]);
  if (!missing.length) return [];
  const added = Object.keys(next).filter((path) => !expected[path]);
  if (added.length) {
    const nextIds = markdownIds(next);
    const movedIds = new Set([...markdownIds(expected)].filter(([id, path]) => {
      const moved = nextIds.get(id);
      return moved !== undefined && moved !== path;
    }).map(([, path]) => path));
    const addedBytes = new Set(added.flatMap((path) => next[path].encoding ? [next[path].content] : []));
    missing = missing.filter((path) => !movedIds.has(path) && !(expected[path].encoding && addedBytes.has(expected[path].content)));
  }
  const hold = missing.length > FOLDER_DELETIONS_WITHOUT_ASKING
    || (missing.length >= 3 && missing.length > counted.length * FOLDER_DELETION_SHARE_WITHOUT_ASKING);
  return hold ? missing.sort() : [];
}

/** Thrown instead of applying a scan that would delete many documents until the user decides. */
export class FolderDeletionHeldError extends Error {
  constructor(readonly held: HeldFolderDeletion) {
    super(`${held.paths.length} files are missing from the folder “${held.folderName}”. Nothing was deleted; choose whether to put them back or delete them.`);
    this.name = "FolderDeletionHeldError";
  }
}

/** A few recognizable names for the prompt, such as "Trip notes, Budget and 12 more". */
export function describeHeldFiles(paths: string[], shown = 3) {
  const names = paths.slice(0, shown).map((path) => path.split("/").at(-1)!.replace(/\.md$/i, ""));
  const rest = paths.length - names.length;
  if (rest > 0) return `${names.join(", ")} and ${rest} more`;
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
}
