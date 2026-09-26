import { describe, expect, test } from "bun:test";
import type { AppState, Conversation, DocumentGeneration } from "@margin-chat/workspace-contracts";
import { createEmptyState } from "../client/src/initialState";
import { remapVaultMergeAnchors } from "../client/src/lib/vaultMergeAnchors";
import { createMarkdownWorkspace, decodeReadableMarkdown, parseMarkdownWorkspace } from "../client/src/lib/workspaceMarkdown";
import { workspaceFromVault } from "../client/src/lib/vaultWorkspace";
import { acceptDocumentVersion, undoDocumentInsertion } from "../client/src/lib/documentVersions";
import type { VaultFile } from "../client/src/lib/vaultTypes";

const now = "2026-09-25T12:00:00.000Z";
type Files = Record<string, VaultFile>;
function fixture(content = "Before selected after"): AppState {
  const empty = createEmptyState();
  const prototype = empty.conversations[empty.rootId];
  const block = (id: string, text: string) => ({ id, kind: "markdown" as const, content: text, createdAt: now, updatedAt: now, sourceMessageId: "original-message" });
  const anchor = { sourceMessageId: "original-message", sourceBlockId: "source-block", startOffset: content.indexOf("selected"),
    endOffset: content.indexOf("selected") + "selected".length, quote: "selected" };
  const source: Conversation = { ...prototype, id: "source", title: "Source", parentId: null, childIds: ["child"], createdAt: now, updatedAt: now,
    branchAnchor: null, messages: [{ id: "original-message", role: "assistant", content, createdAt: now }],
    notes: [{ id: "annotation", kind: "comment", content: "A margin note", createdAt: now, updatedAt: now, ...anchor }],
    document: { schemaVersion: 1, blocks: [block("source-block", content), block("untouched", "Untouched paragraph.")], prompts: [], generations: [],
      links: [{ id: "link", ...anchor, targetConversationId: "target", createdAt: now }] } };
  const child: Conversation = { ...prototype, id: "child", title: "Child", parentId: "source", childIds: [], createdAt: now, updatedAt: now,
    messages: [], notes: [], branchAnchor: { id: "branch", ...anchor, sourceConversationId: "source", prompt: "Discuss", createdAt: now } };
  const target: Conversation = { ...prototype, id: "target", title: "Target", parentId: null, childIds: [], createdAt: now, updatedAt: now,
    messages: [{ id: "target-message", role: "user", content: "Unrelated original bytes.", createdAt: now }], notes: [], branchAnchor: null };
  return { ...empty, rootId: "source", activeConversationId: "source", conversations: { source, child, target } };
}
function render(state: AppState): Files {
  const workspace = createMarkdownWorkspace(state, now);
  return Object.fromEntries(Object.entries(workspace.files).map(([path, content]) => [path, { content, contentType: "text/markdown" }]));
}
function parse(files: Files) {
  const workspace = workspaceFromVault(files);
  return parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
}
function edit(state: AppState, content: string): AppState {
  const result = structuredClone(state);
  result.conversations.source.document!.blocks[0].content = content;
  return result;
}
function references(state: AppState) {
  return [state.conversations.source.document!.links![0], state.conversations.source.notes![0], state.conversations.child.branchAnchor!];
}
function withGeneration(state: AppState, accepted = false): AppState {
  const result = structuredClone(state);
  const source = result.conversations.source;
  source.messages.push({ id: "output", role: "assistant", content: "Generated answer", createdAt: now });
  source.document!.prompts.push({ id: "prompt", content: "Rewrite", createdAt: now, serviceId: "backend-services", modelId: "smart-routing",
    selection: { blockId: "source-block", from: 7, to: 15, quote: "selected" } });
  const generation: DocumentGeneration = { id: "generation", promptId: "prompt", messageId: "output", createdAt: now,
    serviceId: "backend-services", modelId: "smart-routing", status: "complete", blockIds: [],
    insertion: { blockId: "source-block", offset: 7, replaceTo: 15 } };
  if (accepted) {
    generation.acceptedAt = now;
    generation.blockIds = ["generated"];
    generation.replacement = { blockId: "source-block", offset: 7, content: "Recovered " };
    source.document!.blocks.push({ id: "generated", kind: "markdown", content: "Generated answer", createdAt: now, updatedAt: now,
      generationId: generation.id, sourceMessageId: generation.messageId });
  }
  source.document!.generations.push(generation);
  return result;
}

describe("anchor preservation after automatic vault merges", () => {
  test("rebases links, separate annotation files, and child branch anchors after independent text edits", () => {
    const base = fixture();
    const local = edit(base, "New Before selected after");
    const remote = edit(base, "Before selected after. Cloud suffix.");
    const merged = render(edit(base, "New Before selected after. Cloud suffix."));
    const output = remapVaultMergeAnchors(render(base), render(local), render(remote), merged);
    for (const anchor of references(parse(output))) expect(anchor).toMatchObject({ sourceBlockId: "source-block", startOffset: 11, endOffset: 19, quote: "selected" });
    expect(output).not.toBe(merged);
    const sourcePath = workspaceFromVault(merged).manifest.files.find((file) => file.id === "source")!.path;
    expect(output[sourcePath].content).toContain("New Before selected after. Cloud suffix.");
    expect(Object.keys(output).filter((path) => output[path] !== merged[path])).toHaveLength(3);
  });

  test("is idempotent when the same merge postprocessing repeats", () => {
    const base = render(fixture());
    const local = render(edit(fixture(), "New Before selected after"));
    const result = remapVaultMergeAnchors(base, local, base, local);
    expect(remapVaultMergeAnchors(base, local, base, result)).toBe(result);
  });

  test("rebases metadata at the surviving path when an external title edit has not renamed the file", () => {
    const base = render(fixture());
    const merged = render(edit(fixture(), "New Before selected after"));
    const sourcePath = workspaceFromVault(merged).manifest.files.find((record) => record.id === "source")!.path;
    merged[sourcePath] = { ...merged[sourcePath], content: merged[sourcePath].content.replace('title: "Source"', 'title: "Renamed externally"') };
    const output = remapVaultMergeAnchors(base, merged, base, merged);
    expect(Object.keys(output)).toEqual(Object.keys(merged));
    expect(output[sourcePath]).toBeDefined();
    expect(output[sourcePath].content).toContain('title: "Renamed externally"');
    const state = parse(output);
    expect(state.conversations.source.title).toBe("Renamed externally");
    for (const anchor of references(state)) expect(anchor).toMatchObject({ sourceBlockId: "source-block", startOffset: 11, endOffset: 19, quote: "selected" });
  });

  test("retains exact bytes outside changed metadata and preserves unrelated files by reference", () => {
    const base = render(fixture());
    const merged = render(edit(fixture(), "New Before selected after"));
    const records = workspaceFromVault(merged).manifest.files;
    const sourcePath = records.find((file) => file.id === "source")!.path;
    const targetPath = records.find((file) => file.id === "target")!.path;
    merged[sourcePath] = { ...merged[sourcePath], content: merged[sourcePath].content.replace("---\n", () => "---\ncustom: '$& untouched'\n") + "\n<!-- custom trailing syntax $' -->\r\n" };
    merged["Plain.md"] = { content: "---\r\ncustom: exact\r\n---\r\n\r\n[[Wiki]] $& <custom/>\r\n" };
    merged["_conflicts/other/local/a.md"] = { content: "Recovered source bytes" };
    const output = remapVaultMergeAnchors(base, merged, base, merged);
    const withoutMetadata = (content: string) => decodeReadableMarkdown(content).replace(/^<!-- margin-chat-metadata .+ -->\r?$/m, "");
    expect(withoutMetadata(output[sourcePath].content)).toBe(withoutMetadata(merged[sourcePath].content));
    expect(output[targetPath]).toBe(merged[targetPath]);
    expect(output["Plain.md"]).toBe(merged["Plain.md"]);
    expect(output["_conflicts/other/local/a.md"]).toBe(merged["_conflicts/other/local/a.md"]);
  });

  test("unchanged source content leaves unrelated metadata and raw files untouched", () => {
    const base = render(fixture());
    const changedTitle = fixture();
    changedTitle.conversations.source.title = "Different title";
    const merged = render(changedTitle);
    expect(remapVaultMergeAnchors(base, base, merged, merged)).toBe(merged);
  });

  test("remembers the local provenance of a newly created passage link", () => {
    const baseState = fixture();
    baseState.conversations.source.document!.links = [];
    const localState = edit(baseState, "Local Before selected after");
    localState.conversations.source.document!.links = [{ ...fixture().conversations.source.document!.links![0], startOffset: 13, endOffset: 21 }];
    const mergedState = edit(localState, "Remote Local Before selected after");
    const output = remapVaultMergeAnchors(render(baseState), render(localState), render(baseState), render(mergedState));
    expect(parse(output).conversations.source.document!.links![0]).toMatchObject({ startOffset: 20, endOffset: 28 });
  });

  test("detaches repeated quotes after an ambiguous deletion even when old offsets still match", () => {
    const base = render(fixture("selected, then selected"));
    const merged = render(edit(fixture("selected, then selected"), "selected"));
    const output = remapVaultMergeAnchors(base, merged, base, merged);
    for (const anchor of references(parse(output))) expect(anchor).toMatchObject({ sourceBlockId: "detached:source-block", quote: "selected", startOffset: 0, endOffset: 8 });
  });

  test("legacy message anchors cannot jump to another occurrence of a deleted repeated quote", () => {
    const state = fixture("selected, then selected");
    for (const anchor of references(state)) delete anchor.sourceBlockId;
    const base = render(state);
    const edited = render(edit(state, "selected"));
    const output = remapVaultMergeAnchors(base, edited, base, edited);
    for (const anchor of references(parse(output))) expect(anchor.sourceBlockId).toStartWith("detached:");
  });

  test("moves quotes through a split and detaches deleted source blocks", () => {
    const baseState = fixture();
    const split = edit(baseState, "Before ");
    split.conversations.source.document!.blocks.splice(1, 0, { ...split.conversations.source.document!.blocks[0], id: "suffix", content: "selected after" });
    const base = render(baseState);
    const output = remapVaultMergeAnchors(base, render(split), base, render(split));
    for (const anchor of references(parse(output))) expect(anchor).toMatchObject({ sourceBlockId: "suffix", startOffset: 0, endOffset: 8 });
    const removed = fixture();
    removed.conversations.source.document!.blocks.shift();
    const deleted = remapVaultMergeAnchors(base, render(removed), base, render(removed));
    for (const anchor of references(parse(deleted))) expect(anchor.sourceBlockId).toBe("detached:source-block");
  });

  test("detaches an anchor assembled from incompatible metadata instead of guessing", () => {
    const base = render(fixture());
    const changed = edit(fixture(), "New Before selected after");
    const original = render(changed);
    changed.conversations.source.document!.links![0].startOffset = 8;
    const output = remapVaultMergeAnchors(base, original, base, render(changed));
    expect(parse(output).conversations.source.document!.links![0].sourceBlockId).toBe("detached:source-block");
  });

  test("rebases a pending replacement while keeping its historical prompt selection unchanged", () => {
    const before = withGeneration(fixture());
    const base = render(before);
    const edited = render(edit(before, "New Before selected after"));
    const output = remapVaultMergeAnchors(base, edited, base, edited);
    const source = parse(output).conversations.source;
    expect(source.document!.generations[0].insertion).toEqual({ blockId: "source-block", offset: 11, replaceTo: 19 });
    expect(source.document!.prompts[0].selection).toEqual({ blockId: "source-block", from: 7, to: 15, quote: "selected" });
    const accepted = acceptDocumentVersion(source, "generation", now);
    expect(accepted.document!.blocks.map((block) => block.content).join("")).toContain("New Before Generated answer after");
    expect(remapVaultMergeAnchors(base, edited, base, output)).toBe(output);
  });

  test("makes an ambiguous pending replacement a no-op instead of replacing unrelated text", () => {
    const before = withGeneration(fixture());
    const base = render(before);
    const edited = render(edit(before, "Before completely different text after"));
    const output = remapVaultMergeAnchors(base, edited, base, edited);
    const source = parse(output).conversations.source;
    expect(source.document!.generations[0].insertion!.blockId).toBe("stale-insertion:generation");
    expect(acceptDocumentVersion(source, "generation", now)).toBe(source);
  });

  test("rebases the future undo restoration point without rewriting accepted insertion history", () => {
    const before = withGeneration(fixture(), true);
    const base = render(before);
    const edited = render(edit(before, "New Before selected after"));
    const output = remapVaultMergeAnchors(base, edited, base, edited);
    const source = parse(output).conversations.source;
    expect(source.document!.generations[0].replacement).toEqual({ blockId: "source-block", offset: 11, content: "Recovered " });
    expect(source.document!.generations[0].insertion).toEqual(before.conversations.source.document!.generations[0].insertion);
    const undone = undoDocumentInsertion(source, "generation", now);
    expect(undone.document!.blocks[0].content).toBe("New Before Recovered selected after");
  });

  test("ambiguous restoration cannot collide with an existing block's opaque ID", () => {
    const before = withGeneration(fixture(), true);
    const base = render(before);
    const editedState = edit(before, "Completely rewritten source");
    editedState.conversations.source.document!.blocks.push({ id: "restore:generation", kind: "markdown", content: "Unrelated writing", createdAt: now, updatedAt: now });
    const edited = render(editedState);
    const source = parse(remapVaultMergeAnchors(base, edited, base, edited)).conversations.source;
    expect(source.document!.generations[0].replacement!.blockId).toBe("restore:generation:2");
    const undone = undoDocumentInsertion(source, "generation", now);
    expect(undone.document!.blocks.find((block) => block.id === "restore:generation")!.content).toBe("Unrelated writing");
    expect(undone.document!.blocks.some((block) => block.content === "Recovered ")).toBe(true);
  });

  test("returns invalid or incomplete source contexts unchanged for the caller's validation", () => {
    const valid = render(fixture());
    const broken = { ...valid, "workspace.json": { content: "invalid json" } };
    for (const inputs of [[broken, valid, valid, valid], [valid, broken, valid, valid], [valid, valid, broken, valid], [valid, valid, valid, broken]]) {
      expect(remapVaultMergeAnchors(inputs[0], inputs[1], inputs[2], inputs[3])).toBe(inputs[3]);
    }
  });
});
