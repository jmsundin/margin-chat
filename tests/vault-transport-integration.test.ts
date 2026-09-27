import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVaultService } from "../server/vault/index.mjs";
import { createFileVaultStorage } from "../server/vault/storage.mjs";
import { createVaultTransport } from "../client/src/lib/vaultApi";
import { vaultToState } from "../client/src/lib/vaultWorkspace";
import { createEmptyState } from "../client/src/initialState";
import { emptyVault, sameVaultFile, type VaultSnapshot, type VaultStore } from "../client/src/lib/vaultTypes";
import { VaultSync, pendingVaultChanges } from "../client/src/lib/vaultSync";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("real vault server to browser transport contract", () => {
  let directory: string;
  let service: ReturnType<typeof createVaultService>;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "marginchat-transport-test-"));
    service = createVaultService({ storage: createFileVaultStorage(directory), env: {} });
  });
  afterAll(async () => { if (directory) await rm(directory, { force: true, recursive: true }); });

  function routeOriginals(userId: string) {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://fixture.test");
      const original = await service.readFile({ userId, path: url.searchParams.get("path"), revision: url.searchParams.get("revision") });
      return new Response(original.bytes, { headers: { "Content-Type": original.contentType } });
    }) as typeof fetch;
  }

  test("UTF-8 Markdown from the real server remains visible and comparable in the browser", async () => {
    const content = "# Phone note\n\nThe original Markdown content.\n";
    const result = await service.commit("utf8-reader", [{ path: "Notes/phone.md", content, baseRevision: null }]);
    routeOriginals("utf8-reader");
    const file = await createVaultTransport().read("Notes/phone.md", result.manifest.files["Notes/phone.md"]);
    expect(file.encoding).toBeUndefined();
    expect(sameVaultFile(file, { content })).toBe(true);
    const restored = vaultToState({ "Notes/phone.md": file }, createEmptyState());
    expect(Object.values(restored.conversations).some((conversation) => conversation.title === "Phone note")).toBe(true);
  });

  test("binary attachment encoding survives the server/browser boundary", async () => {
    const bytes = Buffer.from([0, 255, 10, 13, 0, 2]);
    const result = await service.commit("binary-reader", [{
      path: "Attachments/doc/original.pdf", content: bytes.toString("base64"), encoding: "base64",
      contentType: "application/pdf", baseRevision: null,
    }]);
    routeOriginals("binary-reader");
    const file = await createVaultTransport().read("Attachments/doc/original.pdf", result.manifest.files["Attachments/doc/original.pdf"]);
    expect(file.encoding).toBe("base64");
    expect(Buffer.from(file.content, "base64")).toEqual(bytes);
  });

  test("a damaged download cannot replace durable local files or advance their sync baseline", async () => {
    const path = "Notes/preserved.md";
    const content = "# Preserved note\n\nCloud content.\n";
    const result = await service.commit("damaged-reader", [{ path, content, baseRevision: null }]);
    let snapshot: VaultSnapshot = { ...emptyVault(), files: { [path]: { content: "# Preserved note\n\nUnsynced local writing.\n" } } };
    const before = structuredClone(snapshot);
    let commits = 0;
    const store: VaultStore = {
      lock: async (operation) => operation(),
      read: async () => structuredClone(snapshot),
      write: async (next) => { snapshot = structuredClone(next); },
    };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://fixture.test");
      if (url.pathname === "/api/vault") return Response.json({ configured: true, ...result });
      if (url.pathname === "/api/vault/file") return new Response("# Preserved note\n\nTruncated or incorrect cloud content.");
      commits++;
      return Response.json(result);
    }) as typeof fetch;
    await expect(new VaultSync(store, createVaultTransport()).sync()).rejects.toThrow("does not match its saved revision");
    expect(snapshot).toEqual(before);
    expect(pendingVaultChanges(snapshot)).toHaveLength(1);
    expect(commits).toBe(0);
  });

  test("binary download corruption is detected before accepting its saved revision", async () => {
    const path = "Attachments/damaged/original.pdf";
    const result = await service.commit("damaged-binary", [{ path, content: "AP8=", encoding: "base64", contentType: "application/pdf", baseRevision: null }]);
    globalThis.fetch = (async () => new Response(new Uint8Array([0, 254]))) as typeof fetch;
    await expect(createVaultTransport().read(path, result.manifest.files[path])).rejects.toThrow("does not match its saved revision");
  });

  test("a stale success receipt cannot mark newer local writing as uploaded", async () => {
    const path = "Notes/receipt.md";
    const previous = "# Receipt\n\nOriginal cloud copy.\n";
    const edited = "# Receipt\n\nNew local writing.\n";
    const result = await service.commit("stale-receipt", [{ path, content: previous, baseRevision: null }]);
    let snapshot: VaultSnapshot = {
      ...emptyVault(), remoteRevision: result.manifest.revision,
      files: { [path]: { content: edited } },
      base: { [path]: { revision: result.manifest.files[path].revision, file: { content: previous } } },
    };
    const store: VaultStore = {
      lock: async (operation) => operation(),
      read: async () => structuredClone(snapshot),
      write: async (next) => { snapshot = structuredClone(next); },
    };
    globalThis.fetch = (async () => Response.json({ configured: true, ...result })) as typeof fetch;
    await expect(new VaultSync(store, createVaultTransport()).sync()).rejects.toThrow("did not acknowledge the uploaded file contents");
    expect(snapshot.files[path].content).toBe(edited);
    expect(snapshot.base[path].file?.content).toBe(previous);
    expect(pendingVaultChanges(snapshot)).toHaveLength(1);
  });

  test("valid JSON and binary upload receipts preserve the real server contract", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://fixture.test");
      const result = url.pathname === "/api/vault/file"
        ? await service.commitBinary("upload-receipts", {
          path: url.searchParams.get("path"), baseRevision: url.searchParams.get("baseRevision") || null,
          bytes: Buffer.from(init!.body as ArrayBuffer), contentType: new Headers(init?.headers).get("Content-Type"),
        })
        : await service.commit("upload-receipts", JSON.parse(init!.body as string).changes);
      return Response.json(result);
    }) as typeof fetch;
    const transport = createVaultTransport("upload-receipts");
    const markdown = await transport.commit([{ path: "Notes/upload.md", content: "# Upload\n", baseRevision: null }]);
    expect(markdown.files["Notes/upload.md"].encoding).toBeUndefined();
    const binary = await transport.commit([{ path: "Attachments/upload/original.pdf", content: "AP8=", encoding: "base64", baseRevision: null }]);
    expect(binary.files["Attachments/upload/original.pdf"].encoding).toBe("base64");
    const removed = await transport.commit([{ path: "Notes/upload.md", content: null, baseRevision: markdown.files["Notes/upload.md"].revision }]);
    expect(removed.files["Notes/upload.md"].deleted).toBe(true);
  });

  test.each([
    null,
    { schemaVersion: 1, revision: -1, files: {} },
    { schemaVersion: 1, revision: 1.5, files: {} },
    { schemaVersion: 1, revision: Number.MAX_SAFE_INTEGER + 1, files: {} },
    { schemaVersion: 1, revision: 1, files: [] },
    { schemaVersion: 1, revision: 1, files: { "Notes/invalid.md": null } },
    { schemaVersion: 1, revision: 1, files: { "Notes/invalid.md": { revision: "wrong", deleted: false } } },
    { schemaVersion: 1, revision: 1, files: { "../invalid.md": { revision: "a".repeat(64), deleted: false } } },
    { schemaVersion: 1, revision: 1, files: { "Notes/invalid.md": { revision: "a".repeat(64), deleted: "false" } } },
    { schemaVersion: 1, revision: 1, files: { "Notes/invalid.md": { revision: "a".repeat(64), deleted: false, encoding: "utf16" } } },
  ])("malformed manifests are rejected for reads and both upload endpoints (%j)", async (manifest) => {
    globalThis.fetch = (async () => Response.json({ configured: true, manifest })) as typeof fetch;
    const transport = createVaultTransport();
    await expect(transport.manifest()).rejects.toThrow("invalid vault manifest");
    await expect(transport.commit([{ path: "Notes/local.md", content: "# Local", baseRevision: null }])).rejects.toThrow("invalid vault manifest");
    await expect(transport.commit([{ path: "Attachments/local/original.pdf", content: "AP8=", encoding: "base64", baseRevision: null }])).rejects.toThrow("invalid vault manifest");
  });
});
