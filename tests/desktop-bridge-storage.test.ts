import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBridgeService } from "../packages/vault-sync/bridgeService";
import { VAULT_BRIDGE_GLOBAL, VAULT_BRIDGE_PROTOCOL_VERSION, type BridgeFolderChange, type VaultBridgeApi } from "../packages/vault-sync/bridgeProtocol";
import { hasVaultBridge, vaultBridge } from "../client/src/lib/desktopBridge";
import {
  clearLocalDirectory, connectLocalDirectory, getLocalDirectoryStatus, listLocalDirectories, localDirectoryAvailability, pickLocalDirectory,
  readLocalDirectoryFile, readLocalDirectoryWorkspace, reconnectLocalDirectory, requestLocalDirectoryPermission, watchLocalDirectory,
} from "../client/src/lib/workspaceStorage";

const folders: string[] = [];
async function tempFolder(prefix: string) {
  const folder = await mkdtemp(path.join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
}
afterEach(async () => {
  delete (globalThis as Record<string, unknown>)[VAULT_BRIDGE_GLOBAL];
  delete (globalThis as Record<string, unknown>).window;
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

/** Installs a bridge on a fake window, as the desktop preload script does. */
async function installBridge(pick: () => Promise<string | null>) {
  const dataDir = await tempFolder("margin-data-");
  const listeners = new Set<(change: BridgeFolderChange) => void>();
  const service = await createBridgeService({ dataDir, pickFolder: pick, watch: false, sendChange: (change) => listeners.forEach((listener) => listener(change)) });
  const api: VaultBridgeApi = {
    protocolVersion: VAULT_BRIDGE_PROTOCOL_VERSION,
    request: (name, ...args) => service.handle(name, ...args),
    onFolderChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  (globalThis as Record<string, unknown>).window = globalThis;
  (globalThis as Record<string, unknown>)[VAULT_BRIDGE_GLOBAL] = api;
  return { service, api, deliver: (change: BridgeFolderChange) => listeners.forEach((listener) => listener(change)) };
}

describe("the client takes the native vault path only when the shell offers a matching bridge", () => {
  test("detection needs the global, the protocol version and both functions", () => {
    expect(vaultBridge(undefined)).toBeNull();
    expect(vaultBridge({})).toBeNull();
    const api = { protocolVersion: VAULT_BRIDGE_PROTOCOL_VERSION, request: async () => undefined, onFolderChanged: () => () => undefined };
    expect(vaultBridge({ [VAULT_BRIDGE_GLOBAL]: api })).toBe(api as unknown as VaultBridgeApi);
    expect(vaultBridge({ [VAULT_BRIDGE_GLOBAL]: { ...api, protocolVersion: VAULT_BRIDGE_PROTOCOL_VERSION + 1 } })).toBeNull();
    expect(vaultBridge({ [VAULT_BRIDGE_GLOBAL]: { ...api, request: undefined } })).toBeNull();
    expect(hasVaultBridge()).toBe(false);
  });

  test("folder status, picking, connecting, remembered folders, watching and disconnecting go through the bridge", async () => {
    const vault = await tempFolder("margin-vault-");
    await writeFile(path.join(vault, "Note.md"), "# Note\n");
    await writeFile(path.join(vault, "paper.pdf"), "%PDF");
    const picks: Array<string | null> = [vault];
    const { deliver } = await installBridge(async () => picks.shift() ?? null);
    expect(hasVaultBridge()).toBe(true);

    // Before any folder: supported, nothing selected, and no "allow" step can ever appear.
    expect(await getLocalDirectoryStatus("jon")).toMatchObject({ directoryName: null, permission: "unselected", supported: true });
    expect(await listLocalDirectories("jon")).toEqual([]);

    const handle = (await pickLocalDirectory())!;
    expect(handle.name).toBe(path.basename(vault));
    const status = await connectLocalDirectory("jon", handle);
    expect(status).toMatchObject({ directoryName: path.basename(vault), permission: "granted", supported: true });
    expect(status.directoryId).toBeTruthy();
    // Another account on this computer sees the same connected folder: one app, one vault.
    expect(await getLocalDirectoryStatus("ada")).toMatchObject({ directoryName: path.basename(vault), permission: "granted", directoryId: status.directoryId });
    expect(await listLocalDirectories("jon")).toEqual([{ id: status.directoryId, name: path.basename(vault), current: true }]);
    expect(await requestLocalDirectoryPermission("jon")).toMatchObject({ permission: "granted" });
    expect(await localDirectoryAvailability("jon", status.directoryId)).toBe("available");

    const read = await readLocalDirectoryWorkspace("jon", undefined, undefined, status.directoryId);
    expect(Object.keys(read!.workspace.files)).toEqual(["Note.md"]);
    const pdf = await readLocalDirectoryFile("jon", "paper.pdf", status.directoryId);
    expect(pdf?.type).toBe("application/pdf");
    expect(await pdf!.text()).toBe("%PDF");

    // The main process's watcher drives scans; only the connected folder's changes count.
    let changes = 0;
    const stop = watchLocalDirectory("jon", status.directoryId!, () => { changes += 1; });
    deliver({ folderId: "another", changes: [{ path: "x.md", kind: "changed" }] });
    deliver({ folderId: status.directoryId!, changes: [{ path: "Note.md", kind: "changed" }] });
    expect(changes).toBe(1);
    stop();
    deliver({ folderId: status.directoryId!, changes: [{ path: "Note.md", kind: "changed" }] });
    expect(changes).toBe(1);

    await clearLocalDirectory("jon");
    expect(await getLocalDirectoryStatus("jon")).toMatchObject({ directoryName: null, permission: "unselected" });
    // Remembered folders are listed from the main process and reopen with no permission step.
    const again = await reconnectLocalDirectory("jon", status.directoryId!);
    expect(again?.name).toBe(path.basename(vault));
    expect(await reconnectLocalDirectory("jon", "unknown")).toBeNull();
    await connectLocalDirectory("jon", again!);
    expect((await getLocalDirectoryStatus("jon")).directoryId).toBe(status.directoryId);

    // The folder going away is "missing", never an empty folder.
    await rm(vault, { recursive: true, force: true });
    expect(await localDirectoryAvailability("jon", status.directoryId)).toBe("missing");
  });
});
