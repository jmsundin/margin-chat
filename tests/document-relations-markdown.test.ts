import { describe, expect, test } from "bun:test";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { createMarkdownWorkspace, decodeReadableMarkdown, discoverMarkdownWorkspace, parseMarkdownWorkspace } from "../client/src/lib/workspaceMarkdown";
import { readFrontmatterValues, extractMarkdownWikiLinks, parseWikiLink } from "@margin-chat/workspace-contracts";
import type { AppState } from "../client/src/types";

function note(state: AppState, id: string, title: string, content = "") {
  const conversation = createStandaloneNoteConversation({ createdAt: "2026-10-01T10:00:00.000Z", id, noteId: `${id}-note` });
  conversation.title = title;
  conversation.notes![0].content = content;
  state.conversations[id] = conversation;
  return conversation;
}

function pathOf(workspace: ReturnType<typeof createMarkdownWorkspace>, id: string) {
  return workspace.manifest.files.find((record) => record.id === id)!.path;
}

describe("typed relations in Markdown", () => {
  test("writes relations, node type and tags as Obsidian properties and reads them back", () => {
    const state = createEmptyState();
    const claim = note(state, "claim", "Margin: correlation?", "Not causation!");
    note(state, "bell", "Bell test");
    note(state, "aspect", "Aspect 1982");
    claim.nodeType = "question";
    claim.tags = ["physics/quantum", "open-question"];
    claim.relations = [
      { type: "contradicts", targetConversationId: "bell", weight: 0.9, origin: "ai", sourceBlockId: "n1", note: "Bell violations" },
      { type: "cites", targetConversationId: "aspect", targetBlockId: "r3" },
      { type: "supports", target: "Not in this vault" },
    ];
    const workspace = createMarkdownWorkspace(state, "2026-10-01T12:00:00.000Z");
    const source = decodeReadableMarkdown(workspace.files[pathOf(workspace, "claim")]);
    const values = readFrontmatterValues(source);
    const bell = pathOf(workspace, "bell").replace(/\.md$/, "");
    const aspect = pathOf(workspace, "aspect").replace(/\.md$/, "");
    expect(values.type).toBe("question");
    expect(values.tags).toEqual(["margin-chat", "document", "physics/quantum", "open-question"]);
    expect(values.contradicts).toEqual([`[[${bell}|Bell test]]`]);
    expect(values.cites).toEqual([`[[${aspect}#^r3|Aspect 1982]]`]);
    expect(values.supports).toEqual(["[[Not in this vault]]"]);
    expect(values["edge-meta"]).toEqual({ "contradicts/bell": { weight: 0.9, origin: "ai", from: "n1", note: "Bell violations" } });
    // The JSON registry never holds a second copy of graph data.
    expect(source).not.toContain('"relations"');
    expect(source).not.toContain('"nodeType"');

    const parsed = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
    expect(parsed.conversations.claim.nodeType).toBe("question");
    expect(parsed.conversations.claim.tags).toEqual(["physics/quantum", "open-question"]);
    expect(parsed.conversations.claim.relations).toEqual([
      { type: "supports", target: "Not in this vault" },
      { type: "contradicts", targetConversationId: "bell", sourceBlockId: "n1", weight: 0.9, origin: "ai", note: "Bell violations" },
      { type: "cites", targetConversationId: "aspect", targetBlockId: "r3" },
    ]);
    // A second render of the parsed state is byte-identical.
    expect(createMarkdownWorkspace(parsed, "2026-10-01T12:00:00.000Z", workspace).files).toEqual(workspace.files);
  });

  test("reads relations, types and tags written by Obsidian in block style", () => {
    const files = {
      "Local realism.md": "# Local realism\n\nHidden variables.",
      "Bell test.md": [
        "---",
        "type: claim",
        "tags:",
        "  - physics",
        "  - margin-chat",
        "contradicts:",
        '  - "[[Local realism]]"',
        "supports: \"[[Missing note]]\"",
        "edge-meta:",
        "  contradicts/Local realism:",
        "    weight: 0.75",
        "author: \"[[Someone]]\"",
        "---",
        "# Bell test",
        "",
        "See [[Local realism]].",
      ].join("\n"),
    };
    const workspace = discoverMarkdownWorkspace(files);
    const state = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
    const bell = Object.values(state.conversations).find((conversation) => conversation.title === "Bell test")!;
    const realism = Object.values(state.conversations).find((conversation) => conversation.title === "Local realism")!;
    expect(bell.nodeType).toBe("claim");
    expect(bell.tags).toEqual(["physics"]);
    // Only vocabulary properties become relations; `author` stays an ordinary property.
    expect(bell.relations).toEqual([
      { type: "supports", target: "Missing note" },
      { type: "contradicts", targetConversationId: realism.id, weight: 0.75 },
    ]);
    // Unchanged documents keep their exact bytes.
    expect(createMarkdownWorkspace(state, undefined, workspace).files).toEqual(files);
  });

  test("an in-app relation change replaces the whole property and leaves other properties alone", () => {
    const files = {
      "Target.md": "# Target",
      "Other.md": "# Other",
      "Source.md": "---\ncustom: keep me\ncites:\n  - \"[[Target]]\"\n# a comment\n---\n# Source\n\nBody.",
    };
    const workspace = discoverMarkdownWorkspace(files);
    const state = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
    const ids = Object.fromEntries(Object.values(state.conversations).map((conversation) => [conversation.title, conversation.id]));
    const source = state.conversations[ids.Source];
    expect(source.relations).toEqual([{ type: "cites", targetConversationId: ids.Target }]);
    source.relations = [...source.relations!, { type: "cites", targetConversationId: ids.Other, origin: "user" }];
    source.notes![0].content += "\nEdited.";
    const updated = createMarkdownWorkspace(state, undefined, workspace);
    const text = decodeReadableMarkdown(updated.files["Source.md"]);
    expect(text).toContain("custom: keep me");
    expect(text).toContain("# a comment");
    expect(text).not.toMatch(/^ {2}- "\[\[Target\]\]"$/m);
    expect(readFrontmatterValues(text).cites).toEqual(["[[Target|Target]]", "[[Other|Other]]"]);
    const reparsed = parseMarkdownWorkspace(updated.manifest, updated.files)!;
    expect(reparsed.conversations[ids.Source].relations).toEqual([
      { type: "cites", targetConversationId: ids.Target },
      { type: "cites", targetConversationId: ids.Other, origin: "user" },
    ]);

    reparsed.conversations[ids.Source].relations = [];
    const removed = createMarkdownWorkspace(reparsed, undefined, updated);
    const removedText = decodeReadableMarkdown(removed.files["Source.md"]);
    expect(readFrontmatterValues(removedText).cites).toBeUndefined();
    expect(readFrontmatterValues(removedText)["edge-meta"]).toBeUndefined();
    expect(removedText).toContain("custom: keep me");
  });

  test("renaming a target rewrites the link to its new file", () => {
    const state = createEmptyState();
    const source = note(state, "source", "Source");
    note(state, "target", "Target");
    source.relations = [{ type: "part-of", targetConversationId: "target" }];
    const first = createMarkdownWorkspace(state, "2026-10-01T12:00:00.000Z");
    const parsed = parseMarkdownWorkspace(first.manifest, first.files)!;
    parsed.conversations.target.title = "Renamed target";
    const second = createMarkdownWorkspace(parsed, "2026-10-01T12:00:00.000Z", first);
    const values = readFrontmatterValues(decodeReadableMarkdown(second.files[pathOf(second, "source")]));
    expect(values["part-of"]).toEqual([`[[${pathOf(second, "target").replace(/\.md$/, "")}|Renamed target]]`]);
    expect(parseMarkdownWorkspace(second.manifest, second.files)!.conversations.source.relations).toEqual([{ type: "part-of", targetConversationId: "target" }]);
  });
});

describe("wiki links in prose", () => {
  test("finds links and typed inline fields outside code", () => {
    const links = extractMarkdownWikiLinks([
      "See [[Bell test#^r3|the test]] and [supports:: [[Claim]]].",
      "depends-on:: [[Base]]",
      "`[[Not a link]]`",
      "```",
      "[[Also not]]",
      "```",
      "![[Diagram.png]] %%[[hidden]]%%",
    ].join("\n"));
    expect(links.map(({ target, blockId, type, embed }) => ({ target, blockId, type, embed }))).toEqual([
      { target: "Bell test", blockId: "r3", type: undefined, embed: false },
      { target: "Claim", blockId: undefined, type: "supports", embed: false },
      { target: "Base", blockId: undefined, type: "depends-on", embed: false },
      { target: "Diagram.png", blockId: undefined, type: undefined, embed: true },
    ]);
    expect(parseWikiLink("[[Doc#Heading|Label]]")).toEqual({ target: "Doc", heading: "Heading", label: "Label" });
    expect(parseWikiLink("plain text")).toBeNull();
  });
});
