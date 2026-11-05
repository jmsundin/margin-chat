import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { asFileSystemDirectoryHandle, nodeFolderAvailability, openNodeVaultDirectory, replaceAtomically, TargetBusyError, TEMP_FILE_PREFIX } from "../packages/vault-sync/node";
import { isDomErrorNamed, readVaultText, writeVaultFile } from "../packages/vault-sync/vaultFs";
import {
  listConnectedDirectoryFiles, localDirectorySignature, readConnectedDirectoryCompanions, readDirectoryWorkspace, syncConnectedDirectoryCompanions,
  writeConnectedDirectoryWorkspace,
} from "../client/src/lib/workspaceStorage";
import { createVaultFolder, previewLocalDirectory } from "../client/src/lib/desktopVault";
import { createMarkdownWorkspace, parseMarkdownWorkspace } from "../client/src/lib/workspaceMarkdown";

const folders: string[] = [];
async function tempFolder() {
  const folder = await mkdtemp(path.join(tmpdir(), "margin-vault-"));
  folders.push(folder);
  return folder;
}
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

const names = async (folder: string) => (await readdir(folder)).sort();

describe("the node vault directory behaves like a browser directory handle", () => {
  test("lists, opens, creates and removes entries with the DOM's error names", async () => {
    const root = await tempFolder();
    await writeFile(path.join(root, "Note.md"), "# Note\n");
    await mkdir(path.join(root, "Projects"));
    await writeFile(path.join(root, "Projects", "Plan.md"), "plan");
    const directory = await openNodeVaultDirectory(root);
    expect(directory.name).toBe(path.basename(root));
    const listed: string[] = [];
    for await (const [name, handle] of directory.entries()) listed.push(`${handle.kind}:${name}`);
    expect(listed).toEqual(["file:Note.md", "directory:Projects"]);

    const note = await directory.getFileHandle("Note.md");
    const snapshot = await note.getFile();
    expect(snapshot.size).toBe(7);
    expect(snapshot.lastModified).toBeGreaterThan(0);
    expect(await snapshot.text()).toBe("# Note\n");
    const projects = await directory.getDirectoryHandle("Projects");
    expect(await (await (await projects.getFileHandle("Plan.md")).getFile()).text()).toBe("plan");

    await expect(directory.getFileHandle("Missing.md")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(directory.getDirectoryHandle("Missing")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(directory.getFileHandle("Projects")).rejects.toMatchObject({ name: "TypeMismatchError" });
    await expect(directory.getDirectoryHandle("Note.md")).rejects.toMatchObject({ name: "TypeMismatchError" });
    await expect(directory.getFileHandle("../escape.md")).rejects.toMatchObject({ name: "TypeMismatchError" });
    await expect(directory.getFileHandle("..")).rejects.toMatchObject({ name: "TypeMismatchError" });

    // create:true makes an empty file, like OPFS, and a folder.
    const created = await directory.getFileHandle("Fresh.md", { create: true });
    expect((await created.getFile()).size).toBe(0);
    await directory.getDirectoryHandle("Inbox", { create: true });
    expect(await names(root)).toEqual(["Fresh.md", "Inbox", "Note.md", "Projects"]);
    await directory.removeEntry("Fresh.md");
    await directory.removeEntry("Inbox");
    await expect(directory.removeEntry("Projects")).rejects.toMatchObject({ name: "InvalidModificationError" });
    await directory.removeEntry("Projects", { recursive: true });
    await expect(directory.removeEntry("Projects")).rejects.toMatchObject({ name: "NotFoundError" });
    expect(await names(root)).toEqual(["Note.md"]);
    expect(await directory.isSameEntry!(await openNodeVaultDirectory(root))).toBe(true);
  });

  test("symbolic links are invisible, so nothing reaches outside the vault folder", async () => {
    const root = await tempFolder();
    const outside = await tempFolder();
    await writeFile(path.join(outside, "secret.md"), "secret");
    await writeFile(path.join(root, "Note.md"), "note");
    await symlink(outside, path.join(root, "Linked"));
    await symlink(path.join(outside, "secret.md"), path.join(root, "secret-link.md"));
    const directory = await openNodeVaultDirectory(root);
    const listed: string[] = [];
    for await (const [name] of directory.entries()) listed.push(name);
    expect(listed).toEqual(["Note.md"]);
    await expect(directory.getDirectoryHandle("Linked")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(directory.getFileHandle("secret-link.md")).rejects.toMatchObject({ name: "NotFoundError" });
    // Creating where a link sits would write through it; it is refused the same way.
    await expect(directory.getFileHandle("secret-link.md", { create: true })).rejects.toThrow();
    expect(await readFile(path.join(outside, "secret.md"), "utf8")).toBe("secret");
  });

  test("a snapshot refuses to read a file that changed after it was taken, like Chromium", async () => {
    const root = await tempFolder();
    const file = path.join(root, "Note.md");
    await writeFile(file, "one");
    const directory = await openNodeVaultDirectory(root);
    const handle = await directory.getFileHandle("Note.md");
    const snapshot = await handle.getFile();
    await writeFile(file, "two, longer");
    await expect(snapshot.text()).rejects.toMatchObject({ name: "InvalidStateError" });
    // A fresh snapshot reads the new bytes.
    expect(await (await handle.getFile()).text()).toBe("two, longer");
    await rm(file);
    await expect((await directory.getFileHandle("Note.md").catch((error) => error))).toMatchObject({ name: "NotFoundError" });
  });

  test("writes replace the file atomically and leave no temp file behind, and an aborted write changes nothing", async () => {
    const root = await tempFolder();
    const written: string[] = [];
    const directory = await openNodeVaultDirectory(root, { onWritten: (vaultPath) => written.push(vaultPath) });
    await writeVaultFile(directory, "Projects/Plan.md", "first");
    expect(await readVaultText(directory, "Projects/Plan.md")).toBe("first");
    expect(await readVaultText(directory, "Projects/Missing.md")).toBeNull();
    const handle = await (await directory.getDirectoryHandle("Projects")).getFileHandle("Plan.md");
    const writer = await handle.createWritable();
    await writer.write("second ");
    await writer.write(new TextEncoder().encode("half"));
    await writer.close();
    expect(await readFile(path.join(root, "Projects", "Plan.md"), "utf8")).toBe("second half");
    const aborted = await handle.createWritable();
    await aborted.write("never");
    await aborted.abort();
    expect(await readFile(path.join(root, "Projects", "Plan.md"), "utf8")).toBe("second half");
    expect((await readdir(path.join(root, "Projects"))).filter((name) => name.startsWith(TEMP_FILE_PREFIX))).toEqual([]);
    expect(written).toEqual(["Projects/Plan.md", "Projects/Plan.md"]);
    const info = await stat(path.join(root, "Projects", "Plan.md"));
    expect(info.isFile()).toBe(true);
  });

  test("a rename over a file another program holds is retried on Windows and reported when it keeps failing", async () => {
    const root = await tempFolder();
    const target = path.join(root, "Busy.md");
    await writeFile(target, "old");
    const waits: number[] = [];
    // Windows refuses to replace a file another program has open, with EPERM, until it is closed.
    let refusals = 0;
    const busyRename = async () => { refusals += 1; throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); };
    const error = await replaceAtomically(target, new TextEncoder().encode("new"), { platform: "win32", wait: async (ms) => { waits.push(ms); }, renameImpl: busyRename }).catch((e) => e);
    expect(error).toBeInstanceOf(TargetBusyError);
    expect(error.message).toContain("Busy.md");
    expect(refusals).toBe(6);
    expect(waits.length).toBe(5);
    expect(waits[1]).toBe(waits[0] * 2);
    expect(await readFile(target, "utf8")).toBe("old");
    expect((await readdir(root)).filter((name) => name.startsWith(TEMP_FILE_PREFIX))).toEqual([]);
    // Off Windows the first refusal is final, still with no temp file left.
    refusals = 0;
    const direct = await replaceAtomically(target, new TextEncoder().encode("new"), { platform: "linux", renameImpl: busyRename }).catch((e) => e);
    expect(direct).toBeInstanceOf(TargetBusyError);
    expect(refusals).toBe(1);
    expect((await readdir(root)).filter((name) => name.startsWith(TEMP_FILE_PREFIX))).toEqual([]);
    expect(await readFile(target, "utf8")).toBe("old");
    // Once the other program lets go, the same write goes through.
    let attempts = 0;
    const { rename: realRename } = await import("node:fs/promises");
    await replaceAtomically(target, new TextEncoder().encode("new"), { platform: "win32", wait: async () => undefined,
      renameImpl: async (from, to) => { if (attempts++ < 2) return busyRename(); return realRename(from, to); } });
    expect(await readFile(target, "utf8")).toBe("new");
  });

  test("the folder's availability is checked before it is read, so a missing folder is never an empty one", async () => {
    const root = await tempFolder();
    expect(await nodeFolderAvailability(root)).toBe("available");
    expect(await nodeFolderAvailability(path.join(root, "gone"))).toBe("missing");
    await writeFile(path.join(root, "file"), "x");
    expect(await nodeFolderAvailability(path.join(root, "file"))).toBe("missing");
    await expect(openNodeVaultDirectory(path.join(root, "gone"))).rejects.toThrow();
  });
});

describe("the folder code written for browser handles runs unchanged on a real folder", () => {
  test("scan, write, companions and preview work through the node adapter", async () => {
    const root = await tempFolder();
    const directory = asFileSystemDirectoryHandle(await openNodeVaultDirectory(root));
    await writeFile(path.join(root, "Plain note.md"), "# Plain note\n\nDropped in from Finder.\n");
    await mkdir(path.join(root, "Papers"));
    await writeFile(path.join(root, "Papers", "paper.pdf"), "%PDF-1.4 fake");
    await writeFile(path.join(root, ".DS_Store"), "noise");
    await writeFile(path.join(root, "notes.txt"), "unsupported");

    const preview = await previewLocalDirectory(directory);
    expect(preview).toMatchObject({ markdownFiles: 1, otherFiles: 2, complete: true });

    const read = await readDirectoryWorkspace(directory, "jon");
    expect(Object.keys(read.workspace.files)).toEqual(["Plain note.md"]);
    expect(read.stats["Plain note.md"]).toBeUndefined(); // just written: too recent to trust size+date alone
    expect(read.workspace.manifest.files[0].id).toBeTruthy();

    const listing = await listConnectedDirectoryFiles(directory);
    expect(listing.map((file) => file.path)).toEqual(["Papers/paper.pdf"]);
    const companions = await readConnectedDirectoryCompanions(directory, undefined, listing);
    expect(Object.keys(companions.files)).toEqual(["Papers/paper.pdf"]);
    expect(companions.files["Papers/paper.pdf"].encoding).toBe("base64");

    // Writing the app's version of the workspace back: the identity header lands, other files stay.
    const state = parseMarkdownWorkspace(read.workspace.manifest, read.workspace.files)!;
    const workspace = createMarkdownWorkspace(state, new Date().toISOString(), read.workspace);
    await writeConnectedDirectoryWorkspace(directory, "jon", workspace, read.workspace);
    expect(await names(root)).toEqual([".DS_Store", "Papers", "Plain note.md", "margin-chat-workspace-jon.json", "notes.txt"]);
    // Identity headers are added by the vault engine when it imports the folder, not by the folder write itself.
    expect(await readFile(path.join(root, "Plain note.md"), "utf8")).toBe("# Plain note\n\nDropped in from Finder.\n");
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("unsupported");

    const next = { ...companions.files, ".margin-chat/trash/k1/deleted.json": { content: "{}", contentType: "application/json" } };
    const synced = await syncConnectedDirectoryCompanions(directory, next, companions.files);
    expect(Object.keys(synced.files).sort()).toEqual([".margin-chat/trash/k1/deleted.json", "Papers/paper.pdf"]);
    expect(await readFile(path.join(root, ".margin-chat", "trash", "k1", "deleted.json"), "utf8")).toBe("{}");

    const signature = await localDirectorySignature(directory);
    expect(signature.split("\n").map((line) => line.split("\t")[0])).toEqual(["Papers/paper.pdf", "Plain note.md"]);

    const created = await createVaultFolder(directory, "New vault");
    expect(created.name).toBe("New vault");
    expect(await names(root)).toContain("New vault");
    await expect(createVaultFolder(directory, "Papers")).rejects.toThrow("already a folder");
  });

  test("the DOM error helper recognizes the adapter's errors", async () => {
    const root = await tempFolder();
    const directory = await openNodeVaultDirectory(root);
    const error = await directory.getFileHandle("nope").catch((e) => e);
    expect(isDomErrorNamed(error, "NotFoundError")).toBe(true);
    expect(isDomErrorNamed(error, "TypeMismatchError")).toBe(false);
  });
});
