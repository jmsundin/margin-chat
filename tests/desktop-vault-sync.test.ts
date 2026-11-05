import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDesktopVaultSync, type DesktopVaultSync } from "../desktop/sync/vaultSyncDaemon";
import { nodeDirectoryHandle } from "../desktop/sync/nodeDirectoryHandle";
import { nodeVaultFs } from "../desktop/vaultFs.mjs";
import { createVaultFolders } from "../desktop/vaultFolders.mjs";
import { createVaultSyncManager, VAULT_SYNC_CHANNEL } from "../desktop/vaultSync.mjs";
import { registerVaultBridge, VAULT_CHANNEL, VAULT_OPERATIONS } from "../desktop/vaultBridge.mjs";
import { createJournalVaultStore } from "../client/src/lib/vaultLocal";
import { VaultSync } from "../client/src/lib/vaultSync";
import { emptyVault, type VaultFile, type VaultManifest, type VaultSnapshot, type VaultStore, type VaultTransport } from "../client/src/lib/vaultTypes";
import { desktopSyncDetail, desktopSyncLabel } from "../client/src/lib/desktopSyncLabel";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";

function memoryStore(): VaultStore {
  let snapshot: VaultSnapshot | null = null;
  let tail = Promise.resolve();
  return {
    async read() { return structuredClone(snapshot); },
    async write(value) { snapshot = structuredClone(value); },
    lock<T>(operation: () => Promise<T>): Promise<T> {
      const current = tail.then(operation);
      tail = current.then(() => undefined, () => undefined);
      return current;
    },
  };
}

/** The real cloud vault service over memory, with the transport the page uses (as in vault-sync.test.ts). */
function cloud() {
  const objects = new Map<string, Buffer>();
  const server = createVaultService({ storage: {
    kind: "memory",
    async read(key: string) { const bytes = objects.get(key); return bytes ? { bytes, etag: digest(bytes) } : null; },
    async putImmutable(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      if ((objects.has(key) ? digest(objects.get(key)!) : null) !== expected) return false;
      objects.set(key, Buffer.from(bytes)); return true;
    },
  } });
  const normalize = (manifest: any): VaultManifest => ({ ...manifest, files: Object.fromEntries(Object.entries(manifest.files)
    .map(([file, entry]: [string, any]) => [file, { ...entry, encoding: entry.encoding === "base64" ? "base64" : undefined }])) });
  const transport: VaultTransport = {
    async manifest() { return normalize((await server.status("user")).manifest); },
    async read(file, entry) {
      const { bytes } = await server.readFile({ userId: "user", path: file, revision: entry.revision });
      return { content: bytes.toString(entry.encoding === "base64" ? "base64" : "utf8"), ...(entry.encoding ? { encoding: entry.encoding } : {}), contentType: entry.contentType };
    },
    async commit(changes) {
      const { manifest, previousRevision } = await server.commit("user", changes);
      return { ...normalize(manifest), previousRevision };
    },
  };
  return { server, transport };
}

/** A phone (or any other device) on the same cloud vault. */
function otherDevice(transport: VaultTransport) {
  return new VaultSync(memoryStore(), transport);
}

async function edit(device: VaultSync, files: Record<string, VaultFile | null>) {
  const previous = (await device.read()).files;
  const next = { ...previous };
  for (const [file, value] of Object.entries(files)) { if (value === null) delete next[file]; else next[file] = value; }
  await device.edit(next, previous);
  return device.sync();
}

const NEVER = { set: () => 0, clear: () => undefined };

async function desktop(options: { transport: VaultTransport; home?: string; offline?: () => boolean } ) {
  const home = options.home ?? await mkdtemp(path.join(tmpdir(), "margin-desktop-sync-"));
  const root = path.join(home, "Vault");
  await mkdir(root, { recursive: true });
  let commits = 0;
  const transport: VaultTransport = {
    async manifest() { if (options.offline?.()) throw new TypeError("fetch failed"); return options.transport.manifest(); },
    async read(file, entry) { if (options.offline?.()) throw new TypeError("fetch failed"); return options.transport.read(file, entry); },
    async commit(changes) {
      if (options.offline?.()) throw new TypeError("fetch failed");
      commits += 1;
      return options.transport.commit(changes);
    },
  };
  const written: Array<string[] | null> = [];
  const statuses: string[] = [];
  const make = () => createDesktopVaultSync({
    userId: "user",
    folder: { id: "folder-1", name: "Vault", fs: nodeVaultFs(root, { stableReadMs: 10 }) },
    stateDirectory: path.join(home, "state"),
    fetch: (() => { throw new Error("The test transport is used instead."); }) as never,
    serverUrl: "https://margin.test",
    transport,
    timers: NEVER,
    onStatus: (status) => statuses.push(status.state),
    onFolderWritten: (paths) => written.push(paths),
  });
  const sync = make();
  return { home, root, sync, make, written, statuses, commits: () => commits };
}

const file = (content: string): VaultFile => ({ content });
const folderFile = (root: string, relative: string) => readFile(path.join(root, ...relative.split("/")), "utf8");
const exists = (root: string, relative: string) => readFile(path.join(root, ...relative.split("/"))).then(() => true, () => false);

describe("the desktop app's device copy", () => {
  test("is the browser's journal, kept in the app's data folder", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "margin-device-copy-"));
    let tail = Promise.resolve();
    const make = () => createJournalVaultStore({
      open: async () => nodeDirectoryHandle(home),
      lock<T>(operation: () => Promise<T>) { const result = tail.then(operation); tail = result.then(() => undefined, () => undefined); return result; },
    });
    const first = make();
    const snapshot = { ...emptyVault(), files: { "Note.md": file("# Note\n"), "Paper.pdf": { content: "JVBERi0=", encoding: "base64" as const } }, remoteRevision: 3 };
    await first.write(snapshot);
    for (let index = 0; index < 5; index += 1) {
      const current = (await first.read())!;
      await first.write({ ...current, files: { ...current.files, [`Note ${index}.md`]: file(`# ${index}\n`) } });
    }
    // Read back by a new store, as on the next launch.
    const reopened = (await make().read())!;
    expect(Object.keys(reopened.files).sort()).toEqual(["Note 0.md", "Note 1.md", "Note 2.md", "Note 3.md", "Note 4.md", "Note.md", "Paper.pdf"]);
    expect(reopened.files["Paper.pdf"]).toEqual({ content: "JVBERi0=", encoding: "base64" });
    expect(reopened.remoteRevision).toBe(3);
    expect((await readdir(home)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});

describe("desktop sync of the vault folder", () => {
  test("files dropped into the folder reach another device; files it doesn't sync stay as they are", async () => {
    const remote = cloud();
    const phone = otherDevice(remote.transport);
    await edit(phone, { "Known.md": file("---\nmargin-chat-id: known-note\n---\n# Known\n\nWritten on the phone.\n") });
    const app = await desktop({ transport: remote.transport });
    await app.sync.syncNow();
    expect(await folderFile(app.root, "Known.md")).toContain("Written on the phone.");

    await writeFile(path.join(app.root, "Plain.md"), "# Plain\n\nDropped in from Finder.\n");
    await writeFile(path.join(app.root, "Known.md"), (await folderFile(app.root, "Known.md")).replace("Written on the phone.", "Written on the phone.\n\nEdited in another app."));
    await writeFile(path.join(app.root, "Paper.pdf"), Buffer.from("%PDF-1.4 dropped"));
    await writeFile(path.join(app.root, "Sheet.xlsx"), "not synced");
    await app.sync.syncNow();
    expect(app.sync.status()).toMatchObject({ state: "synced", pending: 0 });

    const onPhone = (await phone.sync()).files;
    expect(onPhone["Plain.md"].content).toContain("Dropped in from Finder.");
    expect(onPhone["Known.md"].content).toContain("Edited in another app.");
    expect(onPhone["Known.md"].content).toContain("margin-chat-id: known-note");
    expect(Buffer.from(onPhone["Paper.pdf"].content, "base64").toString()).toBe("%PDF-1.4 dropped");
    expect(onPhone["Sheet.xlsx"]).toBeUndefined();
    expect(await folderFile(app.root, "Sheet.xlsx")).toBe("not synced");
    // One document per identity: nothing was duplicated.
    expect(Object.keys(onPhone).filter((name) => name.endsWith(".md") && !name.startsWith(".margin-chat/")).sort()).toEqual(["Known.md", "Plain.md"]);
  });

  test("a cloud change pulled into the folder uploads nothing; a save in the app uploads once", async () => {
    const remote = cloud();
    const phone = otherDevice(remote.transport);
    await edit(phone, { "Trip.md": file("# Trip\n\nPack light.\n") });
    const app = await desktop({ transport: remote.transport });
    await app.sync.syncNow();
    const before = app.commits();

    await edit(phone, { "Trip.md": file("# Trip\n\nPack light.\n\nBring a jacket.\n") });
    await app.sync.syncNow();
    expect(await folderFile(app.root, "Trip.md")).toContain("Bring a jacket.");
    // The page is told which files changed, so it reads them.
    expect(app.written.at(-1)).toEqual(["Trip.md"]);
    await app.sync.syncNow();
    expect(app.commits()).toBe(before);

    // The page saves an edit into the folder.
    await writeFile(path.join(app.root, "Trip.md"), `${await folderFile(app.root, "Trip.md")}\nTickets are booked.\n`);
    await app.sync.syncNow();
    await app.sync.syncNow();
    expect(app.commits()).toBe(before + 1);
    expect((await phone.sync()).files["Trip.md"].content).toContain("Tickets are booked.");
  });

  test("offline edits here and on the phone converge, in either order, with no conflict markers", async () => {
    for (const phoneFirst of [true, false]) {
      const remote = cloud();
      const phone = otherDevice(remote.transport);
      await edit(phone, { "A.md": file("# A\n\nFirst.\n"), "B.md": file("# B\n\nFirst.\n"), "Shared.md": file("# Shared\n\nOne.\n\nTwo.\n\nThree.\n") });
      let offline = false;
      const app = await desktop({ transport: remote.transport, offline: () => offline });
      await app.sync.syncNow();

      offline = true;
      await writeFile(path.join(app.root, "A.md"), (await folderFile(app.root, "A.md")).replace("First.", "Edited on the desktop."));
      await writeFile(path.join(app.root, "Shared.md"), (await folderFile(app.root, "Shared.md")).replace("One.", "One, from the desktop."));
      await app.sync.syncNow();
      expect(app.sync.status().state).toBe("offline");
      expect(app.sync.status().pending).toBeGreaterThan(0);

      const phoneEdit = async () => {
        const files = (await phone.sync()).files;
        await edit(phone, { "B.md": file(files["B.md"].content.replace("First.", "Edited on the phone.")),
          "Shared.md": file(files["Shared.md"].content.replace("Three.", "Three, from the phone.")) });
      };
      if (phoneFirst) await phoneEdit();
      offline = false;
      await app.sync.syncNow();
      if (!phoneFirst) { await phoneEdit(); await app.sync.syncNow(); }

      const onPhone = (await phone.sync()).files;
      for (const files of [onPhone, { "A.md": file(await folderFile(app.root, "A.md")), "B.md": file(await folderFile(app.root, "B.md")), "Shared.md": file(await folderFile(app.root, "Shared.md")) }]) {
        expect(files["A.md"].content).toContain("Edited on the desktop.");
        expect(files["B.md"].content).toContain("Edited on the phone.");
        expect(files["Shared.md"].content).toContain("One, from the desktop.");
        expect(files["Shared.md"].content).toContain("Three, from the phone.");
        for (const content of Object.values(files)) expect(content.content).not.toMatch(/^(?:<{7}|={7}|>{7})/mu);
      }
    }
  });

  test("an upload whose answer never arrived is not sent twice by the next launch", async () => {
    const remote = cloud();
    let loseAnswer = false;
    const flaky: VaultTransport = { ...remote.transport, async commit(changes) {
      const committed = await remote.transport.commit(changes);
      if (loseAnswer) { loseAnswer = false; throw new TypeError("fetch failed"); }
      return committed;
    } };
    const app = await desktop({ transport: flaky });
    await writeFile(path.join(app.root, "Draft.md"), "# Draft\n\nWritten before a crash.\n");
    loseAnswer = true;
    await app.sync.syncNow();
    expect(app.sync.status().state).toBe("offline");
    app.sync.stop();

    // The app quits and starts again with the same data folder.
    const again = app.make();
    await again.syncNow();
    expect(again.status()).toMatchObject({ state: "synced", pending: 0 });
    const onPhone = (await otherDevice(remote.transport).sync()).files;
    expect(Object.keys(onPhone).filter((name) => name.endsWith(".md") && !name.startsWith(".margin-chat/"))).toEqual(["Draft.md"]);
    expect(await folderFile(app.root, "Draft.md")).toContain("Written before a crash.");
  });

  test("many files disappearing at once are held until the person answers; a few go to the trash", async () => {
    const remote = cloud();
    const phone = otherDevice(remote.transport);
    const files = Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`Note ${index + 1}.md`, file(`# Note ${index + 1}\n`)]));
    await edit(phone, files);
    const app = await desktop({ transport: remote.transport });
    await app.sync.syncNow();
    const doomed = Array.from({ length: 11 }, (_, index) => `Note ${index + 1}.md`);
    for (const name of doomed) await rm(path.join(app.root, name));
    await app.sync.syncNow();
    expect(app.sync.status()).toMatchObject({ state: "attention", attention: { reason: "held", held: { paths: [...doomed].sort() } } });
    expect(Object.keys((await phone.sync()).files).filter((name) => /^Note/.test(name))).toHaveLength(14);

    await app.sync.resolveHeld("restore");
    expect(app.sync.status().state).toBe("synced");
    for (const name of doomed) expect(await exists(app.root, name)).toBe(true);

    for (const name of doomed) await rm(path.join(app.root, name));
    await app.sync.syncNow();
    await app.sync.resolveHeld("delete");
    expect(Object.keys((await phone.sync()).files).filter((name) => /^Note/.test(name))).toHaveLength(3);

    await rm(path.join(app.root, "Note 12.md"));
    await rm(path.join(app.root, "Note 13.md"));
    await app.sync.syncNow();
    expect(app.sync.status().state).toBe("synced");
    const onPhone = (await phone.sync()).files;
    expect(onPhone["Note 12.md"]).toBeUndefined();
    const trash = Object.keys(onPhone).filter((name) => name.startsWith(".margin-chat/trash/") && name.endsWith(".md"));
    expect(trash.some((name) => name.endsWith("Note 12.md"))).toBe(true);
    expect(await readdir(path.join(app.root, ".margin-chat", "trash")).then((entries) => entries.length)).toBeGreaterThan(0);
  });

  test("a folder that goes missing is never taken as empty, and syncs again once it is back", async () => {
    const remote = cloud();
    const phone = otherDevice(remote.transport);
    await edit(phone, { "Keep.md": file("# Keep\n") });
    const app = await desktop({ transport: remote.transport });
    await app.sync.syncNow();
    await rename(app.root, `${app.root}-moved`);
    await app.sync.syncNow();
    expect(app.sync.status()).toMatchObject({ state: "attention", attention: { reason: "missing" } });
    expect((await phone.sync()).files["Keep.md"]).toBeDefined();
    expect(await exists(app.root, "Keep.md")).toBe(false);
    await rename(`${app.root}-moved`, app.root);
    await app.sync.syncNow();
    expect(app.sync.status().state).toBe("synced");
    expect((await phone.sync()).files["Keep.md"]).toBeDefined();
  });

  test("paused sync sends nothing, counts what waits, and catches up when resumed", async () => {
    const remote = cloud();
    const app = await desktop({ transport: remote.transport });
    await app.sync.syncNow();
    await app.sync.setPaused(true);
    const before = app.commits();
    await writeFile(path.join(app.root, "Later.md"), "# Later\n");
    await app.sync.syncNow();
    expect(app.sync.status()).toMatchObject({ state: "paused", paused: true });
    expect(app.sync.status().pending).toBeGreaterThan(0);
    expect(app.commits()).toBe(before);
    // Paused stays paused across launches.
    const relaunched = app.make();
    await relaunched.syncNow();
    expect(relaunched.status().paused).toBe(true);
    await relaunched.setPaused(false);
    expect(relaunched.status()).toMatchObject({ state: "synced", pending: 0, paused: false });
    expect((await otherDevice(remote.transport).sync()).files["Later.md"]).toBeDefined();
  });

  test("a sign-in that expired stops sync and says so, without retrying on its own", async () => {
    const remote = cloud();
    const refused: VaultTransport = { ...remote.transport, async manifest() { throw Object.assign(new Error("Sign in."), { statusCode: 401 }); } };
    const app = await desktop({ transport: refused });
    await writeFile(path.join(app.root, "Note.md"), "# Note\n");
    await app.sync.syncNow();
    expect(app.sync.status()).toMatchObject({ state: "attention", attention: { reason: "signed-out" } });
    expect(await folderFile(app.root, "Note.md")).toBe("# Note\n");
  });

  test("the indicator's words", () => {
    const at = new Date(2026, 10, 5, 14, 7).getTime();
    expect(desktopSyncLabel({ state: "synced", lastSyncedAt: at }, "en-US")).toBe("Synced · 2:07 PM");
    expect(desktopSyncLabel({ state: "syncing", lastSyncedAt: at })).toBe("Syncing…");
    expect(desktopSyncLabel({ state: "offline", lastSyncedAt: null })).toBe("Offline — changes saved locally");
    expect(desktopSyncLabel({ state: "paused", lastSyncedAt: null })).toBe("Paused");
    expect(desktopSyncLabel({ state: "attention", lastSyncedAt: null })).toBe("Needs attention");
    expect(desktopSyncDetail({ folderId: "f", folderName: "Vault", folderPath: "/Vault", state: "synced", lastSyncedAt: null, pending: 2, paused: false }, "en-US"))
      .toBe("2 changes waiting to sync · Not synced yet");
  });
});

describe("the app's sync for the page", () => {
  async function setUp() {
    const remote = cloud();
    const home = await mkdtemp(path.join(tmpdir(), "margin-sync-manager-"));
    const vault = path.join(home, "Vault");
    await mkdir(vault);
    const answers = [vault];
    const folders = createVaultFolders({ statePath: path.join(home, "vault-folders.json"), async chooseFolder() { return answers.shift() ?? null; } });
    const folder = (await folders.choose())!;
    await folders.connect("user", folder.id);
    const sent: Array<{ channel: string; payload: any }> = [];
    const created: DesktopVaultSync[] = [];
    const opened: string[] = [];
    const manager = createVaultSyncManager({
      folders,
      loadEngine: async () => ({ createDesktopVaultSync: (options: Parameters<typeof createDesktopVaultSync>[0]) => {
        const sync = createDesktopVaultSync({ ...options, transport: remote.transport, timers: NEVER });
        created.push(sync);
        return sync;
      } }),
      stateRoot: path.join(home, "vault-sync"),
      fetch: (() => { throw new Error("unused"); }) as never,
      serverUrl: "https://margin.test",
      broadcast: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      openPath: async (folderPath: string) => { opened.push(folderPath); },
      watcherOptions: { debounceMs: 30, stabilityMs: 30, platform: "linux" },
    });
    return { remote, home, vault, folders, folder, manager, sent, created, opened };
  }

  test("starts only for the account's own folder, keeps running through a page reload, and stops when the folder is forgotten", async () => {
    const { manager, folder, folders, sent, created, opened, vault, remote } = await setUp();
    expect(await manager.status("user", folder.id)).toBeNull();
    await expect(manager.start("someone-else", folder.id)).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(manager.start("user", "not-a-folder")).rejects.toMatchObject({ name: "NotFoundError" });

    await writeFile(path.join(vault, "Note.md"), "# Note\n");
    await manager.start("user", folder.id);
    await manager.running!.idle();
    expect(sent.at(-1)).toMatchObject({ channel: VAULT_SYNC_CHANNEL, payload: { folderId: folder.id, state: "synced" } });
    expect((await otherDevice(remote.transport).sync()).files["Note.md"]).toBeDefined();

    // The page reloads and asks again: the same sync answers.
    expect(await manager.status("user", folder.id)).toMatchObject({ state: "synced" });
    await manager.start("user", folder.id);
    expect(created).toHaveLength(1);

    await manager.control("user", folder.id, "openFolder");
    expect(opened).toEqual([vault]);
    await expect(manager.control("user", folder.id, "launch")).rejects.toThrow();

    manager.stop("user");
    expect(manager.running).toBeNull();
    // Handed over before: the next launch starts it again straight away.
    expect(await manager.status("user", folder.id)).toEqual({ folderId: folder.id, state: "stopped" });
    await folders.forget("user");
    await expect(manager.start("user", folder.id)).rejects.toMatchObject({ name: "NotFoundError" });
    manager.closeAll();
  });

  test("the page's writes and other apps' changes both reach the cloud", async () => {
    const { manager, folder, vault, remote } = await setUp();
    await manager.start("user", folder.id);
    await manager.running!.idle();
    // Another app: heard by the watcher.
    await writeFile(path.join(vault, "Elsewhere.md"), "# Elsewhere\n");
    const phone = otherDevice(remote.transport);
    for (let tries = 0; tries < 100 && !(await phone.sync()).files["Elsewhere.md"]; tries += 1) {
      // The watcher hears it; the sync waits a moment for more before it runs (no timers in this test).
      await manager.running!.syncNow();
    }
    expect((await phone.sync()).files["Elsewhere.md"]).toBeDefined();
    manager.closeAll();
  });

  test("the bridge answers sync requests, tells the app about the page's writes, and stops sync when the folder is forgotten", async () => {
    const { manager, folder, folders, vault } = await setUp();
    const changed: string[] = [];
    const stopped: string[] = [];
    let handler: ((event: unknown, operation: string, args: unknown[]) => Promise<any>) | null = null;
    const fakeSync = {
      status: async () => ({ state: "synced" }), start: async () => ({ state: "syncing" }), control: async () => ({ state: "paused" }),
      folderChanged: (id: string) => changed.push(id), stop: (user: string) => stopped.push(user), connected: () => undefined,
    };
    registerVaultBridge({ ipcMain: { handle: (_channel: string, fn: typeof handler) => { handler = fn; } }, folders, isAppUrl: () => true, sync: fakeSync });
    const event = { senderFrame: { url: "margin://app/" }, sender: { id: 1 } };
    expect(await handler!(event, "syncStatus", ["user", folder.id])).toEqual({ ok: true, value: { state: "synced" } });
    expect(await handler!(event, "syncStart", ["user", folder.id])).toEqual({ ok: true, value: { state: "syncing" } });
    expect(await handler!(event, "syncControl", ["user", folder.id, "pause"])).toEqual({ ok: true, value: { state: "paused" } });
    await handler!(event, "writeAtomic", [folder.id, "Page.md", "# From the page\n"]);
    expect(changed).toEqual([folder.id]);
    expect(await readFile(path.join(vault, "Page.md"), "utf8")).toBe("# From the page\n");
    await handler!(event, "forget", ["user"]);
    expect(stopped).toEqual(["user"]);

    // An app built without its own sync: the page is told so, and keeps syncing itself.
    let older: typeof handler = null;
    registerVaultBridge({ ipcMain: { handle: (_channel: string, fn: typeof handler) => { older = fn; } }, folders, isAppUrl: () => true });
    expect(await older!(event, "syncStatus", ["user", folder.id])).toEqual({ ok: true, value: null });
    expect(await older!(event, "syncStart", ["user", folder.id])).toMatchObject({ ok: false, error: { name: "NotSupportedError" } });
    manager.closeAll();
  });

  test("the preload exposes the sync requests and status", async () => {
    const preload = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
    for (const operation of ["syncStatus", "syncStart", "syncControl"]) expect(VAULT_OPERATIONS).toContain(operation);
    expect(preload).toContain(`"${VAULT_SYNC_CHANNEL}"`);
    expect(preload).toContain("onSyncStatus(listener)");
    expect(VAULT_CHANNEL).toBe("margin-vault");
  });
});

describe("the bundled sync engine", () => {
  test("builds into one module that loads in Node", () => {
    const build = spawnSync(process.execPath, ["scripts/build-desktop-engine.mjs"], { cwd: path.join(import.meta.dir, ".."), encoding: "utf8" });
    expect(build.status).toBe(0);
    const node = spawnSync("node", ["--input-type=module", "-e",
      "const engine = await import(process.argv[1]); console.log(typeof engine.createDesktopVaultSync);",
      path.join(import.meta.dir, "..", "desktop", "vaultSyncEngine.mjs")], { encoding: "utf8" });
    expect(node.stderr).toBe("");
    expect(node.stdout.trim()).toBe("function");
  }, 60_000);
});
