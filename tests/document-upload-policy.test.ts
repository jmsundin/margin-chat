import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createApiHandler } from "../server/routes/api.mjs";
import { createDocumentService } from "../server/documents/index.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("document provider policy", () => {
  for (const useVault of [false, true]) {
    test(`${useVault ? "vault" : "legacy"} originals survive excluded indexing and can be indexed after permission changes`, async () => {
      const original = Buffer.from("# Private source\n\nKeep this document until its provider is permitted.");
      let stored: any = null;
      let vaulted: any = null;
      let networkCalls = 0;
      let deletions = 0;
      let completed = 0;
      const database = {
        async createDocument(args: any) { stored = { ...args }; return { ...stored }; },
        async getVaultAttachment() { return stored ? { ...stored, bytes: Buffer.from(stored.bytes) } : null; },
        async failDocument({ error }: any) { stored = { ...stored, status: "failed", error }; return stored; },
        async deleteDocument() { deletions++; stored = null; return true; },
        async completeDocument({ sourceBytes }: any) {
          expect(sourceBytes).toEqual(original);
          completed++;
          stored = { ...stored, status: "ready", error: null };
          return { id: stored.id, filename: stored.filename, status: "ready", error: null };
        },
        async findRelevantDocumentChunks() {
          return [{ documentId: stored.id, filename: stored.filename, content: original.toString(), chunkIndex: 0, pageNumber: null }];
        },
      };
      const service = createDocumentService({
        env: { OPENAI_API_KEY: "test-hosted-key" }, database,
        vaultService: useVault ? {
          async persistAttachment({ attachment, bytes }: any) { vaulted = { ...attachment, bytes: Buffer.from(bytes) }; },
          async status() { stored = { ...vaulted, bytes: Buffer.from(vaulted.bytes) }; return { projection: { status: "ready" } }; },
        } : null,
      });
      globalThis.fetch = (async () => { networkCalls++; throw new Error("Excluded provider must not be called"); }) as typeof fetch;
      const result = await service.upload({
        userId: "owner", context: { allowHosted: true, apiKeys: {}, allowedProviders: ["gemini"] },
        file: new File([original], "private.md", { type: "text/markdown" }),
      });
      expect(result.status).toBe("failed");
      expect(result.error).toContain("OpenAI is not permitted");
      expect(result).not.toHaveProperty("bytes");
      expect(stored.bytes).toEqual(original);
      if (useVault) expect(vaulted.bytes).toEqual(original);
      expect(networkCalls).toBe(0);
      expect(deletions).toBe(0);
      expect(completed).toBe(0);

      globalThis.fetch = (async (_input, init) => {
        networkCalls++;
        const body = JSON.parse(String(init?.body));
        return Response.json({ data: body.input.map((_text: string, index: number) => ({ index, embedding: Array(1536).fill(0.1) })) });
      }) as typeof fetch;
      const context = await service.retrieveContext({
        allowedProviders: ["openai"], context: { userId: "owner", allowHosted: true, apiKeys: {} },
        chatRequest: { conversation: { documents: [{ id: result.id }] }, messages: [{ role: "user", content: "Summarize the source" }] },
      });
      expect(completed).toBe(1);
      expect(networkCalls).toBe(2);
      expect(stored.status).toBe("ready");
      expect(stored.bytes).toEqual(original);
      expect(context.sources).toEqual([{ kind: "document", id: result.id, title: "private.md", excerpt: original.toString() }]);
      expect(context.instruction).toContain("Keep this document");
    });
  }

  test("multipart AI settings are validated before upload and propagated to indexing context", async () => {
    const calls: any[] = [];
    const handler = createApiHandler({
      runtimeConfig: { host: "127.0.0.1", port: 8787 },
      authService: { async getAuthContext() { return { user: { id: "owner", billing: { hasAccess: true } } }; } },
      apiKeyService: { async getDecryptedKeys() { return {}; } },
      chatService: { createUsageMeter: () => ({}) },
      documentService: { async upload(args: any) { calls.push(args); return { id: "document", status: "failed" }; } },
    } as any);
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/documents`;
    const send = async (ai?: string | Blob) => {
      const form = new FormData();
      form.set("file", new File(["Source"], "source.txt", { type: "text/plain" }));
      if (ai !== undefined) form.set("ai", ai);
      const response = await originalFetch(url, { method: "POST", headers: { "X-Margin-Vault-User": "owner" }, body: form });
      await response.json();
      return response.status;
    };
    try {
      expect(await send(JSON.stringify({ allowedProviders: ["gemini"] }))).toBe(201);
      expect(calls[0].context.allowedProviders).toEqual(["gemini"]);
      expect(await send(JSON.stringify({ allowedProviders: [] }))).toBe(201);
      expect(calls[1].context.allowedProviders).toEqual([]);
      expect(await send()).toBe(201);
      expect(calls[2].context.allowedProviders).toBeUndefined();
      for (const input of ["not JSON", "null", "[]", '{"allowedProviders":["unsupported"]}', new Blob(["{}"])]) {
        expect(await send(input)).toBe(400);
      }
      expect(calls).toHaveLength(3);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
