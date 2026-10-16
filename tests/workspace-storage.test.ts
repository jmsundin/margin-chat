import { describe, expect, test } from "bun:test";
import { createEmptyState } from "../client/src/initialState";
import {
  areWorkspaceStatesEqual,
  canSyncWorkspaceToCloud,
  createLocalWorkspaceRecord,
  isRecoverableCloudSyncError,
  parseLocalWorkspaceRecord,
  readDirectoryWorkspace,
  writeConnectedDirectoryWorkspace,
  LocalDirectoryConflictError,
  getLocalWorkspaceFileName,
  readConnectedDirectoryCompanions,
  syncConnectedDirectoryCompanions,
  localDirectorySignature,
  listConnectedDirectoryFiles,
  writeConnectedDirectory,
} from "../client/src/lib/workspaceStorage";
import { createMarkdownWorkspace, discoverMarkdownWorkspace, parseMarkdownWorkspace, type MarkdownWorkspace } from "../client/src/lib/workspaceMarkdown";
import type { DirectoryStats, VaultFile } from "../client/src/lib/vaultTypes";
import { ApiError } from "../client/src/lib/api";
import type {
  AuthenticatedUser,
  BillingAccessKind,
} from "../client/src/types";
import { canUseCloudWorkspaceStorage } from "../server/routes/api.mjs";

function user(
  accessKind: BillingAccessKind,
  role: AuthenticatedUser["role"] = "member",
): AuthenticatedUser {
  return {
    apiKeys: {
      byProvider: {
        gemini: { configured: false, hint: null },
        huggingface: { configured: false, hint: null },
        openai: { configured: false, hint: null },
        xai: { configured: false, hint: null },
      },
      hasAny: false,
    },
    billing: {
      accessKind,
      cancelAtPeriodEnd: false,
      creditBalanceMicros: 0,
      currentPeriodEnd: null,
      hasAccess: accessKind !== "none",
      hasCustomer: false,
      priceId: null,
      status: accessKind === "subscription" ? "active" : "inactive",
      trialCallsLimit: 100,
      trialCallsRemaining: accessKind === "trial" ? 100 : 0,
      trialCallsUsed: 0,
    },
    displayName: "Storage Test",
    email: "storage@example.test",
    id: "storage-user",
    role,
  };
}

describe("workspace storage policy", () => {
  test("allows cloud workspace copies only for paid plans and admins", () => {
    expect(canSyncWorkspaceToCloud(user("subscription"))).toBe(true);
    expect(canSyncWorkspaceToCloud(user("none", "admin"))).toBe(true);
    expect(canSyncWorkspaceToCloud(user("trial"))).toBe(false);
    expect(canSyncWorkspaceToCloud(user("credits"))).toBe(false);

    expect(canUseCloudWorkspaceStorage(user("subscription"))).toBe(true);
    expect(canUseCloudWorkspaceStorage(user("none", "admin"))).toBe(true);
    expect(canUseCloudWorkspaceStorage(user("trial"))).toBe(false);
  });

  test("compares cloud and local state without depending on object key order", () => {
    const state = createEmptyState();
    const reorderedState = {
      ...state,
      conversations: Object.fromEntries(
        Object.entries(state.conversations).reverse(),
      ),
    };

    expect(areWorkspaceStatesEqual(state, reorderedState)).toBe(true);
    expect(
      areWorkspaceStatesEqual(state, {
        ...reorderedState,
        railOpen: !reorderedState.railOpen,
      }),
    ).toBe(false);
  });

  test("ignores derived child lists and server-applied entity defaults", () => {
    const state = createEmptyState();
    const root = state.conversations[state.rootId];
    const serverState = {
      ...state,
      conversations: {
        ...state.conversations,
        [root.id]: {
          ...root,
          childIds: ["derived-on-another-layer"],
          kind: "chat" as const,
        },
      },
    };
    const localState = {
      ...state,
      conversations: {
        ...state.conversations,
        [root.id]: {
          ...root,
          kind: undefined,
        },
      },
    };

    expect(areWorkspaceStatesEqual(localState, serverState)).toBe(true);
  });

  test("round-trips the timestamped local directory record", () => {
    const state = createEmptyState();
    const savedAt = "2026-08-14T14:00:00.000Z";
    const record = createLocalWorkspaceRecord(state, savedAt);

    expect(parseLocalWorkspaceRecord(JSON.parse(JSON.stringify(record)))).toEqual(
      record,
    );
    expect(parseLocalWorkspaceRecord({ savedAt: "not-a-date", state })).toBeNull();
  });

  test("treats network and server outages as recoverable cloud failures", () => {
    expect(isRecoverableCloudSyncError(new TypeError("Failed to fetch"))).toBe(
      true,
    );
    expect(isRecoverableCloudSyncError(new ApiError(503, "Unavailable"))).toBe(
      true,
    );
    expect(isRecoverableCloudSyncError(new ApiError(400, "Invalid state"))).toBe(
      false,
    );
  });
});

function memoryDirectory(initial: Record<string, string | Uint8Array>) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  function missing() { const error = new Error("Missing"); error.name = "NotFoundError"; return error; }
  function directory(prefix = ""): FileSystemDirectoryHandle {
    return {
      kind: "directory", name: prefix || "vault",
      async *entries() {
        const names = new Set([...files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split("/")[0]));
        for (const name of names) {
          const path = prefix + name;
          yield [name, files.has(path) ? fileHandle(path) : directory(`${path}/`)];
        }
      },
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const path = `${prefix}${name}/`;
        if (!options?.create && ![...files.keys()].some((file) => file.startsWith(path))) throw missing();
        return directory(path);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const path = prefix + name;
        if (!files.has(path) && !options?.create) throw missing();
        return fileHandle(path);
      },
      async removeEntry(name: string) { if (!files.delete(prefix + name)) throw missing(); writes.push(prefix + name); },
    } as unknown as FileSystemDirectoryHandle;
  }
  function fileHandle(path: string): FileSystemFileHandle {
    return {
      kind: "file", name: path.split("/").at(-1),
      async getFile() { if (!files.has(path)) throw missing(); return new File([files.get(path)!], path, { lastModified: 123 }); },
      async createWritable() {
        return { async write(content: string | ArrayBuffer) { files.set(path, typeof content === "string" ? content : new Uint8Array(content)); writes.push(path); }, async close() {}, async abort() {} };
      },
    } as unknown as FileSystemFileHandle;
  }
  return { handle: directory(), files, writes };
}

describe("connected folder safety", () => {
  test("imports an external addition and rename and recognizes a deletion", async () => {
    const first = discoverMarkdownWorkspace({ "First.md": "Original content." });
    const folder = memoryDirectory({ ...first.files, [getLocalWorkspaceFileName("user")]: JSON.stringify(first.manifest) });
    folder.files.delete("First.md");
    folder.files.set("Renamed.md", "Original content.");
    folder.files.set("Another.md", "# Another note");
    const read = await readDirectoryWorkspace(folder.handle, "user", first.manifest, first.files);
    expect(read.workspace.manifest.files.find((file) => file.path === "Renamed.md")?.id).toBe(first.manifest.files[0].id);
    expect(read.workspace.manifest.files.some((file) => file.path === "First.md")).toBe(false);
    expect(read.workspace.manifest.files).toHaveLength(2);
  });

  test("refuses to overwrite edits made by another editor after the last read", async () => {
    const original = discoverMarkdownWorkspace({ "Note.md": "Original content." });
    const folder = memoryDirectory({ ...original.files, [getLocalWorkspaceFileName("user")]: JSON.stringify(original.manifest) });
    const state = parseMarkdownWorkspace(original.manifest, original.files)!;
    state.conversations[original.manifest.files[0].id].notes![0].content = "Application change.";
    const desired = createMarkdownWorkspace(state, undefined, original);
    folder.files.set("Note.md", "External change.");
    await expect(writeConnectedDirectoryWorkspace(folder.handle, "user", desired, original)).rejects.toBeInstanceOf(LocalDirectoryConflictError);
    expect(folder.files.get("Note.md")).toBe("External change.");
    expect(folder.writes).toHaveLength(0);
  });

  test("refuses to recreate a file deleted by another editor after the last read", async () => {
    const original = discoverMarkdownWorkspace({ "Note.md": "Original content." });
    const folder = memoryDirectory(original.files);
    folder.files.delete("Note.md");
    await expect(writeConnectedDirectoryWorkspace(folder.handle, "user", original, original)).rejects.toBeInstanceOf(LocalDirectoryConflictError);
    expect(folder.files.has("Note.md")).toBe(false);
  });

  test("writes only changed Markdown and preserves unrelated plain files", async () => {
    const original = discoverMarkdownWorkspace({ "One.md": "First.", "Two.md": "Second." });
    const folder = memoryDirectory({ ...original.files, [getLocalWorkspaceFileName("user")]: JSON.stringify(original.manifest) });
    const state = parseMarkdownWorkspace(original.manifest, original.files)!;
    state.conversations[original.manifest.files.find((file) => file.path === "One.md")!.id].notes![0].content = "Changed.";
    const desired = createMarkdownWorkspace(state, undefined, original);
    await writeConnectedDirectoryWorkspace(folder.handle, "user", desired, original);
    expect(folder.writes).toContain("One.md");
    expect(folder.writes).not.toContain("Two.md");
    expect(folder.files.get("Two.md")).toBe("Second.");
  });

  test("migrates a previously observed JSON-only folder without losing its content", async () => {
    const legacy = createLocalWorkspaceRecord(createEmptyState(), "2026-09-01T00:00:00.000Z");
    const folder = memoryDirectory({ [getLocalWorkspaceFileName("user")]: JSON.stringify(legacy) });
    const read = await readDirectoryWorkspace(folder.handle, "user");
    await writeConnectedDirectoryWorkspace(folder.handle, "user", read.workspace, read.workspace);
    expect([...folder.files.keys()].some((path) => path.endsWith(".md"))).toBe(true);
    const after = await readDirectoryWorkspace(folder.handle, "user");
    expect(areWorkspaceStatesEqual(parseMarkdownWorkspace(after.workspace.manifest, after.workspace.files)!, legacy.state)).toBe(true);
  });
});

describe("watching the connected folder", () => {
  test("a new or edited Markdown file changes the folder signature; attachments and hidden files do not", async () => {
    const folder = memoryDirectory({ "One.md": "First.", "Notes/Two.md": "Second." });
    const before = await localDirectorySignature(folder.handle);
    folder.files.set("Attachments/picture.png", new Uint8Array([1, 2, 3]));
    folder.files.set(".obsidian/workspace.json", "{}");
    folder.files.set("_conflicts/One.md", "Old.");
    expect(await localDirectorySignature(folder.handle)).toBe(before);
    folder.files.set("Three.md", "Added in another app.");
    const added = await localDirectorySignature(folder.handle);
    expect(added).not.toBe(before);
    expect(added).toContain("Three.md");
    folder.files.set("Notes/Two.md", "Second, edited elsewhere.");
    expect(await localDirectorySignature(folder.handle)).not.toBe(added);
  });
});

describe("portable folder companions", () => {
  test("keeps hidden recovery history out of documents while synchronizing it as companions", async () => {
    const original = createMarkdownWorkspace(createEmptyState());
    const livePath = original.manifest.files[0].path;
    const history = ".margin-chat/history/merge/result/Previous title.md";
    const binary = ".margin-chat/history/merge/base/Previous title.md";
    const descriptor = ".margin-chat/history/merge/conflict.json";
    const folder = memoryDirectory({ ...original.files,
      [history]: original.files[livePath], [binary]: new Uint8Array([255, 0]),
      [descriptor]: JSON.stringify({ path: livePath, baseCopy: binary, baseEncoding: "base64" }),
    });
    const workspace = await readDirectoryWorkspace(folder.handle, "user");
    expect(workspace.workspace.manifest.files.map((record) => record.path)).toEqual([livePath]);
    expect(workspace.workspace.files[history]).toBeUndefined();
    const { files: companions } = await readConnectedDirectoryCompanions(folder.handle);
    expect(companions[history].content).toBe(original.files[livePath]);
    expect(companions[binary]).toEqual({ content: "/wA=", encoding: "base64" });
    expect(companions[descriptor]).toBeDefined();
  });

  test("discovers only managed attachments/conflicts/settings and keeps Markdown attachments binary", async () => {
    const folder = memoryDirectory({
      "Attachments/doc/original.md": new Uint8Array([35, 32, 83, 111, 117, 114, 99, 101]),
      "Attachments/doc/metadata.json": '{"id":"doc"}',
      "_conflicts/offline/Note.md": "Offline note.",
      "workspace.json": '{"settings":"portable"}',
      "Private/unrelated.bin": new Uint8Array([255, 254]),
      "Unrelated.txt": "Keep untouched.",
    });
    const { files } = await readConnectedDirectoryCompanions(folder.handle);
    expect(Object.keys(files).sort()).toEqual(["Attachments/doc/metadata.json", "Attachments/doc/original.md", "_conflicts/offline/Note.md", "workspace.json"]);
    expect(files["Attachments/doc/original.md"]).toEqual({ content: "IyBTb3VyY2U=", encoding: "base64" });
    expect(files["_conflicts/offline/Note.md"].content).toBe("Offline note.");
    expect(folder.writes).toHaveLength(0);
  });

  test("writes binary originals and portable settings without touching other paths", async () => {
    const folder = memoryDirectory({ "Other/file.bin": new Uint8Array([99]), "Notes/existing.md": "Keep note." });
    const next = {
      "Attachments/id/file.bin": { content: "AP+AQA==", encoding: "base64" as const },
      "_conflicts/offline/Note.md": { content: "Conflict copy." },
      "workspace.json": { content: '{"files":[]}' },
      "Other/file.bin": { content: "unrelated input ignored" },
      "Notes/existing.md": { content: "unrelated input ignored" },
    };
    const { files: synced } = await syncConnectedDirectoryCompanions(folder.handle, next, {});
    expect(folder.files.get("Attachments/id/file.bin")).toEqual(new Uint8Array([0, 255, 128, 64]));
    expect(folder.files.get("Other/file.bin")).toEqual(new Uint8Array([99]));
    expect(folder.files.get("Notes/existing.md")).toBe("Keep note.");
    expect(Object.keys(synced)).toHaveLength(3);
    const { files: reread } = await readConnectedDirectoryCompanions(folder.handle, synced);
    expect(reread).toEqual(synced);
    folder.writes.length = 0;
    await syncConnectedDirectoryCompanions(folder.handle, synced, synced);
    expect(folder.writes).toHaveLength(0);
  });

  test("rejects an externally edited binary before writing any companion", async () => {
    const folder = memoryDirectory({ "Attachments/id/file.bin": new Uint8Array([0, 1, 2]) });
    const expected = { "Attachments/id/file.bin": { content: "AAEC", encoding: "base64" as const } };
    folder.files.set("Attachments/id/file.bin", new Uint8Array([9, 8, 7]));
    await expect(syncConnectedDirectoryCompanions(folder.handle, { "workspace.json": { content: "new settings" }, ...expected }, expected)).rejects.toBeInstanceOf(LocalDirectoryConflictError);
    expect(folder.files.get("Attachments/id/file.bin")).toEqual(new Uint8Array([9, 8, 7]));
    expect(folder.writes).toHaveLength(0);
  });

  test("rejects a colliding attachment and unsafe paths instead of overwriting", async () => {
    const folder = memoryDirectory({ "Attachments/id/file.bin": new Uint8Array([3]) });
    await expect(syncConnectedDirectoryCompanions(folder.handle, { "Attachments/id/file.bin": { content: "BA==", encoding: "base64" } }, {})).rejects.toBeInstanceOf(LocalDirectoryConflictError);
    await expect(syncConnectedDirectoryCompanions(folder.handle, { "Attachments/../secret": { content: "bad" } }, {})).rejects.toThrow("Invalid vault companion path");
    await expect(syncConnectedDirectoryCompanions(folder.handle, { "__proto__/secret": { content: "bad" } }, {})).rejects.toThrow("Invalid vault companion path");
    expect(folder.writes).toHaveLength(0);
  });

  test("the Markdown adapter leaves companion .md bytes to the companion adapter", async () => {
    const original = createMarkdownWorkspace(createEmptyState());
    const folder = memoryDirectory({ ...original.files, "Attachments/id/original.md": new Uint8Array([255, 254]), "_conflicts/offline/Note.md": "Copy." });
    const read = await readDirectoryWorkspace(folder.handle, "user");
    expect(read.workspace.files["Attachments/id/original.md"]).toBeUndefined();
    expect(read.workspace.files["_conflicts/offline/Note.md"]).toBeUndefined();
    await writeConnectedDirectoryWorkspace(folder.handle, "user", { ...read.workspace, files: { ...read.workspace.files, "_conflicts/offline/Note.md": "Different copy" } }, read.workspace);
    expect(folder.files.get("Attachments/id/original.md")).toEqual(new Uint8Array([255, 254]));
    expect(folder.files.get("_conflicts/offline/Note.md")).toBe("Copy.");
  });

  test("discovers new companions while retaining known binary Markdown encoding", async () => {
    const folder = memoryDirectory({ "_conflicts/known/Source.md": new Uint8Array([255, 254]), "Attachments/new/source.pdf": new Uint8Array([0, 1, 2]) });
    const known = { "_conflicts/known/Source.md": { content: "old", encoding: "base64" as const, contentType: "application/octet-stream" } };
    const { files } = await readConnectedDirectoryCompanions(folder.handle, known);
    expect(files["_conflicts/known/Source.md"]).toEqual({ content: "//4=", encoding: "base64", contentType: "application/octet-stream" });
    expect(files["Attachments/new/source.pdf"]).toEqual({ content: "AAEC", encoding: "base64" });
  });

  test("recognizes binary Markdown conflict copies using their portable conflict note", async () => {
    const folder = memoryDirectory({
      "_conflicts/offline/Source.md": new Uint8Array([255, 254]),
      "_conflicts/offline/conflict.json": JSON.stringify({ path: "Attachments/doc/Source.md", copy: "_conflicts/offline/Source.md" }),
      "_conflicts/nested/local/conflict.json": new Uint8Array([0, 255]),
      "_conflicts/nested/conflict.json": JSON.stringify({ path: "Attachments/doc/conflict.json", copy: "_conflicts/nested/local/conflict.json" }),
      "_conflicts/binary/local/document.md": new Uint8Array([0, 255]),
      "_conflicts/binary/remote/document.md": new Uint8Array([255, 0]),
      "_conflicts/binary/base/document.md": new Uint8Array([255, 1]),
      "_conflicts/binary/result/document.md": new Uint8Array([255, 2]),
      "_conflicts/binary/conflict.json": JSON.stringify({ path: "Other/document.md", copy: "_conflicts/binary/local/document.md", remoteCopy: "_conflicts/binary/remote/document.md", localEncoding: "base64", remoteEncoding: "base64",
        baseCopy: "_conflicts/binary/base/document.md", resultCopy: "_conflicts/binary/result/document.md", baseEncoding: "base64", resultEncoding: "base64" }),
    });
    const { files } = await readConnectedDirectoryCompanions(folder.handle);
    expect(files["_conflicts/offline/Source.md"]).toEqual({ content: "//4=", encoding: "base64" });
    expect(files["_conflicts/nested/local/conflict.json"]).toEqual({ content: "AP8=", encoding: "base64" });
    expect(files["_conflicts/binary/local/document.md"]).toEqual({ content: "AP8=", encoding: "base64" });
    expect(files["_conflicts/binary/remote/document.md"]).toEqual({ content: "/wA=", encoding: "base64" });
    expect(files["_conflicts/binary/base/document.md"]).toEqual({ content: "/wE=", encoding: "base64" });
    expect(files["_conflicts/binary/result/document.md"]).toEqual({ content: "/wI=", encoding: "base64" });
  });
});

/** A folder whose files keep their own dates, logging each time a file's bytes are read and each write and removal. */
function datedDirectory(initial: Record<string, string | Uint8Array>) {
  // Dates well before now, a second apart; each write moves a file's date on.
  let clock = Date.now() - 24 * 60 * 60 * 1000;
  const files = new Map<string, { bytes: string | Uint8Array; lastModified: number }>();
  for (const [path, bytes] of Object.entries(initial)) files.set(path, { bytes, lastModified: clock += 1000 });
  const reads: string[] = [];
  const log: string[] = [];
  const aborted: string[] = [];
  let failWrite: ((path: string) => boolean) | null = null;
  function missing() { const error = new Error("Missing"); error.name = "NotFoundError"; return error; }
  function directory(prefix = ""): FileSystemDirectoryHandle {
    return {
      kind: "directory", name: prefix || "vault",
      async *entries() {
        const names = new Set([...files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split("/")[0]));
        for (const name of names) yield [name, files.has(prefix + name) ? fileHandle(prefix + name) : directory(`${prefix}${name}/`)];
      },
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        if (!options?.create && ![...files.keys()].some((file) => file.startsWith(`${prefix}${name}/`))) throw missing();
        return directory(`${prefix}${name}/`);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const path = prefix + name;
        if (!files.has(path)) {
          if (!options?.create) throw missing();
          files.set(path, { bytes: "", lastModified: clock += 1000 });
        }
        return fileHandle(path);
      },
      async removeEntry(name: string) { if (!files.delete(prefix + name)) throw missing(); log.push(`remove ${prefix + name}`); },
    } as unknown as FileSystemDirectoryHandle;
  }
  function fileHandle(path: string): FileSystemFileHandle {
    const name = path.split("/").at(-1)!;
    return {
      kind: "file", name,
      async getFile() {
        const entry = files.get(path);
        if (!entry) throw missing();
        const file = new File([entry.bytes], name, { lastModified: entry.lastModified });
        // Its size and date come free; reading its bytes is logged.
        return { name, size: file.size, lastModified: file.lastModified, type: "",
          text() { reads.push(path); return file.text(); },
          arrayBuffer() { reads.push(path); return file.arrayBuffer(); } } as unknown as File;
      },
      async createWritable() {
        let pending: string | Uint8Array = files.get(path)?.bytes ?? "";
        return {
          async write(content: string | ArrayBuffer) {
            const next = typeof content === "string" ? content : new Uint8Array(content);
            if (failWrite?.(path)) {
              // Some of it was written before the disk gave out.
              pending = next.slice(0, Math.floor(next.length / 2));
              throw new DOMException("The disk is full.", "QuotaExceededError");
            }
            pending = next;
          },
          async close() { files.set(path, { bytes: pending, lastModified: clock += 1000 }); log.push(`write ${path}`); },
          async abort() { aborted.push(path); },
        };
      },
    } as unknown as FileSystemFileHandle;
  }
  return {
    handle: directory(), files, reads, log, aborted,
    /** The documents and companions read since the last call, sorted; Margin Chat's small manifest file is left out. */
    takeReads() { const taken = reads.filter((path) => path !== getLocalWorkspaceFileName("user")).sort(); reads.length = 0; return taken; },
    edit(path: string, bytes: string | Uint8Array, lastModified = clock += 1000) { files.set(path, { bytes, lastModified }); },
    failWrites(matches: ((path: string) => boolean) | null) { failWrite = matches; },
  };
}

describe("reading only what changed", () => {
  const PDF = new Uint8Array([37, 80, 68, 70, 45, 49]);

  test("an unchanged folder is not read again; a file with a new size or date is", async () => {
    const folder = datedDirectory({ "One.md": "First.", "Notes/Two.md": "Second.", "Attachments/doc/metadata.json": '{"id":"doc"}', "Papers/Paper.pdf": PDF });
    const first = await readDirectoryWorkspace(folder.handle, "user");
    const firstCompanions = await readConnectedDirectoryCompanions(folder.handle, undefined, await listConnectedDirectoryFiles(folder.handle));
    expect(folder.takeReads()).toEqual(["Attachments/doc/metadata.json", "Notes/Two.md", "One.md", "Papers/Paper.pdf"]);

    const again = await readDirectoryWorkspace(folder.handle, "user", first.workspace.manifest, first.workspace.files, first.stats);
    const againCompanions = await readConnectedDirectoryCompanions(folder.handle, firstCompanions.files, await listConnectedDirectoryFiles(folder.handle), firstCompanions.stats);
    expect(folder.takeReads()).toEqual([]);
    expect(again.workspace.files).toEqual(first.workspace.files);
    expect(againCompanions.files).toEqual(firstCompanions.files);

    // A new size is read, and so is the same size with a new date (the same number of letters, edited in another app).
    folder.edit("One.md", "First, edited elsewhere.");
    folder.edit("Notes/Two.md", "Secund.");
    folder.edit("Papers/Paper.pdf", new Uint8Array([37, 80, 68, 70, 45, 50]));
    const third = await readDirectoryWorkspace(folder.handle, "user", again.workspace.manifest, again.workspace.files, again.stats);
    const thirdCompanions = await readConnectedDirectoryCompanions(folder.handle, againCompanions.files, await listConnectedDirectoryFiles(folder.handle), againCompanions.stats);
    expect(folder.takeReads()).toEqual(["Notes/Two.md", "One.md", "Papers/Paper.pdf"]);
    expect(third.workspace.files["One.md"]).toBe("First, edited elsewhere.");
    expect(third.workspace.files["Notes/Two.md"]).toBe("Secund.");
    expect(thirdCompanions.files["Papers/Paper.pdf"].content).toBe("JVBERi0y");
  });

  test("a save cycle with nothing to change reads no documents, and a write reads only the file it changes", async () => {
    const original = discoverMarkdownWorkspace({ "One.md": "First.", "Two.md": "Second." });
    const folder = datedDirectory({ ...original.files, ".margin-chat/history/old/One.md": "Older.", "Papers/Paper.pdf": PDF });
    const cycle = async (previous?: { workspace: MarkdownWorkspace; files: Record<string, VaultFile>; stats: DirectoryStats }, workspace?: MarkdownWorkspace) => {
      const read = await readDirectoryWorkspace(folder.handle, "user", previous?.workspace.manifest, previous?.workspace.files, previous?.stats);
      const companions = await readConnectedDirectoryCompanions(folder.handle, previous?.files, await listConnectedDirectoryFiles(folder.handle), previous?.stats);
      const stats = { ...read.stats, ...companions.stats };
      const written = await writeConnectedDirectory(folder.handle, "user", { workspace: workspace ?? read.workspace, expectedWorkspace: read.workspace,
        files: companions.files, expectedFiles: companions.files, stats });
      return { workspace: workspace ?? read.workspace, files: written.companions, stats: written.stats };
    };
    const first = await cycle();
    // Without anything known yet, every document and companion is read, once.
    expect(folder.takeReads()).toEqual([".margin-chat/history/old/One.md", "One.md", "Papers/Paper.pdf", "Two.md"]);
    const second = await cycle(first);
    expect(folder.takeReads()).toEqual([]);

    // Editing a document reads it once, just before it is written. The next cycle reads it once more, since
    // a file written here has no stats until a scan reads it, and then nothing again.
    const state = parseMarkdownWorkspace(second.workspace.manifest, second.workspace.files)!;
    state.conversations[second.workspace.manifest.files.find((file) => file.path === "One.md")!.id].notes![0].content = "First, edited in the app.";
    const edited = createMarkdownWorkspace(state, undefined, second.workspace);
    const third = await cycle(second, edited);
    expect(folder.takeReads()).toEqual(["One.md"]);
    expect(folder.log.filter((entry) => entry.endsWith(".md"))).toEqual(["write One.md"]);
    expect(third.stats["One.md"]).toBeUndefined();
    const fourth = await cycle(third);
    expect(folder.takeReads()).toEqual(["One.md"]);
    await cycle(fourth);
    expect(folder.takeReads()).toEqual([]);
  });

  test("a file saved within seconds of being read is read again, since some disks keep only whole seconds", async () => {
    const folder = datedDirectory({ "Note.md": "Draft." });
    folder.edit("Note.md", "Draft.", Date.now());
    const first = await readDirectoryWorkspace(folder.handle, "user");
    expect(first.stats).toEqual({});
    await readDirectoryWorkspace(folder.handle, "user", first.workspace.manifest, first.workspace.files, first.stats);
    expect(folder.takeReads()).toEqual(["Note.md", "Note.md"]);
  });

  test("a file whose saved text doesn't match its size and date is caught before it is overwritten", async () => {
    const original = discoverMarkdownWorkspace({ "Note.md": "Original content." });
    const folder = datedDirectory(original.files);
    const read = await readDirectoryWorkspace(folder.handle, "user");
    // Another app saved the file without changing its size or date: the scan keeps the old text,
    // but the check right before writing reads the bytes on disk.
    const before = folder.files.get("Note.md")!;
    folder.files.set("Note.md", { bytes: "External content.", lastModified: before.lastModified });
    const state = parseMarkdownWorkspace(read.workspace.manifest, read.workspace.files)!;
    state.conversations[read.workspace.manifest.files[0].id].notes![0].content = "Application change.";
    const desired = createMarkdownWorkspace(state, undefined, read.workspace);
    await expect(writeConnectedDirectoryWorkspace(folder.handle, "user", desired, read.workspace, read.stats)).rejects.toBeInstanceOf(LocalDirectoryConflictError);
    expect(folder.files.get("Note.md")!.bytes).toBe("External content.");
  });
});

describe("writing the folder safely", () => {
  test("a deleted document's copy in the trash is on disk before the document leaves the folder", async () => {
    const original = discoverMarkdownWorkspace({ "Keep.md": "Kept.", "Gone.md": "Deleted in the app." });
    const trash = {
      ".margin-chat/trash/k1/1-Gone.md": { content: "Deleted in the app." },
      ".margin-chat/trash/k1/deleted.json": { content: '{"schemaVersion":1}', contentType: "application/json" },
    };
    const desired = discoverMarkdownWorkspace({ "Keep.md": "Kept." }, original.manifest, original.files);
    const folder = datedDirectory(original.files);
    const read = await readDirectoryWorkspace(folder.handle, "user");
    await writeConnectedDirectory(folder.handle, "user", { workspace: desired, expectedWorkspace: read.workspace, files: trash, expectedFiles: {}, stats: read.stats });
    const removal = folder.log.indexOf("remove Gone.md");
    expect(removal).toBeGreaterThan(folder.log.indexOf("write .margin-chat/trash/k1/1-Gone.md"));
    expect(removal).toBeGreaterThan(folder.log.indexOf("write .margin-chat/trash/k1/deleted.json"));
    expect(folder.log.indexOf("write .margin-chat/trash/k1/1-Gone.md")).toBeGreaterThanOrEqual(0);

    // When the copy can't be written, the document stays.
    const blocked = datedDirectory({ ...original.files, ".margin-chat/trash/k1/1-Gone.md": "Something else already here." });
    const blockedRead = await readDirectoryWorkspace(blocked.handle, "user");
    await expect(writeConnectedDirectory(blocked.handle, "user", { workspace: desired, expectedWorkspace: blockedRead.workspace, files: trash,
      expectedFiles: {}, stats: blockedRead.stats })).rejects.toBeInstanceOf(LocalDirectoryConflictError);
    expect(blocked.files.get("Gone.md")!.bytes).toBe("Deleted in the app.");
    expect(blocked.log.filter((entry) => entry.startsWith("remove"))).toEqual([]);
  });

  test("a failed write is aborted and leaves the file as it was", async () => {
    const original = discoverMarkdownWorkspace({ "Note.md": "Original content." });
    const folder = datedDirectory(original.files);
    const state = parseMarkdownWorkspace(original.manifest, original.files)!;
    state.conversations[original.manifest.files[0].id].notes![0].content = "A longer application change that the disk can't hold.";
    const desired = createMarkdownWorkspace(state, undefined, original);
    folder.failWrites((path) => path === "Note.md");
    await expect(writeConnectedDirectoryWorkspace(folder.handle, "user", desired, original)).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(folder.aborted).toEqual(["Note.md"]);
    expect(folder.log).not.toContain("write Note.md");
    expect(folder.files.get("Note.md")!.bytes).toBe("Original content.");
  });
});
