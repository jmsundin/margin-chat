import { expect, test } from "bun:test";
import {
  createVaultFolder, describeFolderPreview, formatFolderSize, isLargeFolder, isVaultFolderPromptSnoozed, LARGE_FOLDER_BYTES, LARGE_FOLDER_FILES,
  previewLocalDirectory, saveVaultFolderPromptSnooze, VaultFolderExistsError, vaultFolderPrompt,
} from "../client/src/lib/desktopVault";
import { isDesktopApp } from "../client/src/lib/platform";

const ELECTRON = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) margin-chat-desktop/0.1.0 Chrome/146.0.0.0 Electron/44.7.0 Safari/537.36";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

/** A folder in memory. A file's contents are never read by the code under test, only its size. */
function folder(name: string, tree: Record<string, any> = {}): any {
  const entries = new Map<string, any>();
  const handle: any = {
    name, kind: "directory", reads: 0,
    async *entries() { yield* entries.entries(); },
    async getDirectoryHandle(child: string, options: { create?: boolean } = {}) {
      const entry = entries.get(child);
      if (entry?.kind === "file") throw new DOMException("A file is in the way", "TypeMismatchError");
      if (entry) return entry;
      if (!options.create) throw new DOMException("Missing", "NotFoundError");
      const created = folder(child);
      entries.set(child, created);
      return created;
    },
  };
  for (const [child, value] of Object.entries(tree)) {
    entries.set(child, typeof value === "number" ? {
      name: child, kind: "file",
      getFile: async () => ({ size: value, text: () => { handle.reads++; throw new Error("read"); }, arrayBuffer: () => { handle.reads++; throw new Error("read"); } }),
    } : folder(child, value));
  }
  return handle;
}
const childNames = async (handle: any) => { const names: string[] = []; for await (const [name] of handle.entries()) names.push(name); return names.sort(); };

test("the desktop app is recognized by its margin: pages or its Electron user agent", () => {
  expect(isDesktopApp({ protocol: "margin:" }, CHROME)).toBe(true);
  expect(isDesktopApp({ protocol: "http:" }, ELECTRON)).toBe(true);
  expect(isDesktopApp(undefined, ELECTRON)).toBe(true);
  expect(isDesktopApp({ protocol: "https:" }, CHROME)).toBe(false);
  expect(isDesktopApp({ protocol: "https:" }, "Mozilla/5.0 Electron/")).toBe(false);
  expect(isDesktopApp({ protocol: "https:" }, "Mozilla/5.0 NotElectron/1.0")).toBe(false);
  expect(isDesktopApp(undefined, "")).toBe(false);
});

test("the vault folder prompt asks to choose, allow or find a folder only on desktop, once the vault is open", () => {
  const status = (directoryName: string | null, permission: any = "granted", supported = true) => ({ directoryName, permission, supported });
  const prompt = (overrides: Partial<Parameters<typeof vaultFolderPrompt>[0]> = {}) => vaultFolderPrompt({
    desktop: true, ready: true, snoozed: false, status: status(null, "unselected"), unavailable: false, ...overrides,
  });
  expect(prompt()).toBe("choose");
  expect(prompt({ desktop: false })).toBeNull();
  expect(prompt({ ready: false })).toBeNull();
  expect(prompt({ snoozed: true })).toBeNull();
  expect(prompt({ status: status(null, "unsupported", false) })).toBeNull();
  expect(prompt({ status: status("Notes") })).toBeNull();
  // An older desktop app without the permission check handler forgets access at each launch.
  expect(prompt({ status: status("Notes", "prompt") })).toBe("allow");
  expect(prompt({ status: status("Notes", "denied") })).toBe("allow");
  // A folder that can't be opened is never treated as empty, whatever its permission says.
  expect(prompt({ status: status("Notes"), unavailable: true })).toBe("missing");
  expect(prompt({ status: status("Notes", "prompt"), unavailable: true })).toBe("missing");
  expect(prompt({ status: status("Notes"), unavailable: true, snoozed: true })).toBeNull();
  expect(prompt({ status: status("Notes"), unavailable: true, desktop: false })).toBeNull();
});

test("Not now is remembered per account for this run of the app, and missing storage never breaks it", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
  expect(isVaultFolderPromptSnoozed("ada", storage)).toBe(false);
  saveVaultFolderPromptSnooze("ada", storage);
  expect(isVaultFolderPromptSnoozed("ada", storage)).toBe(true);
  expect(isVaultFolderPromptSnoozed("grace", storage)).toBe(false);
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } as unknown as Storage;
  expect(() => saveVaultFolderPromptSnooze("ada", broken)).not.toThrow();
  expect(isVaultFolderPromptSnoozed("ada", broken)).toBe(false);
  expect(isVaultFolderPromptSnoozed("ada", null)).toBe(false);
});

test("a new vault gets its own folder, and a folder that already holds files is never used as a new vault", async () => {
  const parent = folder("Documents", {
    "Empty": {}, "Only system files": { ".DS_Store": 6148 }, "Journal": { "Today.md": 120 }, "Margin Chat.txt": 4,
  });
  const created = await createVaultFolder(parent, "  Margin Chat  ");
  expect(created.name).toBe("Margin Chat");
  expect(await childNames(parent)).toContain("Margin Chat");
  expect(await childNames(created)).toEqual([]);
  // Asking again for the same, still empty, folder uses it.
  expect(await createVaultFolder(parent, "Margin Chat")).toBe(created);
  expect(await createVaultFolder(parent, "Empty")).toBe(await parent.getDirectoryHandle("Empty"));
  expect(await createVaultFolder(parent, "Only system files")).toBe(await parent.getDirectoryHandle("Only system files"));

  const journal = await parent.getDirectoryHandle("Journal");
  const refused = await createVaultFolder(parent, "Journal").catch((error) => error);
  expect(refused).toBeInstanceOf(VaultFolderExistsError);
  expect(refused.handle).toBe(journal);
  expect(refused.message).toContain("“Journal”");
  expect(refused.message).toContain("Open it instead");
  expect(await childNames(journal)).toEqual(["Today.md"]);

  await expect(createVaultFolder(parent, "Margin Chat.txt")).rejects.toThrow("There’s already a file named “Margin Chat.txt” there.");
  await expect(createVaultFolder(parent, "   ")).rejects.toThrow("Give your vault a name.");
  for (const name of ["Work/Notes", "Work\\Notes", "Notes?", "a:b"]) await expect(createVaultFolder(parent, name)).rejects.toThrow("can’t contain");
  for (const name of [".vault", "Notes."]) await expect(createVaultFolder(parent, name)).rejects.toThrow("dot");
  await expect(createVaultFolder(parent, "CON")).rejects.toThrow("can’t be used as a folder name");
  await expect(createVaultFolder(parent, "x".repeat(101))).rejects.toThrow("shorter name");
  expect((await childNames(parent)).sort()).toEqual(["Empty", "Journal", "Margin Chat", "Margin Chat.txt", "Only system files"]);
});

test("a folder is counted before it is opened, skipping what the folder watcher skips, without reading any file", async () => {
  const handle = folder("Notes", {
    "Inbox.md": 100, "Plan.MD": 50, "scan.pdf": 2000, "photo.jpg": 3000, "letter.docx": 400,
    Projects: { "Launch.md": 70, Assets: { "diagram.png": 1000 }, attachments: { "kept.md": 5 } },
    ".obsidian": { "app.json": 10 }, ".DS_Store": 6148, "_conflicts": { "old.md": 9 }, Attachments: { "doc.pdf": 9000 },
    ".margin-chat": { history: { "x.md": 9 } },
  });
  const preview = await previewLocalDirectory(handle);
  expect(preview).toEqual({ markdownFiles: 4, otherFiles: 4, totalBytes: 100 + 50 + 2000 + 3000 + 400 + 70 + 1000 + 5, complete: true });
  expect(handle.reads).toBe(0);
  expect(isLargeFolder(preview)).toBe(false);
  expect(describeFolderPreview(preview)).toBe("4 notes and 4 other files (6.5 KB)");
  expect(describeFolderPreview({ markdownFiles: 1, otherFiles: 0, totalBytes: 12, complete: true })).toBe("1 note (12 bytes)");
  expect(describeFolderPreview({ markdownFiles: 0, otherFiles: 2, totalBytes: 0, complete: true })).toBe("2 files (0 bytes)");
  expect(describeFolderPreview({ markdownFiles: 0, otherFiles: 0, totalBytes: 0, complete: true })).toBe("no files yet");

  // Counting stops once the folder clearly holds more than the limit.
  const crowded = await previewLocalDirectory(handle, 3);
  expect(crowded.complete).toBe(false);
  expect(crowded.markdownFiles + crowded.otherFiles).toBe(3);
  expect(isLargeFolder(crowded)).toBe(true);
  expect(describeFolderPreview(crowded)).toBe("more than 3 files");

  const many = folder("Everything", Object.fromEntries(Array.from({ length: LARGE_FOLDER_FILES + 1 }, (_, index) => [`note-${index}.md`, 1])));
  const counted = await previewLocalDirectory(many);
  expect(counted.complete).toBe(false);
  expect(isLargeFolder(counted)).toBe(true);
  expect(describeFolderPreview(counted)).toBe("more than 5,000 files");
  const exactly = folder("Exactly", Object.fromEntries(Array.from({ length: LARGE_FOLDER_FILES }, (_, index) => [`note-${index}.md`, 1])));
  expect(isLargeFolder(await previewLocalDirectory(exactly))).toBe(false);

  const heavy = await previewLocalDirectory(folder("Videos", { "film.mp4": LARGE_FOLDER_BYTES + 1, "notes.md": 10 }));
  expect(isLargeFolder(heavy)).toBe(true);
  expect(describeFolderPreview(heavy)).toBe("1 note and 1 other file (2 GB)");
  expect(isLargeFolder(await previewLocalDirectory(folder("Fine", { "film.mp4": LARGE_FOLDER_BYTES })))).toBe(false);
});

test("folder sizes read plainly", () => {
  expect(formatFolderSize(0)).toBe("0 bytes");
  expect(formatFolderSize(1)).toBe("1 byte");
  expect(formatFolderSize(1536)).toBe("1.5 KB");
  expect(formatFolderSize(10 * 1024)).toBe("10 KB");
  expect(formatFolderSize(3.25 * 1024 ** 3)).toBe("3.3 GB");
  expect(formatFolderSize(250 * 1024 ** 2)).toBe("250 MB");
});
