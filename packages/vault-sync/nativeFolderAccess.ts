/**
 * The folder mirror's view of a folder the main process owns. The same folder
 * code the browser runs on its handles (`client/src/lib/workspaceStorage.ts`)
 * runs here on the native adapter; this only binds it to one folder and one
 * account, and answers the status questions the browser answers from its
 * permission and handle store.
 */
import { scanWhileFolderSettles } from "../../client/src/lib/fileSnapshot";
import type { FolderAccess } from "../../client/src/lib/vaultFolderMirror";
import {
  getLocalWorkspaceFileName, listConnectedDirectoryFiles, readConnectedDirectoryCompanions, readDirectoryWorkspace, writeConnectedDirectory,
  type LocalDirectoryStatus,
} from "../../client/src/lib/workspaceStorage";
import { asFileSystemDirectoryHandle, nodeFolderAvailability } from "./nodeVaultFs";
import type { NativeVaultDirectory } from "./vaultFs";

export interface NativeFolder {
  id: string;
  name: string;
  directory: NativeVaultDirectory;
}

export function createNativeFolderAccess(userId: string, folder: NativeFolder | null): FolderAccess {
  const fileName = getLocalWorkspaceFileName(userId);
  const handle = folder ? asFileSystemDirectoryHandle(folder.directory) : null;
  const status = (): LocalDirectoryStatus => folder
    ? { directoryId: folder.id, directoryName: folder.name, fileName, permission: "granted", supported: true }
    : { directoryName: null, fileName, permission: "unselected", supported: true };
  const check = (directoryId: string) => {
    if (!folder || !handle || directoryId !== folder.id) throw new Error("The connected folder changed. Read the selected folder before saving.");
    return handle;
  };
  return {
    async status() { return status(); },
    async directories() { return folder ? [{ id: folder.id, name: folder.name, current: true }] : []; },
    async availability(directoryId) {
      if (!folder || directoryId !== folder.id) return "missing";
      return nodeFolderAvailability(folder.directory.path);
    },
    async readWorkspace(fallbackManifest, previousFiles, directoryId, stats) {
      const target = check(directoryId);
      return scanWhileFolderSettles(folder!.name, () => readDirectoryWorkspace(target, userId, fallbackManifest, previousFiles, previousFiles ? stats : undefined));
    },
    async listFiles(directoryId) {
      const target = check(directoryId);
      return scanWhileFolderSettles(folder!.name, () => listConnectedDirectoryFiles(target));
    },
    async readCompanions(known, directoryId, listing, stats) {
      const target = check(directoryId);
      return scanWhileFolderSettles(folder!.name, () => readConnectedDirectoryCompanions(target, known, listing, stats));
    },
    async write(write, directoryId) {
      const target = check(directoryId);
      const written = await writeConnectedDirectory(target, userId, write);
      return { status: status(), ...written };
    },
  };
}
