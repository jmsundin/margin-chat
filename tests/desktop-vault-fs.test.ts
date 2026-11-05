import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isVaultFsPath, nodeVaultFs } from "../desktop/vaultFs.mjs";
import { describeVaultFs } from "./helpers/vaultFsConformance";

async function folderWith(files: Record<string, string | Uint8Array>) {
  const root = await mkdtemp(path.join(tmpdir(), "margin-vault-"));
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  }
  return root;
}

describeVaultFs("desktop folder (node:fs)", async (files) => {
  const root = await folderWith(files);
  return {
    // Files the suite writes "from outside" were all just changed; a short wait keeps the read-stability check quick.
    fs: nodeVaultFs(root, { stableReadMs: 20 }),
    outside: {
      write: (relative, contents) => writeFile(path.join(root, relative), contents),
      remove: (relative) => rm(path.join(root, relative)),
    },
  };
});

describe("desktop folder safety", () => {
  test("never follows a link out of the vault", async () => {
    const outside = await folderWith({ "secret.md": "Not in the vault." });
    const root = await folderWith({ "Note.md": "In the vault." });
    await symlink(outside, path.join(root, "Linked"));
    await symlink(path.join(outside, "secret.md"), path.join(root, "secret.md"));
    const fs = nodeVaultFs(root);
    const names: string[] = [];
    for await (const entry of fs.list("")) names.push(entry.name);
    expect(names).toEqual(["Note.md"]);
    await expect(fs.read("Linked/secret.md")).rejects.toThrow(/link/);
    await expect(fs.read("secret.md")).rejects.toThrow(/link/);
    await expect(fs.writeAtomic("Linked/new.md", "x")).rejects.toThrow(/link/);
    expect(await readdir(outside)).toEqual(["secret.md"]);
  });

  test("a write that fails leaves the previous file and no temporary file", async () => {
    const root = await folderWith({ "Note.md": "Before." });
    const fs = nodeVaultFs(root);
    // A folder where the file should be can't be replaced.
    await mkdir(path.join(root, "Folder.md"));
    await expect(fs.writeAtomic("Folder.md", "x")).rejects.toThrow();
    await fs.writeAtomic("Note.md", "After.");
    expect(await readFile(path.join(root, "Note.md"), "utf8")).toBe("After.");
    expect((await readdir(root)).sort()).toEqual(["Folder.md", "Note.md"]);
  });

  test("a missing folder is missing, never empty", async () => {
    const root = await folderWith({ "Note.md": "x" });
    const fs = nodeVaultFs(root);
    expect(await fs.availability()).toBe("available");
    await rm(root, { recursive: true });
    expect(await fs.availability()).toBe("missing");
    await expect((async () => { for await (const _ of fs.list("")) { /* nothing */ } })()).rejects.toMatchObject({ name: "NotFoundError" });
  });

  test("Windows names that would escape or misbehave are refused there", () => {
    expect(isVaultFsPath("Note.md", "win32")).toBe(true);
    for (const bad of ["C:Note.md", "Note.md:stream", "CON", "aux.md", "trailing.", "trailing ", "a?b.md"]) expect(isVaultFsPath(bad, "win32")).toBe(false);
    expect(isVaultFsPath("Note: a thought.md", "darwin")).toBe(true);
  });
});

// The page's side of the bridge, talking to the real main-process code without Electron in between.
import { desktopVaultFs, type DesktopVaultBridge } from "../client/src/lib/vaultFsDesktop";
import { createVaultFolders } from "../desktop/vaultFolders.mjs";
import { answerVaultRequest, VAULT_OPERATIONS } from "../desktop/vaultBridge.mjs";

async function bridgeTo(root: string) {
  let next: string | null = root;
  const folders = createVaultFolders({ statePath: path.join(root, "..", `${path.basename(root)}-state.json`), chooseFolder: async () => { const answer = next; next = null; return answer; } });
  // Structured cloning copies bytes across the process boundary, as Electron's IPC does.
  const bridge = Object.fromEntries(VAULT_OPERATIONS.map((operation: string) => [operation,
    async (...args: unknown[]) => structuredClone(await answerVaultRequest(folders, operation, structuredClone(args)))])) as unknown as DesktopVaultBridge;
  bridge.version = 1;
  const folder = (await folders.choose())!;
  return desktopVaultFs(bridge, folder);
}

describeVaultFs("desktop folder through the page's bridge", async (files) => {
  const root = await folderWith(files);
  return {
    fs: await bridgeTo(root),
    outside: {
      write: (relative, contents) => writeFile(path.join(root, relative), contents),
      remove: (relative) => rm(path.join(root, relative)),
    },
  };
});

describe("folder sync on the desktop folder", () => {
  test("the page's folder scan and write run unchanged on the native folder", async () => {
    const { discoverMarkdownWorkspace, parseMarkdownWorkspace, createMarkdownWorkspace } = await import("../client/src/lib/workspaceMarkdown");
    const { readDirectoryWorkspace, writeConnectedDirectoryWorkspace, LocalDirectoryConflictError } = await import("../client/src/lib/workspaceStorage");
    const root = await folderWith({ "Note.md": "Original content.", "Sub/Other.md": "Other." });
    const fs = await bridgeTo(root);
    const read = await readDirectoryWorkspace(fs, "user");
    expect(Object.keys(read.workspace.files).sort()).toEqual(["Note.md", "Sub/Other.md"]);
    const state = parseMarkdownWorkspace(read.workspace.manifest, read.workspace.files)!;
    const id = read.workspace.manifest.files.find((file) => file.path === "Note.md")!.id;
    state.conversations[id].notes![0].content = "Changed in Margin Chat.";
    const desired = createMarkdownWorkspace(state, undefined, read.workspace);
    await writeConnectedDirectoryWorkspace(fs, "user", desired, read.workspace, read.stats);
    expect(await readFile(path.join(root, "Note.md"), "utf8")).toContain("Changed in Margin Chat.");
    await writeFile(path.join(root, "Note.md"), "Changed in another editor.");
    await expect(writeConnectedDirectoryWorkspace(fs, "user", read.workspace, desired)).rejects.toBeInstanceOf(LocalDirectoryConflictError);
    expect(await readFile(path.join(root, "Note.md"), "utf8")).toBe("Changed in another editor.");
  });
});

describe("the page in a desktop app that offers its own folder", () => {
  test("chooses, remembers, reads, writes and forgets the folder through the app, never asking the browser", async () => {
    const storage = await import("../client/src/lib/workspaceStorage");
    const { discoverMarkdownWorkspace } = await import("../client/src/lib/workspaceMarkdown");
    const root = await folderWith({ "Plain.md": "# A plain note dropped in" });
    let next: string | null = root;
    const folders = createVaultFolders({ statePath: `${root}-state.json`, chooseFolder: async () => { const answer = next; next = null; return answer; } });
    const bridge = Object.fromEntries(VAULT_OPERATIONS.map((operation: string) => [operation,
      async (...args: unknown[]) => structuredClone(await answerVaultRequest(folders, operation, structuredClone(args)))])) as unknown as DesktopVaultBridge;
    bridge.version = 1;
    const previous = (globalThis as { window?: unknown }).window;
    // No showDirectoryPicker and no indexedDB: only the app's bridge.
    (globalThis as { window?: unknown }).window = { marginDesktop: { vault: bridge }, top: null };
    try {
      expect(await storage.getLocalDirectoryStatus("user-1")).toMatchObject({ supported: true, permission: "unselected" });
      const picked = await storage.pickLocalDirectory();
      expect(picked?.name).toBe(path.basename(root));
      const status = await storage.connectLocalDirectory("user-1", picked!);
      expect(status).toMatchObject({ permission: "granted", directoryName: path.basename(root), supported: true });
      expect(await storage.getLocalDirectoryStatus("user-1")).toMatchObject({ permission: "granted", directoryId: status.directoryId });
      expect(await storage.listLocalDirectories("user-1")).toEqual([{ id: status.directoryId!, name: path.basename(root), current: true }]);
      expect(await storage.localDirectoryAvailability("user-1", status.directoryId)).toBe("available");

      const read = await storage.readLocalDirectoryWorkspace("user-1", undefined, undefined, status.directoryId);
      expect(Object.keys(read!.workspace.files)).toEqual(["Plain.md"]);
      const added = discoverMarkdownWorkspace({ ...read!.workspace.files, "From the app.md": "Written by Margin Chat." }, read!.workspace.manifest);
      const written = await storage.writeLocalDirectory("user-1", { workspace: added, expectedWorkspace: read!.workspace, files: {}, expectedFiles: {}, stats: read!.stats }, status.directoryId);
      expect(written?.status.permission).toBe("granted");
      expect(await readFile(path.join(root, "From the app.md"), "utf8")).toContain("Written by Margin Chat.");

      await storage.clearLocalDirectory("user-1");
      expect(await storage.getLocalDirectoryStatus("user-1")).toMatchObject({ permission: "unselected" });
      expect(await readFile(path.join(root, "Plain.md"), "utf8")).toBe("# A plain note dropped in");
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });
});

describe("the page hearing the desktop app's watcher", () => {
  test("a file dropped into the folder reaches the page once it settles, with the page's own checks slowed to a backstop", async () => {
    const storage = await import("../client/src/lib/workspaceStorage");
    const { createVaultWatchers, VAULT_CHANGED_CHANNEL } = await import("../desktop/vaultBridge.mjs");
    const root = await folderWith({ "Plain.md": "# Plain" });
    let next: string | null = root;
    const folders = createVaultFolders({ statePath: `${root}-state.json`, chooseFolder: async () => { const answer = next; next = null; return answer; } });
    const listeners = new Set<(change: { id: string; paths: string[] | null }) => void>();
    const sender = { id: 1, isDestroyed: () => false, send: (channel: string, change: { id: string; paths: string[] | null }) => { if (channel === VAULT_CHANGED_CHANNEL) for (const listener of listeners) listener(structuredClone(change)); }, once() {} };
    const watchers = createVaultWatchers({ folders, watcherOptions: { debounceMs: 40, stabilityMs: 40, platform: "linux" } });
    const bridge = Object.fromEntries(VAULT_OPERATIONS.map((operation: string) => [operation,
      async (...args: unknown[]) => structuredClone(await answerVaultRequest(folders, operation, structuredClone(args)))])) as unknown as DesktopVaultBridge;
    bridge.version = 1;
    bridge.watch = async (id) => ({ ok: true, value: await watchers.watch(sender, id) });
    bridge.unwatch = async (id) => { watchers.unwatch(sender, id); return { ok: true, value: undefined }; };
    bridge.onChange = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { marginDesktop: { vault: bridge }, top: null };
    let stop = () => {};
    try {
      const status = await storage.connectLocalDirectory("user-1", (await storage.pickLocalDirectory())!);
      let heard = 0;
      stop = storage.watchLocalDirectory("user-1", status.directoryId!, () => { heard += 1; });
      for (let tries = 0; tries < 100 && !listeners.size; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeFile(path.join(root, "Dropped.md"), "# Dropped in from Finder");
      for (let tries = 0; tries < 150 && heard === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(heard).toBe(1);

      // The scan lists files the app doesn't sync, for Vault settings.
      await writeFile(path.join(root, "Budget.xlsx"), "x");
      await writeFile(path.join(root, ".DS_Store"), "x");
      const unsynced: string[] = [];
      await storage.listLocalDirectoryFiles("user-1", status.directoryId, unsynced);
      expect(unsynced).toEqual(["Budget.xlsx"]);
    } finally {
      stop();
      watchers.closeAll();
      (globalThis as { window?: unknown }).window = previous;
    }
  });

  test("only files Margin Chat leaves alone count as unsynced", async () => {
    const { isUnsyncedFolderFile } = await import("../client/src/lib/workspaceStorage");
    expect(isUnsyncedFolderFile("Budget.xlsx")).toBe(true);
    expect(isUnsyncedFolderFile("Projects/notes.txt")).toBe(true);
    for (const synced of ["Note.md", "Papers/Paper.pdf", "photo.png", "workspace.json", ".DS_Store", "Paper.pdf.crdownload", ".hidden/x.txt"]) {
      expect(isUnsyncedFolderFile(synced)).toBe(false);
    }
  });
});
