import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEchoSuppressor, hashBytes } from "../packages/vault-sync/echoSuppression";
import { isAppOwnedPath, isIgnoredVaultPath, isNoiseFileName } from "../packages/vault-sync/ignore";
import { openNodeVaultDirectory, supportsRecursiveWatch, watchVaultFolder, type FolderChange, type RawWatchSource } from "../packages/vault-sync/node";
import { writeVaultFile } from "../packages/vault-sync/vaultFs";

const folders: string[] = [];
async function tempFolder() {
  const folder = await mkdtemp(path.join(tmpdir(), "margin-watch-"));
  folders.push(folder);
  return folder;
}
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const FAST = { debounceMs: 30, recheckMs: 20, batchMs: 10 };

/** Raw events fed by the test instead of the operating system. */
function manualSource() {
  let listener: ((relativePath: string | null) => void) | null = null;
  const source: RawWatchSource = (_root, next) => { listener = next; return () => { listener = null; }; };
  return { source, emit: (relativePath: string | null) => listener?.(relativePath), get active() { return listener !== null; } };
}

describe("ignore list", () => {
  test("system and editor noise, partial downloads and other tools' folders are never content", () => {
    for (const name of [".DS_Store", "Thumbs.db", "desktop.ini", "~$Budget.docx", "report.tmp", ".Note.md.swp", "4913", "paper.pdf.crdownload", "video.part", "song.download", "Note.md~", ".#Note.md", ".margin-chat-tmp-abc"]) {
      expect(isNoiseFileName(name)).toBe(true);
    }
    for (const name of ["Note.md", "paper.pdf", "photo.jpg", "Plan v2.md", "tmp.md", "part one.md"]) expect(isNoiseFileName(name)).toBe(false);
    for (const vaultPath of [".git/HEAD", ".obsidian/workspace.json", "Notes/.DS_Store", "node_modules/x/index.js", ".trash/Old.md", "Inbox/report.tmp", ".hidden/Note.md"]) {
      expect(isIgnoredVaultPath(vaultPath)).toBe(true);
    }
    for (const vaultPath of ["Note.md", "Projects/Plan.md", ".margin-chat/trash/k/deleted.json", "Attachments/x/file.pdf", "workspace.json"]) {
      expect(isIgnoredVaultPath(vaultPath)).toBe(false);
    }
    expect(isAppOwnedPath(".margin-chat/history/x/local/Note.md")).toBe(true);
    expect(isAppOwnedPath("workspace.json")).toBe(true);
    expect(isAppOwnedPath("margin-chat-workspace-jon.json")).toBe(true);
    expect(isAppOwnedPath("Attachments/id/paper.pdf")).toBe(true);
    expect(isAppOwnedPath("Note.md")).toBe(false);
  });
});

describe("echo suppression", () => {
  test("an expected hash is an echo once, a different hash is an external change, and old expectations expire", () => {
    const echo = createEchoSuppressor(1_000);
    echo.expect("Note.md", "aaa", 0);
    expect(echo.isEcho("Note.md", "bbb", 10)).toBe(false);
    expect(echo.isEcho("Note.md", "aaa", 10)).toBe(true);
    expect(echo.isEcho("Note.md", "aaa", 10)).toBe(false);
    echo.expect("Note.md", "ccc", 100);
    echo.expect("Note.md", "ddd", 200); // one entry per path: the latest write wins
    expect(echo.size).toBe(1);
    expect(echo.isEcho("Note.md", "ccc", 210)).toBe(false);
    echo.expectRemoved("Gone.md", 300);
    expect(echo.isEcho("Gone.md", null, 310)).toBe(true);
    echo.expect("Stale.md", "eee", 400);
    expect(echo.isEcho("Stale.md", "eee", 1_500)).toBe(false);
    expect(echo.size).toBe(0);
  });
});

describe("folder watcher", () => {
  test("raw events are debounced per path, ignored names are dropped, and only stable files are reported", async () => {
    const root = await tempFolder();
    await writeFile(path.join(root, "Note.md"), "hello");
    const raw = manualSource();
    const batches: FolderChange[][] = [];
    const watcher = watchVaultFolder({ root, onChanges: (changes) => batches.push(changes), source: raw.source, ...FAST });
    expect(raw.active).toBe(true);
    raw.emit("Note.md"); raw.emit("Note.md"); raw.emit("./Note.md");
    raw.emit(".DS_Store"); raw.emit(".obsidian/workspace.json"); raw.emit("Inbox/report.crdownload"); raw.emit(".margin-chat-tmp-x");
    await watcher.settle();
    expect(batches).toEqual([[{ path: "Note.md", kind: "changed" }]]);

    // A file that disappears is a removal; an event with no path is a whole-folder look.
    await rm(path.join(root, "Note.md"));
    raw.emit("Note.md"); raw.emit(null);
    await watcher.settle();
    expect(batches.flat()).toEqual(expect.arrayContaining([{ path: "", kind: "changed" }, { path: "Note.md", kind: "removed" }]));
    watcher.close();
    expect(raw.active).toBe(false);
  });

  test("a file still being written in pieces is reported once, with its final bytes", async () => {
    const root = await tempFolder();
    const raw = manualSource();
    const batches: FolderChange[][] = [];
    const watcher = watchVaultFolder({ root, onChanges: (changes) => batches.push(changes), source: raw.source, debounceMs: 40, recheckMs: 30, batchMs: 10 });
    const file = path.join(root, "Big.md");
    const handle = await open(file, "w");
    // Chunks arrive for ~300 ms, each followed by an event, like a copy or a download.
    for (let chunk = 0; chunk < 10; chunk += 1) {
      await handle.write(`chunk ${chunk}\n`);
      raw.emit("Big.md");
      await sleep(30);
    }
    await handle.close();
    raw.emit("Big.md");
    await watcher.settle();
    expect(batches).toEqual([[{ path: "Big.md", kind: "changed" }]]);
    watcher.close();
  });

  test("the app's own writes are recognized by hash and not reported; an outside edit of the same file is", async () => {
    const root = await tempFolder();
    const echo = createEchoSuppressor();
    const directory = await openNodeVaultDirectory(root, {
      onWritten: (vaultPath, bytes) => { void hashBytes(bytes).then((hash) => echo.expect(vaultPath, hash)); },
      onRemoved: (vaultPath) => echo.expectRemoved(vaultPath),
    });
    const raw = manualSource();
    const batches: FolderChange[][] = [];
    const watcher = watchVaultFolder({ root, echo, onChanges: (changes) => batches.push(changes), source: raw.source, ...FAST });
    await writeVaultFile(directory, "Pulled.md", "from the cloud");
    await sleep(5); // the hash is recorded asynchronously
    raw.emit("Pulled.md");
    await watcher.settle();
    expect(batches).toEqual([]);
    await writeFile(path.join(root, "Pulled.md"), "edited in Obsidian");
    raw.emit("Pulled.md");
    await watcher.settle();
    expect(batches).toEqual([[{ path: "Pulled.md", kind: "changed" }]]);
    await directory.removeEntry("Pulled.md");
    raw.emit("Pulled.md");
    await watcher.settle();
    expect(batches.length).toBe(1);
    watcher.close();
  });

  test("a folder that appears has its files reported, since their own events may be missed", async () => {
    const root = await tempFolder();
    const raw = manualSource();
    const batches: FolderChange[][] = [];
    const watcher = watchVaultFolder({ root, onChanges: (changes) => batches.push(changes), source: raw.source, ...FAST });
    await mkdir(path.join(root, "Imported", "Deep"), { recursive: true });
    await writeFile(path.join(root, "Imported", "A.md"), "a");
    await writeFile(path.join(root, "Imported", "Deep", "B.md"), "b");
    await writeFile(path.join(root, "Imported", ".DS_Store"), "noise");
    raw.emit("Imported");
    await watcher.settle();
    expect(batches.flat().map((change) => change.path).sort()).toEqual(["Imported/A.md", "Imported/Deep/B.md"]);
    watcher.close();
  });

  test("with the real recursive watcher, a drop-in, a finished download and a delete each arrive once", async () => {
    const root = await tempFolder();
    if (!supportsRecursiveWatch(root)) return; // Recorded in packages/vault-sync/README.md: this platform needs the library fallback.
    const batches: FolderChange[][] = [];
    const watcher = watchVaultFolder({ root, onChanges: (changes) => batches.push(changes), debounceMs: 60, recheckMs: 40, batchMs: 20 });
    await sleep(50);
    await writeFile(path.join(root, "Dropped.md"), "# Dropped\n");
    await writeFile(path.join(root, "paper.pdf.crdownload"), "partial");
    await sleep(80);
    await writeFile(path.join(root, "paper.pdf.crdownload"), "partial, then whole");
    await rename(path.join(root, "paper.pdf.crdownload"), path.join(root, "paper.pdf"));
    await sleep(300);
    await watcher.settle();
    const changed = batches.flat().filter((change) => change.kind === "changed").map((change) => change.path).sort();
    expect(changed).toEqual(["Dropped.md", "paper.pdf"]);
    expect(batches.flat().filter((change) => change.path === "paper.pdf")).toHaveLength(1);
    await rm(path.join(root, "Dropped.md"));
    await sleep(300);
    await watcher.settle();
    expect(batches.flat()).toContainEqual({ path: "Dropped.md", kind: "removed" });
    watcher.close();
  });
});
