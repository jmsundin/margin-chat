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
        restoreVaultAttachment: async ({ attachment }: any) => {
          events.push("database");
          return attachment;
        },
        failDocument: async () => undefined,
        deleteDocument: async () => { removed = true; },
      },
      vaultService: {
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

  test("deletion records reach the authoritative vault before removing derived records", async () => {
    const events: string[] = [];
    const service = createDocumentService({
      env: {},
      database: { deleteDocument: async () => { events.push("database"); return true; } },
      vaultService: { deleteAttachment: async () => { events.push("vault"); return true; } },
    });
    expect(await service.delete("document-1", "owner")).toBe(true);
    expect(events).toEqual(["vault", "database"]);
  });
});
