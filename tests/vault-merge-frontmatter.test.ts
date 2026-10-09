import { describe, expect, test } from "bun:test";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { mergeVaultFile } from "../client/src/lib/vaultMerge";
import { createMarkdownWorkspace, discoverMarkdownWorkspace, parseMarkdownWorkspace } from "../client/src/lib/workspaceMarkdown";
import { decodeReadableMarkdown, readFrontmatterValues } from "@margin-chat/workspace-contracts";
import type { VaultFile } from "../client/src/lib/vaultTypes";

const file = (content: string): VaultFile => ({ content, contentType: "text/markdown" });
const merge = (base: string, local: string, remote: string) => mergeVaultFile("Note.md", file(base), file(local), file(remote));
const values = (content: string | undefined) => readFrontmatterValues(decodeReadableMarkdown(content ?? ""));
const plain = (frontmatter: string[], body = "# Note\n\nBody.") => `---\n${frontmatter.join("\n")}\n---\n${body}`;

describe("frontmatter merge", () => {
  test("links added to the same relation on two devices are both kept", () => {
    const base = plain(['cites: ["[[A]]"]']);
    const result = merge(base, plain(['cites: ["[[A]]", "[[B]]"]']), plain(['cites: ["[[A]]", "[[C]]"]']));
    expect(result.conflicted).toBe(false);
    expect(values(result.file?.content).cites).toEqual(["[[A]]", "[[C]]", "[[B]]"]);
  });

  test("a removed link stays removed while a concurrent addition survives", () => {
    const base = plain(['cites: ["[[A]]", "[[B]]"]']);
    const result = merge(base, plain(['cites: ["[[B]]"]']), plain(['cites: ["[[A]]", "[[B]]", "[[C]]"]']));
    expect(result.conflicted).toBe(false);
    expect(values(result.file?.content).cites).toEqual(["[[B]]", "[[C]]"]);
  });

  test("block-style lists written by Obsidian merge with the app's one-line lists", () => {
    const base = plain(["tags:", "  - physics", "custom: keep"]);
    const local = plain(["tags:", "  - physics", "  - quantum", "custom: keep"]);
    const remote = plain(['tags: ["physics", "open-question"]', "custom: keep"]);
    const result = merge(base, local, remote);
    expect(result.conflicted).toBe(false);
    expect(values(result.file?.content)).toEqual({ tags: ["physics", "open-question", "quantum"], custom: "keep" });
  });

  test("different properties edited on two devices both land, and new properties keep their place", () => {
    const base = plain(["title: Note", "custom: keep"]);
    const local = plain(["title: Note", "type: question", "custom: keep"]);
    const remote = plain(["title: Note", "custom: keep", 'supports: ["[[Claim]]"]']);
    const result = merge(base, local, remote);
    expect(result.conflicted).toBe(false);
    expect(result.file?.content).toBe(plain(["title: Note", "type: question", "custom: keep", 'supports: ["[[Claim]]"]']));
  });

  test("edge attributes merge per edge and per attribute", () => {
    const base = plain(['edge-meta: {"cites/a": {"weight": 0.5}}']);
    const local = plain(['edge-meta: {"cites/a": {"weight": 0.5, "note": "key paper"}}']);
    const remote = plain(["edge-meta:", "  cites/a:", "    weight: 0.8", "  supports/b:", "    origin: ai"]);
    const result = merge(base, local, remote);
    expect(result.conflicted).toBe(false);
    expect(values(result.file?.content)["edge-meta"]).toEqual({ "cites/a": { weight: 0.8, note: "key paper" }, "supports/b": { origin: "ai" } });
  });

  test("the same property changed two ways keeps the newer document and reports it", () => {
    const base = plain(["updated: 2026-10-01T00:00:00.000Z", "type: claim"]);
    const local = plain(["updated: 2026-10-03T00:00:00.000Z", "type: question"]);
    const remote = plain(["updated: 2026-10-02T00:00:00.000Z", "type: source"]);
    const result = merge(base, local, remote);
    expect(result.conflicted).toBe(true);
    expect(values(result.file?.content).type).toBe("question");
  });

  test("relations added on two devices to an app document both survive a sync merge", () => {
    const state = createEmptyState();
    for (const [id, title] of [["source", "Source"], ["a", "A"], ["b", "B"]] as const) {
      const note = createStandaloneNoteConversation({ createdAt: "2026-10-01T10:00:00.000Z", id, noteId: `${id}-note` });
      note.title = title;
      state.conversations[id] = note;
    }
    const base = createMarkdownWorkspace(state, "2026-10-01T12:00:00.000Z");
    const path = base.manifest.files.find((record) => record.id === "source")!.path;
    const edit = (target: string, updatedAt: string) => {
      const next = parseMarkdownWorkspace(base.manifest, base.files)!;
      next.conversations.source.relations = [{ type: "cites", targetConversationId: target, origin: "user" }];
      next.conversations.source.updatedAt = updatedAt;
      return createMarkdownWorkspace(next, "2026-10-01T12:00:00.000Z", base).files[path];
    };
    const result = mergeVaultFile(path, file(base.files[path]), file(edit("a", "2026-10-02T00:00:00.000Z")), file(edit("b", "2026-10-03T00:00:00.000Z")));
    expect(result.conflicted).toBe(false);
    const workspace = discoverMarkdownWorkspace({ ...base.files, [path]: result.file!.content }, base.manifest);
    const merged = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
    expect(merged.conversations.source.relations).toEqual([
      { type: "cites", targetConversationId: "b", origin: "user" },
      { type: "cites", targetConversationId: "a", origin: "user" },
    ]);
    expect(merged.conversations.source.updatedAt).toBe("2026-10-03T00:00:00.000Z");
  });
});
