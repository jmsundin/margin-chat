import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBridgeService, FOLDER_SETTINGS_FILE, type BridgeServiceDeps } from "../packages/vault-sync/bridgeService";
import { bridgeDirectory, bridgeRequest } from "../packages/vault-sync/bridgeDirectory";
import { isValidBridgePath, VAULT_BRIDGE_PROTOCOL_VERSION, type BridgeFolderChange, type VaultBridgeApi } from "../packages/vault-sync/bridgeProtocol";
import { asFileSystemDirectoryHandle } from "../packages/vault-sync/node";
import { readVaultText, writeVaultFile } from "../packages/vault-sync/vaultFs";
import { listConnectedDirectoryFiles, readDirectoryWorkspace, writeConnectedDirectoryWorkspace } from "../client/src/lib/workspaceStorage";
import { createVaultFolder, previewLocalDirectory } from "../client/src/lib/desktopVault";
import { createMarkdownWorkspace, parseMarkdownWorkspace } from "../client/src/lib/workspaceMarkdown";

const folders: string[] = [];
async function tempFolder(prefix = "margin-bridge-") {
  const folder = await mkdtemp(path.join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
}
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The service in the "main process", and the api a preload script would expose, joined without IPC. */
async function bridge(overrides: Partial<BridgeServiceDeps> = {}) {
  const dataDir = await tempFolder("margin-data-");
  const picks: Array<string | null> = [];
  const changes: BridgeFolderChange[] = [];
  const shown: string[] = [];
  const service = await createBridgeService({
    dataDir, pickFolder: async () => picks.shift() ?? null, showInFolder: (p, kind) => shown.push(`${kind}:${p}`),
    sendChange: (change) => changes.push(change), watch: false, ...overrides,
  });
  const listeners = new Set<(change: BridgeFolderChange) => void>();
  const api: VaultBridgeApi = {
    protocolVersion: VAULT_BRIDGE_PROTOCOL_VERSION,
    // Like Electron's ipcRenderer.invoke, a thrown error arrives as a plain Error with the name in its message.
    request: (name, ...args) => service.handle(name, ...args).catch((error: Error) => { throw new Error(`Error invoking remote method 'margin-vault': ${error.name}: ${error.message}`); }),
    onFolderChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onSyncStatus() { return () => undefined; },
    onVaultChanged() { return () => undefined; },
  };
  return { service, api, picks, changes, shown, dataDir, deliver: (change: BridgeFolderChange) => listeners.forEach((listener) => listener(change)) };
}

describe("vault bridge", () => {
  test("paths inside a folder are checked before anything is touched", () => {
    for (const ok of ["", "Note.md", "Projects/Plan.md", ".margin-chat/trash/k/deleted.json"]) expect(isValidBridgePath(ok)).toBe(true);
    for (const bad of ["/abs", "a/", "../x", "a/../b", "a//b", "a\\b", ".", "a/.", "x\u0000"]) expect(isValidBridgePath(bad)).toBe(false);
  });

  test("picking, connecting, remembering and reconnecting folders, with settings that survive a restart", async () => {
    const vault = await tempFolder();
    const { service, api, picks, dataDir } = await bridge();
    expect(await service.handle("status")).toEqual({ protocolVersion: VAULT_BRIDGE_PROTOCOL_VERSION, current: null, folders: [] });
    picks.push(null);
    expect(await service.handle("pickFolder")).toBeNull();
    picks.push(vault);
    const picked = (await service.handle("pickFolder"))!;
    expect(picked.name).toBe(path.basename(vault));
    // Picked but not connected: usable for a look, not remembered.
    expect((await service.handle("status")).folders).toEqual([]);
    expect(await service.handle("list", { folderId: picked.id, path: "" })).toEqual([]);
    const connected = await service.handle("connect", { folderId: picked.id, path: "" });
    expect(connected.current?.id).toBe(picked.id);
    expect(connected.folders.map((folder) => folder.id)).toEqual([picked.id]);
    const saved = JSON.parse(await readFile(path.join(dataDir, FOLDER_SETTINGS_FILE), "utf8"));
    expect(saved.current).toBe(picked.id);
    expect(saved.folders[0].fileId).toMatch(/^\d+:\d+$/u);

    // Another process starting from the same data folder sees the same connection, with no click.
    const again = await createBridgeService({ dataDir, pickFolder: async () => null, watch: false });
    expect((await again.handle("status")).current?.id).toBe(picked.id);
    expect(await again.handle("availability", picked.id)).toBe("available");
    await again.handle("disconnect");
    expect((await again.handle("status")).current).toBeNull();
    expect((await again.handle("status")).folders).toHaveLength(1);
    expect(await again.handle("reconnect", picked.id)).toMatchObject({ id: picked.id });
    expect(await again.handle("reconnect", "nope")).toBeNull();
    // A folder moved on the same volume and chosen again keeps its id, so its baselines follow it.
    const moved = path.join(await tempFolder(), "Moved vault");
    await rename(vault, moved);
    expect(await again.handle("availability", picked.id)).toBe("missing");
    const movedPick = await createBridgeService({ dataDir, pickFolder: async () => moved, watch: false });
    const repicked = (await movedPick.handle("pickFolder"))!;
    const reconnected = await movedPick.handle("connect", { folderId: repicked.id, path: "" });
    expect(reconnected.current).toEqual({ id: picked.id, name: "Moved vault", path: moved });
    expect(reconnected.folders).toHaveLength(1);
    await mkdir(vault); // for cleanup
    void api;
  });

  test("the renderer's handles run the folder code against the real folder through the bridge", async () => {
    const vault = await tempFolder();
    await writeFile(path.join(vault, "Plain note.md"), "# Plain note\n");
    await mkdir(path.join(vault, "Papers"));
    await writeFile(path.join(vault, "Papers", "paper.pdf"), "%PDF");
    const { service, api, picks } = await bridge();
    picks.push(vault);
    const picked = (await service.handle("pickFolder"))!;
    const handle = bridgeDirectory(api, picked);
    const dom = asFileSystemDirectoryHandle(handle);

    expect(await previewLocalDirectory(dom)).toMatchObject({ markdownFiles: 1, otherFiles: 1 });
    const read = await readDirectoryWorkspace(dom, "jon");
    expect(Object.keys(read.workspace.files)).toEqual(["Plain note.md"]);
    expect((await listConnectedDirectoryFiles(dom)).map((file) => file.path)).toEqual(["Papers/paper.pdf"]);
    const state = parseMarkdownWorkspace(read.workspace.manifest, read.workspace.files)!;
    await writeConnectedDirectoryWorkspace(dom, "jon", createMarkdownWorkspace(state, new Date().toISOString(), read.workspace), read.workspace);
    expect(await readFile(path.join(vault, "margin-chat-workspace-jon.json"), "utf8")).toContain("formatVersion");

    // Snapshots refuse to read a file that changed since, like the other adapters.
    const note = await handle.getFileHandle("Plain note.md");
    const snapshot = await note.getFile();
    await writeFile(path.join(vault, "Plain note.md"), "# Plain note, edited elsewhere\n");
    await expect(snapshot.text()).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(await (await note.getFile()).text()).toBe("# Plain note, edited elsewhere\n");

    await writeVaultFile(handle, "Deep/er/Note.md", "deep");
    expect(await readFile(path.join(vault, "Deep", "er", "Note.md"), "utf8")).toBe("deep");
    expect(await readVaultText(handle, "Deep/er/Note.md")).toBe("deep");
    expect(await readVaultText(handle, "Deep/er/Missing.md")).toBeNull();
    await expect(handle.getFileHandle("Papers")).rejects.toMatchObject({ name: "TypeMismatchError" });
    await expect(handle.getDirectoryHandle("Nope")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(handle.getFileHandle("../escape")).rejects.toMatchObject({ name: "TypeMismatchError" });
    await (await handle.getDirectoryHandle("Deep")).removeEntry("er", { recursive: true });
    await expect(handle.getDirectoryHandle("Deep").then((deep) => deep.getDirectoryHandle("er"))).rejects.toMatchObject({ name: "NotFoundError" });

    // A new vault folder is created inside a picked parent and can be connected by its handle.
    const created = await createVaultFolder(dom, "My vault");
    const connected = await service.handle("connect", (created as unknown as { ref: { folderId: string; path: string } }).ref);
    expect(connected.current).toEqual({ id: expect.any(String), name: "My vault", path: path.join(vault, "My vault") });
    await expect(createVaultFolder(dom, "Papers")).rejects.toThrow("already a folder");
    expect(await handle.isSameEntry!(bridgeDirectory(api, picked))).toBe(true);
  });

  test("requests for unknown folders, bad paths and non-bytes are refused, and showFolder resolves the real path", async () => {
    const vault = await tempFolder();
    const { service, picks, shown } = await bridge();
    picks.push(vault);
    const picked = (await service.handle("pickFolder"))!;
    await expect(service.handle("list", { folderId: "unknown", path: "" })).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(service.handle("read", { folderId: picked.id, path: "../etc/passwd" }, null)).rejects.toMatchObject({ name: "TypeMismatchError" });
    await expect(service.handle("write", { folderId: picked.id, path: "" }, new Uint8Array())).rejects.toMatchObject({ name: "TypeMismatchError" });
    await expect(service.handle("write", { folderId: picked.id, path: "x.md" }, "text" as unknown as Uint8Array)).rejects.toMatchObject({ name: "TypeMismatchError" });
    await expect(service.handle("list", { folderId: picked.id } as never)).rejects.toMatchObject({ name: "TypeMismatchError" });
    await expect(service.handle("nope" as never)).rejects.toMatchObject({ name: "NotAllowedError" });
    await mkdir(path.join(vault, "Sub"));
    await writeFile(path.join(vault, "Sub", "Note.md"), "note");
    await service.handle("showFolder", { folderId: picked.id, path: "Sub" });
    await service.handle("showFolder", { folderId: picked.id, path: "Sub/Note.md" });
    await service.handle("showFolder", { folderId: picked.id, path: "" });
    expect(shown).toEqual([`directory:${path.join(vault, "Sub")}`, `file:${path.join(vault, "Sub", "Note.md")}`, `directory:${vault}`]);
    // The renderer turns a bridge failure back into a DOMException by name.
    const error = await bridgeRequest(() => Promise.reject(new Error("Error invoking remote method 'margin-vault': NotFoundError: gone"))).catch((e) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect(error.name).toBe("NotFoundError");
    expect(error.message).toBe("gone");
  });

  test("the connected folder is watched by the main process and changes reach the renderer", async () => {
    const vault = await tempFolder();
    const { service, picks, changes } = await bridge({ watch: true });
    picks.push(vault);
    const picked = (await service.handle("pickFolder"))!;
    await service.handle("connect", { folderId: picked.id, path: "" });
    await sleep(100);
    await writeFile(path.join(vault, "Dropped.md"), "dropped");
    // The app's own write is not reported back.
    await service.handle("write", { folderId: picked.id, path: "Pulled.md" }, new TextEncoder().encode("pulled"));
    await sleep(1_400);
    expect(changes.flatMap((change) => change.changes.map((item) => item.path))).toEqual(["Dropped.md"]);
    expect(changes[0].folderId).toBe(picked.id);
    await service.close();
  });

  test("the vault runs in the main process once opened: engine operations, sync status, pausing, and following the connected folder", async () => {
    const vault = await tempFolder();
    await writeFile(path.join(vault, "Existing.md"), "# Existing\n");
    const statuses: unknown[] = [];
    let vaultChanges = 0;
    const { service, picks } = await bridge({ watch: false, vault: {
      journalRoot: path.join(await tempFolder("margin-journals-"), "vaults"), transportFor: () => null,
      sendStatus: (status) => statuses.push(status.state), sendVaultChanged: () => { vaultChanges += 1; }, intervalMs: 60_000,
    } });
    await expect(service.handle("vault", "read")).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(await service.handle("syncStatus")).toBeNull();
    // Before a folder is connected the vault runs from its journal alone.
    const opened = await service.handle("openVault", { userId: "jon", cloudSync: false });
    expect(opened).toMatchObject({ state: "local", folder: null, cloud: false });
    await expect(service.handle("openVault", { userId: "", cloudSync: false } as never)).rejects.toMatchObject({ name: "TypeMismatchError" });
    await expect(service.handle("vault", "sync")).rejects.toMatchObject({ name: "NotAllowedError" });

    picks.push(vault);
    const picked = (await service.handle("pickFolder"))!;
    await service.handle("connect", { folderId: picked.id, path: "" });
    // Connecting restarted the vault on the folder; its files are read in.
    const status = await service.handle("syncNow");
    expect(status.folder).toMatchObject({ id: picked.id, path: vault });
    const snapshot = await service.handle("vault", "read") as { files: Record<string, { content: string }> };
    expect(snapshot.files["Existing.md"].content).toContain("# Existing");
    expect(vaultChanges).toBeGreaterThan(0);

    // An edit through the engine lands in the folder after the next pass.
    await service.handle("vault", "edit", { "Existing.md": { content: snapshot.files["Existing.md"].content.replace("# Existing", "# Existing, edited in the app") } }, { "Existing.md": snapshot.files["Existing.md"] });
    await service.handle("syncNow");
    expect(await readFile(path.join(vault, "Existing.md"), "utf8")).toContain("edited in the app");

    expect((await service.handle("pauseSync", true)).state).toBe("paused");
    expect((await service.handle("pauseSync", false)).state).toBe("local");
    expect(await service.handle("unsupportedFiles")).toEqual([]);
    await expect(service.handle("resolveHeldDeletion", "maybe" as never)).rejects.toMatchObject({ name: "TypeMismatchError" });
    // Opening the same account again is a no-op; disconnecting the folder restarts the vault without one.
    expect((await service.handle("openVault", { userId: "jon", cloudSync: false })).folder?.id).toBe(picked.id);
    await service.handle("disconnect");
    expect((await service.handle("syncStatus"))?.folder).toBeNull();
    expect(statuses).toContain("local");
    await service.close();
  });
});
