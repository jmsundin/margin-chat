import { describe, expect, test } from "bun:test";
import { createDocumentService } from "../server/documents/index.mjs";

function upload() {
  return {
    context: { allowHosted: false, apiKeys: {} },
    file: new File(["# Original\n\nPreserve this even if indexing fails."], "original.md", { type: "text/markdown" }),
    userId: "owner",
  };
}

describe("vault attachment originals", () => {
  test("commits original bytes before deriving database state and retains them after ingestion failure", async () => {
    const events: string[] = [];
    const saved: any[] = [];
    let removed = false;
    const service = createDocumentService({
      env: {},
      database: {
        getVaultAttachment: async () => {
          events.push("database");
          return { ...saved[0].attachment, bytes: saved[0].bytes };
        },
        failDocument: async () => undefined,
        deleteDocument: async () => { removed = true; },
      },
      vaultService: {
        status: async () => ({ projection: { status: "ready" } }),
        persistAttachment: async (value: any) => {
          events.push("vault");
          saved.push(value);
        },
      },
    });
    const result = await service.upload(upload());
    expect(events.slice(0, 2)).toEqual(["vault", "database"]);
    expect(saved[0].bytes.toString()).toBe("# Original\n\nPreserve this even if indexing fails.");
    expect(result.id).toBe(saved[0].attachment.id);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("original file is saved");
    expect(removed).toBe(false);
    expect(saved).toHaveLength(1);
  });

  test("failed vault writes do not create a database-only original or report upload success", async () => {
    let created = false;
    const service = createDocumentService({
      env: {},
      database: {
        restoreVaultAttachment: async () => { created = true; },
      },
      vaultService: {
        persistAttachment: async () => { throw new Error("Cloud unavailable"); },
      },
    });
    await expect(service.upload(upload())).rejects.toThrow("Cloud unavailable");
    expect(created).toBe(false);
  });

  test("cloud deletion delegates derived records to the revision-guarded vault projection", async () => {
    const events: string[] = [];
    const service = createDocumentService({
      env: {},
      database: { deleteDocument: async () => { events.push("database"); return true; } },
      vaultService: { deleteAttachment: async () => { events.push("vault"); return true; } },
    });
    expect(await service.delete("document-1", "owner")).toBe(true);
    expect(events).toEqual(["vault"]);
  });

  test("database-only deletion remains available for legacy storage", async () => {
    const deleted: unknown[] = [];
    const service = createDocumentService({ env: {}, database: {
      deleteDocument: async (value: unknown) => { deleted.push(value); return true; },
    } });
    expect(await service.delete("document-1", "owner")).toBe(true);
    expect(deleted).toEqual([{ documentId: "document-1", userId: "owner" }]);
  });

  test("deleting a saved original succeeds even when its feature row was never created", async () => {
    const service = createDocumentService({
      env: {},
      database: { deleteDocument: async () => false },
      vaultService: { deleteAttachment: async () => true },
    });
    expect(await service.delete("saved-original", "owner")).toBe(true);
  });

  test("a provider restriction prevents document embedding and indexing calls", async () => {
    let calls = 0;
    const service = createDocumentService({ env: {}, database: {
      getVaultAttachment: async () => { calls++; },
      findRelevantDocumentChunks: async () => { calls++; },
    }, vaultService: {} });
    const result = await service.retrieveContext({
      allowedProviders: ["gemini"], context: {},
      chatRequest: { conversation: { documents: [{ id: "doc" }] }, messages: [{ role: "user", content: "Summarize it" }] },
    });
    expect(calls).toBe(0);
    expect(result).toEqual({ chunks: [], instruction: null, sources: [], warnings: ["Document search was skipped because its embedding provider is not allowed."] });
  });
});
