import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createBrowserVaultStore } from "../client/src/lib/vaultLocal";
import { emptyVault, type VaultSnapshot } from "../client/src/lib/vaultTypes";
import { workspaceFromVault } from "../client/src/lib/vaultWorkspace";

/** Models OPFS's empty create:true entry and atomic writable close/abort. */
function simulatedOpfs() {
  const files = new Map<string, Uint8Array>();
  const directories = new Set([""]);
  const closes: string[] = [];
  const reads: string[] = [];
  let failure: { stage: "write" | "close"; matches: (path: string) => boolean } | null = null;
  let failRemovals = false;
  const missing = () => new DOMException("Missing file", "NotFoundError");
  const toBytes = (contents: string | ArrayBuffer) => typeof contents === "string" ? new TextEncoder().encode(contents) : new Uint8Array(contents).slice();
  function maybeFail(stage: "write" | "close", path: string) {
    if (failure?.stage === stage && failure.matches(path)) {
      failure = null;
      throw new DOMException("Simulated interrupted OPFS write", "QuotaExceededError");
    }
  }
  function directory(prefix = ""): FileSystemDirectoryHandle {
    return {
      kind: "directory", name: prefix.split("/").at(-2) || "root",
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const path = `${prefix}${name}/`;
        if (!directories.has(path) && !options?.create) throw missing();
        directories.add(path);
        return directory(path);
      },
      async removeEntry(name: string) {
        if (failRemovals) throw new DOMException("Simulated unavailable cleanup", "NoModificationAllowedError");
        if (!files.delete(prefix + name)) throw missing();
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const path = prefix + name;
        if (!files.has(path)) {
          if (!options?.create) throw missing();
          files.set(path, new Uint8Array());
        }
        return {
          kind: "file", name,
          async getFile() {
            reads.push(path);
            const bytes = files.get(path);
            if (!bytes) throw missing();
            return new File([bytes.slice().buffer], name);
          },
          async createWritable() {
            let pending = new Uint8Array();
            return {
              async write(contents: string | ArrayBuffer) { maybeFail("write", path); pending = toBytes(contents); },
              async close() { maybeFail("close", path); files.set(path, pending.slice()); closes.push(path); },
              async abort() { pending = new Uint8Array(); },
            };
          },
        } as unknown as FileSystemFileHandle;
      },
    } as FileSystemDirectoryHandle;
  }
  const lockTails = new Map<string, Promise<unknown>>();
  return {
    files, closes, reads,
    failOnce(stage: "write" | "close", matches: (path: string) => boolean) { failure = { stage, matches }; },
    preventCleanup(value: boolean) { failRemovals = value; },
    navigator: {
      storage: { getDirectory: async () => directory() },
      locks: { request(name: string, operation: () => Promise<unknown>) {
        const next = (lockTails.get(name) ?? Promise.resolve()).then(operation);
        lockTails.set(name, next.catch(() => undefined));
        return next;
      } },
    },
  };
}

async function withOpfs(operation: (opfs: ReturnType<typeof simulatedOpfs>) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const opfs = simulatedOpfs();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: opfs.navigator });
  try { await operation(opfs); }
  finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete (globalThis as any).navigator;
  }
}

function snapshot(content: string): VaultSnapshot {
  return { ...emptyVault(), files: { "Note.md": { content, contentType: "text/markdown" } } };
}
const objectPath = (content: string) => `margin-chat-vaults/alice/history/${createHash("sha256").update(content).digest("hex")}.md`;

describe("durable OPFS Markdown storage", () => {
  test("automatic recovery ancestors/results use verified objects and dismissed versions stay dismissed", async () => withOpfs(async (opfs) => {
    const desired = snapshot("Selected merged writing");
    desired.conflicts.push({ id: "merge", path: "Note.md", createdAt: "2026-09-25T12:00:00.000Z", automatic: true,
      base: { content: "Original writing" }, local: { content: "Device writing" }, remote: { content: "Synced writing" },
      result: { content: "Selected merged writing" } });
    desired.dismissedRecoveryIds = ["older-merge"];
    const storage = createBrowserVaultStore("alice");
    await storage.write(desired);
    expect(await createBrowserVaultStore("alice").read()).toEqual(desired);
    const index = JSON.parse(new TextDecoder().decode(opfs.files.get("margin-chat-vaults/alice/vault-state.json")));
    expect(index.conflicts[0].base.content).toBeUndefined();
    expect(index.conflicts[0].result.content).toBeUndefined();
    expect(index.conflicts[0].base.object).toMatch(/\.md$/);
    expect(index.conflicts[0].result.object).toMatch(/\.md$/);
    const changed = structuredClone(desired);
    changed.conflicts[0].base = { content: "Another ancestor" };
    opfs.failOnce("close", (path) => path === objectPath("Another ancestor"));
    await expect(storage.write(changed)).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(await createBrowserVaultStore("alice").read()).toEqual(desired);
    opfs.files.set(objectPath("Original writing"), new Uint8Array());
    await expect(createBrowserVaultStore("alice").read()).rejects.toThrow("incomplete or damaged");
  }));

  test("directory observations reopen with exact companion bytes and advance atomically with the vault", async () => withOpfs(async (opfs) => {
    const original = snapshot("Previously observed folder note");
    original.directoryBaselines = { "directory-identity": {
      manifest: workspaceFromVault(original.files).manifest,
      files: { ...original.files, "Attachments/original.md": { content: "AP8BAg==", encoding: "base64", contentType: "application/octet-stream" } },
    } };
    const store = createBrowserVaultStore("alice");
    await store.write(original);
    expect(await createBrowserVaultStore("alice").read()).toEqual(original);
    const updated = structuredClone(original);
    updated.files["Note.md"].content = "New folder note";
    updated.directoryBaselines!["directory-identity"].files["Note.md"].content = "New folder note";
    opfs.failOnce("close", (path) => path.endsWith("/vault-state.json"));
    await expect(store.write(updated)).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(await createBrowserVaultStore("alice").read()).toEqual(original);
    const index = JSON.parse(new TextDecoder().decode(opfs.files.get("margin-chat-vaults/alice/vault-state.json")));
    expect(index.directoryBaselines["directory-identity"].files["Note.md"].content).toBeUndefined();
    expect(index.directoryBaselines["directory-identity"].files["Note.md"].object).toMatch(/\.md$/);
  }));

  test("decoded text with a consumed BOM cannot alias a different immutable object's bytes", async () => withOpfs(async (opfs) => {
    const store = createBrowserVaultStore("alice");
    const original = emptyVault();
    original.files = { "plain.md": { content: "same text" }, "bom.md": { content: "\uFEFFsame text" } };
    await store.write(original);
    await store.lock(async () => {
      const decoded = (await store.read())!;
      expect(decoded.files["plain.md"].content).toBe(decoded.files["bom.md"].content);
      await store.write(decoded);
    });
    const index = JSON.parse(new TextDecoder().decode(opfs.files.get("margin-chat-vaults/alice/vault-state.json")));
    const expected = `${createHash("sha256").update("same text").digest("hex")}.md`;
    expect(index.files["plain.md"].object).toBe(expected);
    expect(index.files["bom.md"].object).toBe(expected);
  }));

  test("one locked save verifies unchanged objects once and does not trust them in the next operation", async () => withOpfs(async (opfs) => {
    const store = createBrowserVaultStore("alice");
    const original = snapshot("Unchanged large note");
    await store.write(original);
    opfs.reads.length = 0;
    await store.lock(async () => {
      const current = (await store.read())!;
      current.files["Other.md"] = { content: "Changed document" };
      await store.write(current);
    });
    expect(opfs.reads.filter((path) => path === objectPath("Unchanged large note"))).toHaveLength(1);
    opfs.files.set(objectPath("Unchanged large note"), new Uint8Array());
    await expect(store.lock(() => store.read())).rejects.toThrow("incomplete or damaged");
  }));

  test("an interrupted history write is repaired on retry before its reference is committed", async () => withOpfs(async (opfs) => {
    const first = createBrowserVaultStore("alice");
    const original = snapshot("Previously committed Markdown");
    const edited = snapshot("New Markdown that must survive a retry");
    await first.write(original);
    opfs.preventCleanup(true);
    opfs.failOnce("write", (path) => path.includes("/history/"));
    await expect(first.write(edited)).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(opfs.files.get(objectPath(edited.files["Note.md"].content))).toHaveLength(0);
    const reopened = createBrowserVaultStore("alice");
    expect((await reopened.read())?.files["Note.md"].content).toBe(original.files["Note.md"].content);
    opfs.preventCleanup(false);
    await reopened.write(edited);
    expect((await createBrowserVaultStore("alice").read())?.files["Note.md"].content).toBe(edited.files["Note.md"].content);
  }));

  test("an existing same-size invalid history object is rewritten instead of trusted", async () => withOpfs(async (opfs) => {
    const expected = snapshot("exact bytes");
    opfs.files.set(objectPath("exact bytes"), new TextEncoder().encode("wrong bytes"));
    await createBrowserVaultStore("alice").write(expected);
    expect(new TextDecoder().decode(opfs.files.get(objectPath("exact bytes")))).toBe("exact bytes");
    expect((await createBrowserVaultStore("alice").read())?.files["Note.md"].content).toBe("exact bytes");
  }));

  test("a failed first index write leaves the vault retryable and reuses already verified history", async () => withOpfs(async (opfs) => {
    const expected = snapshot("First saved note");
    const first = createBrowserVaultStore("alice");
    opfs.failOnce("close", (path) => path.endsWith("/vault-state.json"));
    await expect(first.write(expected)).rejects.toMatchObject({ name: "QuotaExceededError" });
    const reopened = createBrowserVaultStore("alice");
    expect(await reopened.read()).toBeNull();
    const historyWrites = opfs.closes.filter((path) => path.includes("/history/")).length;
    await reopened.write(expected);
    expect(opfs.closes.filter((path) => path.includes("/history/"))).toHaveLength(historyWrites);
    expect((await createBrowserVaultStore("alice").read())?.files["Note.md"].content).toBe("First saved note");
  }));

  test("a failed index replacement preserves the complete previous snapshot", async () => withOpfs(async (opfs) => {
    const first = createBrowserVaultStore("alice");
    const original = snapshot("Old committed note");
    await first.write(original);
    opfs.failOnce("close", (path) => path.endsWith("/vault-state.json"));
    await expect(first.write(snapshot("New draft"))).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(await createBrowserVaultStore("alice").read()).toEqual(original);
    await first.write(snapshot("New draft"));
    expect((await createBrowserVaultStore("alice").read())?.files["Note.md"].content).toBe("New draft");
  }));

  test("deduplicated bytes retain each working, base, and conflict reference's MIME metadata", async () => withOpfs(async () => {
    const desired = emptyVault();
    desired.files = {
      "Attachments/a.bin": { content: "AP8B", encoding: "base64", contentType: "application/pdf" },
      "Attachments/b.bin": { content: "AP8B", encoding: "base64", contentType: "application/octet-stream" },
    };
    desired.base["Attachments/a.bin"] = { revision: "base-revision", file: { content: "AP8B", encoding: "base64", contentType: "image/png" } };
    desired.conflicts.push({ id: "conflict", path: "Attachments/a.bin", createdAt: "2026-09-13T00:00:00.000Z", remote: null,
      local: { content: "AP8B", encoding: "base64", contentType: "text/plain" } });
    await createBrowserVaultStore("alice").write(desired);
    const restored = await createBrowserVaultStore("alice").read();
    expect(restored).toEqual(desired);
    expect(restored?.files["Attachments/a.bin"]).not.toBe(restored?.files["Attachments/b.bin"]);
  }));

  test("reopening detects damaged referenced bytes instead of rendering incorrect Markdown", async () => withOpfs(async (opfs) => {
    const original = snapshot("Verified source");
    await createBrowserVaultStore("alice").write(original);
    opfs.files.set(objectPath("Verified source"), new Uint8Array());
    await expect(createBrowserVaultStore("alice").read()).rejects.toThrow("incomplete or damaged");
    await createBrowserVaultStore("alice").write(original);
    expect(await createBrowserVaultStore("alice").read()).toEqual(original);
  }));
});
