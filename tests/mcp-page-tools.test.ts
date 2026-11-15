import { describe, expect, test } from "bun:test";
import { vaultFileDocumentId } from "@margin-chat/workspace-contracts";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import { MAX_PAGE_VERSIONS, applyPageEdits, createPageTools, pageVersionPath } from "../server/mcp/pageTools.mjs";
import { mcpToolsFor } from "../server/mcp/index.mjs";

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  return {
    kind: "memory", objects,
    async read(key: string) { const bytes = objects.get(key); return bytes ? { bytes: Buffer.from(bytes), etag: digest(bytes) } : null; },
    async putImmutable(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      if ((objects.has(key) ? digest(objects.get(key)!) : null) !== expected) return false;
      objects.set(key, Buffer.from(bytes)); return true;
    },
  };
}

const base64 = (text: string) => Buffer.from(text).toString("base64");
const PAGE = "<!doctype html><title>Glider</title><h1>Level 1</h1><script src=\"vendor/engine.js\"></script>";

async function setup(hidden: string[] = []) {
  const vault = createVaultService({ storage: memoryStorage() });
  await vault.commit("jon", [
    { path: "Glider Gauntlet/Glider Gauntlet.html", content: base64(PAGE), encoding: "base64", contentType: "text/html", baseRevision: null },
    { path: "Glider Gauntlet/vendor/engine.js", content: base64("var level = 1;\nvar lives = 3;\n"), encoding: "base64", contentType: "text/javascript", baseRevision: null },
    { path: "Glider Gauntlet/vendor/engine.wasm", content: base64("\0asm"), encoding: "base64", contentType: "application/wasm", baseRevision: null },
    { path: "Glider Gauntlet/Notes.md", content: "# My notes", baseRevision: null },
    { path: "Journal.md", content: "# Private", baseRevision: null },
    { path: "Lone.html", content: base64("<p>alone</p>"), encoding: "base64", contentType: "text/html", baseRevision: null },
    { path: "app.js", content: base64("1"), encoding: "base64", contentType: "text/javascript", baseRevision: null },
  ]);
  const database = { listAIHiddenIds: async () => hidden };
  const tools = createPageTools({ userId: "jon", vault, database, now: () => new Date("2026-11-15T20:40:00.000Z") });
  const text = async (path: string) => (await vault.readFile({ userId: "jon", path })).bytes.toString("utf8");
  return { vault, tools, text };
}

describe("page tools for connected apps", () => {
  test("only a write token gets them", () => {
    const names = (scope: string) => mcpToolsFor(scope).map((tool: { name: string }) => tool.name);
    expect(names("write")).toContain("edit_page_file");
    expect(names("write")).toContain("read_page_file");
    expect(names("read")).not.toContain("read_page_file");
  });

  test("lists pages with the files beside them", async () => {
    const { tools } = await setup();
    const listed = await tools.run("read_page_file", { path: "" });
    expect(listed.pages.map((page: { path: string }) => page.path)).toEqual(["Glider Gauntlet/Glider Gauntlet.html", "Lone.html"]);
    expect(listed.pages[0].files.map((file: { path: string; editable: boolean }) => [file.path, file.editable])).toEqual([
      ["Glider Gauntlet/Notes.md", false], ["Glider Gauntlet/vendor/engine.js", true], ["Glider Gauntlet/vendor/engine.wasm", false]]);
    // A page at the top of the vault has nothing beside it: everything would be.
    expect(listed.pages[1].files).toEqual([]);
  });

  test("reads a file in parts and finds text in it", async () => {
    const { tools } = await setup();
    const part = await tools.run("read_page_file", { path: "Glider Gauntlet/Glider Gauntlet.html", offset: 15, limit: 21 });
    expect(part).toMatchObject({ ok: true, offset: 15, text: "<title>Glider</title>", next_offset: 36, total_characters: PAGE.length });
    const found = await tools.run("read_page_file", { path: "Glider Gauntlet/vendor/engine.js", search: "var " });
    expect(found.total_matches).toBe(2);
    expect(found.matches.map((match: { offset: number }) => match.offset)).toEqual([0, 15]);
  });

  test("edits a page in place and keeps the version it replaced", async () => {
    const { tools, text, vault } = await setup();
    const path = "Glider Gauntlet/Glider Gauntlet.html";
    const { revision_id } = await tools.run("read_page_file", { path });
    const edited = await tools.run("edit_page_file", { path, base_revision_id: revision_id, edits: [{ old_text: "Level 1", new_text: "Level 2" }] });
    expect(edited).toMatchObject({ ok: true, changed: true, previous_version: pageVersionPath(path, "2026-11-15T20:40:00.000Z") });
    expect(await text(path)).toBe(PAGE.replace("Level 1", "Level 2"));
    expect(await text(edited.previous_version)).toBe(PAGE);
    // Saved as the upload was, so the app still opens it as a page.
    expect((await vault.status("jon")).manifest.files[path]).toMatchObject({ encoding: "base64", contentType: "text/html" });
    // The revision that was read is gone; a second writer is told to read again.
    expect((await tools.run("edit_page_file", { path, base_revision_id: revision_id, content: "<p>stale</p>" })).error).toContain("changed since you read it");
    expect(await text(path)).toContain("Level 2");
  });

  test("keeps only the newest versions of a file that is edited often", async () => {
    const storage = memoryStorage();
    const vault = createVaultService({ storage });
    const path = "Game/Game.html";
    await vault.commit("jon", [{ path, content: base64("v0"), encoding: "base64", contentType: "text/html", baseRevision: null }]);
    let minute = 0;
    const tools = createPageTools({ userId: "jon", vault, now: () => new Date(Date.UTC(2026, 10, 15, 20, minute += 1)) });
    for (let version = 1; version <= MAX_PAGE_VERSIONS + 3; version += 1) {
      const { revision_id } = await tools.run("read_page_file", { path });
      expect((await tools.run("edit_page_file", { path, base_revision_id: revision_id, content: `v${version}` })).ok).toBe(true);
    }
    const files = (await vault.status("jon")).manifest.files as Record<string, { deleted?: boolean }>;
    const kept = Object.keys(files).filter((other) => other.startsWith(".margin-chat/page-versions/") && !files[other]!.deleted).sort();
    expect(kept).toHaveLength(MAX_PAGE_VERSIONS);
    // The oldest went first: v0 to v2 are gone, v3 is the oldest kept.
    expect((await vault.readFile({ userId: "jon", path: kept[0]! })).bytes.toString("utf8")).toBe("v3");
  });

  test("an edit that doesn't match exactly once changes nothing", async () => {
    const { tools, text } = await setup();
    const path = "Glider Gauntlet/vendor/engine.js";
    const { revision_id } = await tools.run("read_page_file", { path });
    expect((await tools.run("edit_page_file", { path, base_revision_id: revision_id, edits: [{ old_text: "var ", new_text: "let " }] })).error).toContain("more than once");
    expect((await tools.run("edit_page_file", { path, base_revision_id: revision_id, edits: [{ old_text: "missing", new_text: "x" }] })).error).toContain("isn't in the file");
    expect(await text(path)).toBe("var level = 1;\nvar lives = 3;\n");
    expect(applyPageEdits("a b a", [{ old_text: "b", new_text: "c" }, { old_text: "a c", new_text: "d" }])).toEqual({ ok: true, text: "d a" });
  });

  test("adds a new file in a page's folder", async () => {
    const { tools, text } = await setup();
    const added = await tools.run("edit_page_file", { path: "Glider Gauntlet/data/questions.json", content: "[]" });
    expect(added).toMatchObject({ ok: true, created: true });
    expect(await text("Glider Gauntlet/data/questions.json")).toBe("[]");
  });

  test("notes, files outside a page's folder and Margin Chat's own folders are out of reach", async () => {
    const { tools, text } = await setup();
    for (const path of ["Journal.md", "Glider Gauntlet/Notes.md", "app.js", "Glider Gauntlet/vendor/engine.wasm", "Glider Gauntlet/../Journal.md",
      ".margin-chat/page-data/x.json", "Elsewhere/new.js", "Glider Gauntlet/.secret.js"]) {
      expect((await tools.run("read_page_file", { path })).ok).toBe(false);
      expect((await tools.run("edit_page_file", { path, content: "x" })).ok).toBe(false);
    }
    expect(await text("Journal.md")).toBe("# Private");
  });

  test("a page hidden from AI is neither listed, read nor edited, with its folder", async () => {
    const { tools } = await setup([vaultFileDocumentId("Glider Gauntlet/Glider Gauntlet.html")]);
    expect((await tools.run("read_page_file", { path: "" })).pages.map((page: { path: string }) => page.path)).toEqual(["Lone.html"]);
    expect((await tools.run("read_page_file", { path: "Glider Gauntlet/Glider Gauntlet.html" })).ok).toBe(false);
    expect((await tools.run("read_page_file", { path: "Glider Gauntlet/vendor/engine.js" })).ok).toBe(false);
    expect((await tools.run("edit_page_file", { path: "Glider Gauntlet/vendor/new.js", content: "1" })).ok).toBe(false);
  });
});
