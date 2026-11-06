import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBridgeService, type BridgeServiceDeps } from "../packages/vault-sync/bridgeService";
import { BridgeVaultEngine } from "../client/src/lib/desktopVaultEngine";
import { createVaultTransport } from "../client/src/lib/vaultApi";
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
async function installBridge(pick: () => Promise<string | null>, vault?: BridgeServiceDeps["vault"]) {
  const dataDir = await tempFolder("margin-data-");
  const listeners = new Set<(change: BridgeFolderChange) => void>();
  const statusListeners = new Set<(status: unknown) => void>();
  const changedListeners = new Set<() => void>();
  const service = await createBridgeService({ dataDir, pickFolder: pick, watch: false, sendChange: (change) => listeners.forEach((listener) => listener(change)),
    vault: vault ? { ...vault, sendStatus: (status) => statusListeners.forEach((listener) => listener(status)), sendVaultChanged: () => changedListeners.forEach((listener) => listener()) } : undefined });
  const api: VaultBridgeApi = {
    protocolVersion: VAULT_BRIDGE_PROTOCOL_VERSION,
    // Like Electron's ipcRenderer.invoke: a rejection arrives as a plain Error naming the original.
    request: (name, ...args) => service.handle(name, ...args).catch((error: Error) => { throw new Error(`Error invoking remote method 'margin-vault': ${error.name}: ${error.message}`); }),
    onFolderChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onSyncStatus(listener) { statusListeners.add(listener as (status: unknown) => void); return () => statusListeners.delete(listener as (status: unknown) => void); },
    onVaultChanged(listener) { changedListeners.add(listener); return () => changedListeners.delete(listener); },
  };
  (globalThis as Record<string, unknown>).window = globalThis;
  (globalThis as Record<string, unknown>)[VAULT_BRIDGE_GLOBAL] = api;
  return { service, api, deliver: (change: BridgeFolderChange) => listeners.forEach((listener) => listener(change)), deliverVaultChanged: () => changedListeners.forEach((listener) => listener()) };
}

describe("the client takes the native vault path only when the shell offers a matching bridge", () => {
  test("detection needs the global, the protocol version and both functions", () => {
    expect(vaultBridge(undefined)).toBeNull();
    expect(vaultBridge({})).toBeNull();
    const api = { protocolVersion: VAULT_BRIDGE_PROTOCOL_VERSION, request: async () => undefined, onFolderChanged: () => () => undefined, onSyncStatus: () => () => undefined, onVaultChanged: () => () => undefined };
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
    const { deliverVaultChanged } = await installBridge(async () => picks.shift() ?? null);
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

    // The main process watches the folder and reads it into the vault; the page is told when the vault changed.
    let changes = 0;
    const stop = watchLocalDirectory("jon", status.directoryId!, () => { changes += 1; });
    deliverVaultChanged();
    expect(changes).toBe(1);
    stop();
    deliverVaultChanged();
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

  test("the page's vault engine is a proxy to the main process: edits land in the folder, sync is one request, errors keep their names", async () => {
    const vault = await tempFolder("margin-vault-");
    await writeFile(path.join(vault, "Note.md"), "---\nmargin-chat-id: note-1\n---\n# Note\n");
    const picks: Array<string | null> = [vault];
    const statuses: string[] = [];
    const { api, service } = await installBridge(async () => picks.shift() ?? null, { journalRoot: path.join(await tempFolder("margin-journals-"), "vaults"), transportFor: () => null, intervalMs: 60_000 });
    const stop = api.onSyncStatus((status) => statuses.push(status.state));
    let changed = 0;
    api.onVaultChanged(() => { changed += 1; });
    const handle = (await pickLocalDirectory())!;
    await connectLocalDirectory("jon", handle);

    const engine = new BridgeVaultEngine(api, createVaultTransport("jon"));
    const opened = await api.request("openVault", { userId: "jon", cloudSync: false });
    expect(opened.folder?.name).toBe(path.basename(vault));
    await engine.sync();
    const snapshot = await engine.read();
    expect(snapshot.files["Note.md"].content).toContain("# Note");
    expect(changed).toBeGreaterThan(0);

    const edited = { content: snapshot.files["Note.md"].content.replace("# Note", "# Note, edited in the app") };
    const after = await engine.edit({ "Note.md": edited }, { "Note.md": snapshot.files["Note.md"] });
    expect(after.files["Note.md"].content).toContain("edited in the app");
    await engine.sync();
    expect(await readFile(path.join(vault, "Note.md"), "utf8")).toContain("edited in the app");
    expect(statuses).toContain("local");

    // Sets and Maps cross as themselves; an unknown operation is refused by name.
    expect(await engine.hydrate(new Set(["Note.md"]))).toMatchObject({ files: expect.any(Object) });
    const refused = await (engine as unknown as { call: (operation: string) => Promise<unknown> }).call("sync").catch((error) => error);
    expect(refused).toBeInstanceOf(DOMException);
    expect(refused.name).toBe("NotAllowedError");
    stop();
    await service.close();
  });
});
