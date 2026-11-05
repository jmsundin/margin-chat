import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, open, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isIgnoredVaultPath as packageIgnored } from "@margin-chat/vault-sync";
import { nodeVaultFs } from "../desktop/vaultFs.mjs";
import { createVaultWatcher, isIgnoredVaultPath } from "../desktop/vaultWatcher.mjs";
import { createVaultFolders } from "../desktop/vaultFolders.mjs";
import { createVaultWatchers, VAULT_CHANGED_CHANNEL } from "../desktop/vaultBridge.mjs";

// Short waits so the tests run quickly; the app uses 500 ms each.
const TIMING = { debounceMs: 60, stabilityMs: 60, missingCheckMs: 150, platform: "linux" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

async function emptyFolder() {
  return mkdtemp(path.join(tmpdir(), "margin-watch-"));
}

function watch(root: string, options: Partial<Parameters<typeof createVaultWatcher>[0]> = {}) {
  const reports: Array<string[] | null> = [];
  const watcher = createVaultWatcher({ root, onChange: (paths) => reports.push(paths), ...TIMING, ...options });
  closers.push(() => watcher.close());
  return { watcher, reports, paths: () => reports.flatMap((report) => report ?? ["*"]) };
}

async function until(check: () => boolean, ms = 3_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("Timed out waiting for the watcher.");
    await sleep(20);
  }
}

describe("desktop folder watcher", () => {
  test("files copied in from outside are reported once each, after they settle", async () => {
    const source = await emptyFolder();
    await writeFile(path.join(source, "Plain.md"), "# Plain\n\nWritten in another app.\n");
    await writeFile(path.join(source, "Known.md"), "---\nid: doc-123\n---\n# Known\n");
    await writeFile(path.join(source, "Paper.pdf"), new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
    await writeFile(path.join(source, "Sheet.xlsx"), "not synced");
    const root = await emptyFolder();
    const { watcher, reports, paths } = watch(root);
    await watcher.started;
    expect(watcher.active).toBe(true);
    for (const name of ["Plain.md", "Known.md", "Paper.pdf", "Sheet.xlsx"]) await copyFile(path.join(source, name), path.join(root, name));
    await until(() => paths().length >= 4);
    await sleep(300);
    // Every path the page might care about is named (the page decides what it syncs), and each only once.
    expect(paths().sort()).toEqual(["Known.md", "Paper.pdf", "Plain.md", "Sheet.xlsx"]);
    expect(reports.length).toBeLessThanOrEqual(4);
  });

  test("a file written in pieces over a while is reported once, when it holds still", async () => {
    const root = await emptyFolder();
    const { watcher, paths } = watch(root);
    await watcher.started;
    const handle = await open(path.join(root, "Slow.md"), "w");
    for (let chunk = 0; chunk < 8; chunk += 1) {
      await handle.write(`Line ${chunk}\n`);
      await sleep(40);
    }
    await handle.close();
    await until(() => paths().length > 0);
    await sleep(300);
    expect(paths()).toEqual(["Slow.md"]);
  });

  test("a download renamed into place is reported once, under its final name", async () => {
    const root = await emptyFolder();
    const { watcher, paths } = watch(root);
    await watcher.started;
    await writeFile(path.join(root, "Paper.pdf.crdownload"), "partial");
    await sleep(30);
    await writeFile(path.join(root, "Paper.pdf.crdownload"), "partial, then the rest");
    await rename(path.join(root, "Paper.pdf.crdownload"), path.join(root, "Paper.pdf"));
    await until(() => paths().length > 0);
    await sleep(300);
    expect(paths()).toEqual(["Paper.pdf"]);
  });

  test("other apps' scratch files and folders are never reported", async () => {
    const root = await emptyFolder();
    await mkdir(path.join(root, ".obsidian"));
    await mkdir(path.join(root, ".git"));
    const { watcher, paths } = watch(root);
    await watcher.started;
    await writeFile(path.join(root, ".DS_Store"), "x");
    await writeFile(path.join(root, ".Note.md.swp"), "x");
    await writeFile(path.join(root, "~$Report.docx"), "x");
    await writeFile(path.join(root, ".obsidian", "workspace.json"), "{}");
    await writeFile(path.join(root, ".git", "index"), "x");
    await writeFile(path.join(root, "Real.md"), "# Real\n");
    await until(() => paths().length > 0);
    await sleep(300);
    expect(paths()).toEqual(["Real.md"]);
  });

  test("files in new and existing subfolders are reported (one watcher per folder on Linux)", async () => {
    const root = await emptyFolder();
    await mkdir(path.join(root, "Old"));
    const { watcher, reports, paths } = watch(root);
    await watcher.started;
    await writeFile(path.join(root, "Old", "Inside.md"), "# Inside\n");
    await until(() => paths().includes("Old/Inside.md"));
    // A folder dropped in whole asks for a full look, then its later changes are heard too.
    await mkdir(path.join(root, "New"));
    await until(() => reports.includes(null));
    await writeFile(path.join(root, "New", "Later.md"), "# Later\n");
    await until(() => paths().includes("New/Later.md"));
  });

  test("changes and removals are reported; the app's own writes are not", async () => {
    const root = await emptyFolder();
    await writeFile(path.join(root, "Theirs.md"), "one");
    const fs = nodeVaultFs(root);
    const { watcher, paths } = watch(root, { isOwnChange: fs.isOwnChange });
    await watcher.started;
    await fs.writeAtomic("Mine.md", "# Written by Margin Chat\n");
    await fs.writeAtomic("Moved.md", "x");
    await fs.move("Moved.md", "Folder/Moved.md");
    await writeFile(path.join(root, "Theirs.md"), "two, longer");
    await until(() => paths().includes("Theirs.md"));
    await rm(path.join(root, "Theirs.md"));
    await sleep(400);
    expect(paths().filter((entry) => entry !== "*")).toEqual(["Theirs.md", "Theirs.md"]);
    // The app's own file changed by someone else afterwards is theirs again.
    await writeFile(path.join(root, "Mine.md"), "# Edited elsewhere, a different length\n");
    await until(() => paths().includes("Mine.md"));
  });

  test("a folder that goes missing is not reported as emptied, and is looked at whole when it is back", async () => {
    const parent = await emptyFolder();
    const root = path.join(parent, "Vault");
    await mkdir(root);
    await writeFile(path.join(root, "Note.md"), "# Note\n");
    const { watcher, reports } = watch(root);
    await watcher.started;
    await rename(root, path.join(parent, "Away"));
    await until(() => !watcher.active);
    // Losing the folder asks the page to look, and the page finds it missing (never empty).
    const reportsWhileAway = reports.length;
    await sleep(400);
    expect(reports.length).toBe(reportsWhileAway);
    await rename(path.join(parent, "Away"), root);
    await until(() => watcher.active && reports.length > reportsWhileAway);
    expect(reports.at(-1)).toBeNull();
  });

  test("a folder that isn't there at the start is watched once it appears", async () => {
    const parent = await emptyFolder();
    const root = path.join(parent, "Later");
    const { watcher, reports, paths } = watch(root);
    await watcher.started;
    expect(watcher.active).toBe(false);
    await mkdir(root);
    await until(() => watcher.active && reports.includes(null));
    await writeFile(path.join(root, "First.md"), "# First\n");
    await until(() => paths().includes("First.md"));
  });

  test("a closed watcher reports nothing more", async () => {
    const root = await emptyFolder();
    const { watcher, reports } = watch(root);
    await watcher.started;
    watcher.close();
    expect(watcher.active).toBe(false);
    await writeFile(path.join(root, "After.md"), "x");
    await sleep(300);
    expect(reports).toEqual([]);
  });

  test("macOS and Windows use one recursive watcher; a failed watcher starts over and asks for a full look", async () => {
    const root = await emptyFolder();
    const made: Array<{ recursive: boolean; emit: (event: string, value?: unknown) => void; closed: boolean }> = [];
    const watchImpl = ((_path: string, options: { recursive: boolean }, listener: (event: string, name: string | null) => void) => {
      const handlers: Record<string, (value?: unknown) => void> = {};
      const fake = {
        recursive: options.recursive,
        closed: false,
        emit(event: string, value?: unknown) { if (event === "change") listener("change", value as string | null); else handlers[event]?.(value); },
        on(event: string, handler: (value?: unknown) => void) { handlers[event] = handler; return this; },
        close() { fake.closed = true; },
      };
      made.push(fake);
      return fake;
    }) as never;
    const { watcher, reports, paths } = watch(root, { platform: "darwin", watchImpl });
    await watcher.started;
    expect(made).toHaveLength(1);
    expect(made[0].recursive).toBe(true);
    await writeFile(path.join(root, "Deep.md"), "x");
    made[0].emit("change", "Deep.md");
    await until(() => paths().includes("Deep.md"));
    // No file name: something changed, but the system can't say what.
    made[0].emit("change", null);
    await until(() => reports.includes(null));
    reports.length = 0;
    made[0].emit("error", new Error("watcher failed"));
    await until(() => made.length === 2 && reports.includes(null));
    expect(made[0].closed).toBe(true);
    expect(watcher.active).toBe(true);
  });
});

describe("desktop reads of files still arriving", () => {
  test("a file changed a moment ago is read only once it holds still", async () => {
    const root = await emptyFolder();
    const fs = nodeVaultFs(root, { recentChangeMs: 10_000, stableReadMs: 80 });
    const target = path.join(root, "Arriving.md");
    await writeFile(target, "first part");
    const reading = fs.read("Arriving.md");
    await sleep(20);
    await writeFile(target, "first part, and the rest");
    await expect(reading).rejects.toMatchObject({ name: "InvalidStateError" });
    // Held still: read as normal.
    const read = await fs.read("Arriving.md");
    expect(new TextDecoder().decode(read!.bytes)).toBe("first part, and the rest");
  });

  test("files changed long ago, and the app's own writes, are read at once", async () => {
    const root = await emptyFolder();
    const fs = nodeVaultFs(root, { recentChangeMs: 10_000, stableReadMs: 1_000 });
    await writeFile(path.join(root, "Old.md"), "old");
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(path.join(root, "Old.md"), longAgo, longAgo);
    await fs.writeAtomic("Mine.md", "mine");
    const started = Date.now();
    expect(new TextDecoder().decode((await fs.read("Old.md"))!.bytes)).toBe("old");
    expect(new TextDecoder().decode((await fs.read("Mine.md"))!.bytes)).toBe("mine");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("the app remembers what it last left at each path", async () => {
    const root = await emptyFolder();
    const fs = nodeVaultFs(root);
    await fs.writeAtomic("A.md", "a");
    expect(fs.isOwnChange("A.md", await fs.stat("A.md"))).toBe(true);
    expect(fs.isOwnChange("A.md", { size: 99, modifiedMs: 1 })).toBe(false);
    await fs.delete("A.md");
    expect(fs.isOwnChange("A.md", null)).toBe(true);
    expect(fs.isOwnChange("Never.md", null)).toBe(false);
  });
});

describe("ignore rules", () => {
  const cases: Array<[string, boolean]> = [
    ["Note.md", false], ["Papers/Paper.pdf", false], ["Images/photo.png", false], ["Sheet.xlsx", false],
    [".DS_Store", true], ["Folder/Thumbs.db", true], ["desktop.ini", true], ["4913", true],
    [".~lock.Report.odt#", true], ["~$Report.docx", true], ["._Note.md", true],
    [".Note.md.swp", true], ["Paper.pdf.crdownload", true], ["Movie.part", true], ["Note.md.icloud", true], ["x.tmp", true],
    [".margin-write-0123456789ab.tmp", true],
    [".git/index", true], [".obsidian/workspace.json", true], ["Sub/node_modules/a.md", true], [".margin-chat", true], ["$RECYCLE.BIN/x.md", true],
  ];
  test.each(cases)("%s ignored: %p", (relativePath, ignored) => {
    expect(isIgnoredVaultPath(relativePath)).toBe(ignored);
  });
  test("the desktop app and the page skip the same files", () => {
    for (const [relativePath] of cases) expect(packageIgnored(relativePath)).toBe(isIgnoredVaultPath(relativePath));
  });
});

describe("watching through the bridge", () => {
  test("a page's watchers report to that page, stop when it asks or goes away, and need a folder handed out", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "margin-desktop-"));
    const vault = path.join(home, "Vault");
    await mkdir(vault);
    const answers = [vault];
    const folders = createVaultFolders({
      statePath: path.join(home, "userData", "vault-folders.json"),
      async chooseFolder() { return answers.shift() ?? null; },
      defaultLocation: () => home,
    });
    const folder = (await folders.choose())!;
    await folders.connect("user-1", folder.id);
    const sent: Array<{ channel: string; change: { id: string; paths: string[] | null } }> = [];
    let destroyed: (() => void) | null = null;
    const sender = {
      id: 7,
      isDestroyed: () => false,
      send: (channel: string, change: { id: string; paths: string[] | null }) => sent.push({ channel, change }),
      once: (event: string, listener: () => void) => { if (event === "destroyed") destroyed = listener; },
    };
    const watchers = createVaultWatchers({ folders, watcherOptions: TIMING });
    closers.push(() => watchers.closeAll());
    await expect(watchers.watch(sender, "not-handed-out")).rejects.toMatchObject({ name: "NotFoundError" });
    expect(await watchers.watch(sender, folder.id)).toEqual({ active: true });
    // Asking again keeps the one watcher.
    expect(await watchers.watch(sender, folder.id)).toEqual({ active: true });
    await writeFile(path.join(vault, "Dropped.md"), "# Dropped\n");
    await until(() => sent.length > 0);
    expect(sent[0]).toEqual({ channel: VAULT_CHANGED_CHANNEL, change: { id: folder.id, paths: ["Dropped.md"] } });
    // Files the app writes through the same folder aren't echoed back.
    const fs = (await folders.fs(folder.id))!;
    await fs.writeAtomic("Saved.md", "# Saved by the app\n");
    await sleep(400);
    expect(sent.map((entry) => entry.change.paths)).toEqual([["Dropped.md"]]);
    destroyed!();
    await writeFile(path.join(vault, "After.md"), "x");
    await sleep(400);
    expect(sent).toHaveLength(1);
  });
});
