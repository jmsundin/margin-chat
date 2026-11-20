import { describe, expect, test } from "bun:test";
import { createMemoryVaultFs, evictedFileName, evictedPlaceholderPath, isIgnoredVaultPath, type VaultFs } from "@margin-chat/vault-sync";
import { isIgnoredVaultPath as isIgnoredByWatcher } from "../desktop/vaultWatcher.mjs";
import { nodeVaultFs } from "../desktop/vaultFs.mjs";
import {
  LocalDirectoryConflictError, readConnectedDirectoryCompanions, readDirectoryWorkspace, syncConnectedDirectoryCompanions,
  writeConnectedDirectoryWorkspace,
} from "../client/src/lib/workspaceStorage";

// A vault folder kept in iCloud Drive or Google Drive (docs/desktop-local-mode.md, "iCloud Drive and Google Drive").

/** A folder whose files were saved a minute ago, so what is read now is remembered by size and date. */
function cloudFolder(initial: Record<string, string>) {
  const fs = createMemoryVaultFs(initial, { now: () => Date.now() - 60_000 });
  const downloads: string[] = [];
  const folder: VaultFs = Object.assign(fs, { download: async (path: string) => { downloads.push(path); } });
  /** What "Optimize Mac Storage" does to a file before macOS Sonoma. */
  const evict = (path: string) => {
    fs.files.delete(path);
    fs.put(evictedPlaceholderPath(path), "", Date.now() - 60_000);
  };
  return { fs, folder, downloads, evict };
}

describe("iCloud placeholders", () => {
  test("names", () => {
    expect(evictedFileName(".Note.md.icloud")).toBe("Note.md");
    expect(evictedFileName(".photo.png.icloud")).toBe("photo.png");
    expect(evictedFileName("Note.md")).toBeNull();
    expect(evictedPlaceholderPath("Notes/Note.md")).toBe("Notes/.Note.md.icloud");
    expect(evictedPlaceholderPath("Note.md")).toBe(".Note.md.icloud");
  });

  test("a note kept only in iCloud is still there, with the text it was last read with", async () => {
    const { folder, downloads, evict } = cloudFolder({ "Notes/a.md": "# A\n\nKept in iCloud.\n", "b.md": "# B\n" });
    const first = await readDirectoryWorkspace(folder, "u1");
    expect(first.workspace.files["Notes/a.md"]).toContain("Kept in iCloud.");

    evict("Notes/a.md");
    const again = await readDirectoryWorkspace(folder, "u1", first.workspace.manifest, first.workspace.files, first.stats);
    expect(again.workspace.files["Notes/a.md"]).toBe(first.workspace.files["Notes/a.md"]);
    expect(again.workspace.files["b.md"]).toBe(first.workspace.files["b.md"]);
    // Only the notes it needs are brought back; this one is left in the cloud.
    expect(downloads).toEqual([]);
  });

  test("a note never read here is asked for, not taken in empty", async () => {
    const { folder, downloads, evict } = cloudFolder({ "a.md": "# A\n", "b.md": "# B\n" });
    evict("a.md");
    const read = await readDirectoryWorkspace(folder, "u1");
    expect(Object.keys(read.workspace.files)).not.toContain("a.md");
    expect(Object.keys(read.workspace.files)).not.toContain(".a.md.icloud");
    expect(downloads).toEqual(["a.md"]);
  });

  test("changing a note kept only in iCloud waits for it to come back; other notes still change", async () => {
    const { fs, folder, downloads, evict } = cloudFolder({ "a.md": "# A\n", "b.md": "# B\n" });
    const first = await readDirectoryWorkspace(folder, "u1");
    evict("a.md");

    const editB = { ...first.workspace, files: { ...first.workspace.files, "b.md": "# B\n\nEdited.\n" } };
    const stats = await writeConnectedDirectoryWorkspace(folder, "u1", editB, first.workspace, first.stats);
    expect(new TextDecoder().decode(fs.files.get("b.md")!.bytes)).toContain("Edited.");
    // The placeholder is left alone and no second copy of a.md appears beside it.
    expect(fs.files.has("a.md")).toBe(false);
    expect(fs.files.has(".a.md.icloud")).toBe(true);
    expect(downloads).toEqual([]);

    const editA = { ...editB, files: { ...editB.files, "a.md": "# A\n\nEdited.\n" } };
    await expect(writeConnectedDirectoryWorkspace(folder, "u1", editA, editB, stats)).rejects.toBeInstanceOf(LocalDirectoryConflictError);
    expect(fs.files.has("a.md")).toBe(false);
    expect(downloads).toEqual(["a.md"]);

    const removeA = { ...editB, files: Object.fromEntries(Object.entries(editB.files).filter(([path]) => path !== "a.md")) };
    await expect(writeConnectedDirectoryWorkspace(folder, "u1", removeA, editB, stats)).rejects.toBeInstanceOf(LocalDirectoryConflictError);
    expect(fs.files.has(".a.md.icloud")).toBe(true);
  });

  test("an image kept only in iCloud stays in the vault, and its placeholder is never synced", async () => {
    const { fs, folder, downloads, evict } = cloudFolder({ "a.md": "# A\n", "attachments/pic.png": "PNGBYTES", "photo.png": "PNG2" });
    const first = await readConnectedDirectoryCompanions(folder);
    expect(Object.keys(first.files).sort()).toEqual(["attachments/pic.png", "photo.png"]);

    evict("attachments/pic.png");
    evict("photo.png");
    const again = await readConnectedDirectoryCompanions(folder, first.files, undefined, first.stats);
    expect(Object.keys(again.files).sort()).toEqual(["attachments/pic.png", "photo.png"]);
    expect(again.files["attachments/pic.png"]).toEqual(first.files["attachments/pic.png"]);

    // Writing the vault back leaves them as they are.
    const written = await syncConnectedDirectoryCompanions(folder, first.files, first.files, first.stats);
    expect(Object.keys(written.files).sort()).toEqual(["attachments/pic.png", "photo.png"]);
    expect(fs.files.has("attachments/pic.png")).toBe(false);
    expect(downloads).toEqual([]);

    // Changing one asks for it back first.
    const changed = { ...first.files, "photo.png": { ...first.files["photo.png"], content: btoa("NEW") } };
    await expect(syncConnectedDirectoryCompanions(folder, changed, first.files, first.stats)).rejects.toBeInstanceOf(LocalDirectoryConflictError);
    expect(downloads).toEqual(["photo.png"]);
  });
});

describe("Google Drive and other sync apps", () => {
  test("their transfers in progress are never vault content, in the scan and the watcher alike", () => {
    for (const path of [".tmp.drivedownload/123.md", ".tmp.driveupload/9", "Notes/.tmp.drivedownload/x.md", ".dropbox.cache/a.md", "Notes/.a.md.icloud"]) {
      expect(isIgnoredVaultPath(path)).toBe(true);
      expect(isIgnoredByWatcher(path)).toBe(true);
    }
    // Conflict copies are kept as notes of their own, so nothing is lost.
    for (const path of ["Note 2.md", "Note (1).md", "Note (conflicted copy).md"]) {
      expect(isIgnoredVaultPath(path)).toBe(false);
      expect(isIgnoredByWatcher(path)).toBe(false);
    }
  });
});

describe("asking iCloud for a file", () => {
  test("uses brctl on macOS only", async () => {
    const runs: string[][] = [];
    const runCommand = async (command: string, args: string[]) => { runs.push([command, ...args]); };
    await nodeVaultFs("/vault", { platform: "darwin", runCommand }).download("Notes/a.md");
    await nodeVaultFs("/vault", { platform: "linux", runCommand }).download("Notes/a.md");
    expect(runs).toEqual([["/usr/bin/brctl", "download", "/vault/Notes/a.md"]]);
  });
});
