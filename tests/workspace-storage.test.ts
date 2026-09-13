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
} from "../client/src/lib/workspaceStorage";
import { createMarkdownWorkspace, discoverMarkdownWorkspace, parseMarkdownWorkspace } from "../client/src/lib/workspaceMarkdown";
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

describe("portable folder companions", () => {
  test("discovers only managed attachments/conflicts/settings and keeps Markdown attachments binary", async () => {
    const folder = memoryDirectory({
      "Attachments/doc/original.md": new Uint8Array([35, 32, 83, 111, 117, 114, 99, 101]),
      "Attachments/doc/metadata.json": '{"id":"doc"}',
      "_conflicts/offline/Note.md": "Offline note.",
      "workspace.json": '{"settings":"portable"}',
      "Private/unrelated.bin": new Uint8Array([255, 254]),
      "Unrelated.txt": "Keep untouched.",
    });
    const files = await readConnectedDirectoryCompanions(folder.handle);
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
    const synced = await syncConnectedDirectoryCompanions(folder.handle, next, {});
    expect(folder.files.get("Attachments/id/file.bin")).toEqual(new Uint8Array([0, 255, 128, 64]));
    expect(folder.files.get("Other/file.bin")).toEqual(new Uint8Array([99]));
    expect(folder.files.get("Notes/existing.md")).toBe("Keep note.");
    expect(Object.keys(synced)).toHaveLength(3);
    const reread = await readConnectedDirectoryCompanions(folder.handle, synced);
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
    const files = await readConnectedDirectoryCompanions(folder.handle, known);
    expect(files["_conflicts/known/Source.md"]).toEqual({ content: "//4=", encoding: "base64", contentType: "application/octet-stream" });
    expect(files["Attachments/new/source.pdf"]).toEqual({ content: "AAEC", encoding: "base64" });
  });

  test("recognizes binary Markdown conflict copies using their portable conflict note", async () => {
    const folder = memoryDirectory({
      "_conflicts/offline/Source.md": new Uint8Array([255, 254]),
      "_conflicts/offline/conflict.json": JSON.stringify({ path: "Attachments/doc/Source.md", copy: "_conflicts/offline/Source.md" }),
      "_conflicts/nested/local/conflict.json": new Uint8Array([0, 255]),
      "_conflicts/nested/conflict.json": JSON.stringify({ path: "Attachments/doc/conflict.json", copy: "_conflicts/nested/local/conflict.json" }),
    });
    const files = await readConnectedDirectoryCompanions(folder.handle);
    expect(files["_conflicts/offline/Source.md"]).toEqual({ content: "//4=", encoding: "base64" });
    expect(files["_conflicts/nested/local/conflict.json"]).toEqual({ content: "AP8=", encoding: "base64" });
  });
});
