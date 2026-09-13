import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVaultService } from "../server/vault/index.mjs";
import { createFileVaultStorage } from "../server/vault/storage.mjs";
import { createVaultTransport } from "../client/src/lib/vaultApi";
import { vaultToState } from "../client/src/lib/vaultWorkspace";
import { createEmptyState } from "../client/src/initialState";
import { sameVaultFile } from "../client/src/lib/vaultTypes";

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
});
