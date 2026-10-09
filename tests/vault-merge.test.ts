import { describe, expect, test } from "bun:test";
import { createEmptyState } from "../client/src/initialState";
import { mergeVaultFile } from "../client/src/lib/vaultMerge";
import { createMarkdownWorkspace, decodeReadableMarkdown, encodeReadableMarkdown, isReadableMarkdown, discoverMarkdownWorkspace, parseMarkdownWorkspace } from "../client/src/lib/workspaceMarkdown";
import type { VaultFile } from "../client/src/lib/vaultTypes";

const file = (content: string): VaultFile => ({ content, contentType: "text/markdown" });
const date = "2026-09-01T00:00:00.000Z";
const merge = (base: string, local: string, remote: string) => mergeVaultFile("Note.md", file(base), file(local), file(remote));

function document(blocks: [string, string][]) {
  const state = createEmptyState();
  const conversation = state.conversations[state.rootId];
  conversation.document = { schemaVersion: 1, blocks: blocks.map(([id, content]) => ({ id, content, kind: "markdown", createdAt: date, updatedAt: date })), prompts: [], generations: [] };
  // Retain explicit legacy fixtures while exercising mixed/readable files below.
  return { state, id: conversation.id, render: () => decodeReadableMarkdown(Object.values(createMarkdownWorkspace(state).files)[0]) };
}

function blocks(source: string) {
  const workspace = discoverMarkdownWorkspace({ "Note.md": source });
  const state = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
  return Object.values(state.conversations)[0].document!.blocks.map(({ id, content }) => [id, content]);
}

describe("three-way vault merge", () => {
  test("equal and one-sided changes preserve exact files", () => {
    const base = file("Original\r\n");
    const next = file("Updated\r\n");
    expect(mergeVaultFile("Note.md", base, next, next)).toEqual({ file: next, conflicted: false });
    expect(mergeVaultFile("Note.md", base, base, next)).toEqual({ file: next, conflicted: false });
    expect(mergeVaultFile("Note.md", base, next, base)).toEqual({ file: next, conflicted: false });
  });

  test("combines separate paragraphs and disjoint edits within a paragraph", () => {
    expect(merge("First.\n\nSecond.", "First local.\n\nSecond.", "First.\n\nSecond remote.")).toEqual({ file: file("First local.\n\nSecond remote."), conflicted: false });
    expect(merge("The cat likes the red chair.", "The dog likes the red chair.", "The cat likes the blue chair.")).toEqual({ file: file("The dog likes the blue chair."), conflicted: false });
  });

  test("keeps cloud wording for overlapping edits and independent local edits", () => {
    const result = merge("Launch Friday.\n\nOwner Pat.", "Launch Monday.\n\nOwner Alex.", "Launch Tuesday.\n\nOwner Pat.");
    expect(result.file?.content).toBe("Launch Tuesday.\n\nOwner Alex.");
    expect(result.conflicted).toBe(true);
  });

  test("handles multiple overlaps and keeps separate edits within the same line", () => {
    const result = merge("Red cat sits. Blue dog runs. Large bird flies.", "Green cat sits. Black dog runs. Small bird flies.", "White cat sits. Gray dog runs. Large bird flies.");
    expect(result.file?.content).toBe("White cat sits. Gray dog runs. Small bird flies.");
    expect(result.conflicted).toBe(true);
  });

  test("identical overlapping changes are accepted once", () => {
    expect(merge("A red chair.\n\nEnd.", "A blue chair.\n\nLocal end.", "A blue chair.\n\nEnd.")).toEqual({ file: file("A blue chair.\n\nLocal end."), conflicted: false });
  });

  test("preserves unknown syntax and byte-identical untouched sections", () => {
    const custom = "---\r\ncustom: |\r\n  $& quoted 'value'\r\n---\r\n\r\n<custom data-x='a'>\r\n{{template}} [[Research|label]]\r\n</custom>\r\n\r\n";
    const base = `${custom}First red paragraph.\r\n\r\nSecond blue paragraph.\r\n`;
    const result = merge(base, base.replace("red", "green"), base.replace("blue", "purple"));
    expect(result.conflicted).toBe(false);
    expect(result.file?.content).toBe(base.replace("red", "green").replace("blue", "purple"));
  });

  test("an edit beats a concurrent delete of a document and reports the conflict", () => {
    expect(mergeVaultFile("Note.md", file("Base"), null, file("Remote edit"))).toEqual({ file: file("Remote edit"), conflicted: true });
    expect(mergeVaultFile("Note.md", file("Base"), file("Local edit"), null)).toEqual({ file: file("Local edit"), conflicted: true });
    expect(mergeVaultFile("Note.md", file("Base"), file("Base"), null)).toEqual({ file: null, conflicted: false });
    // Other files keep the deletion.
    expect(mergeVaultFile("image.png", { content: "AQ==", encoding: "base64" }, { content: "Ag==", encoding: "base64" }, null)).toEqual({ file: null, conflicted: true });
  });

  test("unknown ancestry, binary and unsupported formats choose a recoverable cloud version", () => {
    expect(mergeVaultFile("Note.md", null, file("Local"), file("Cloud"))).toEqual({ file: file("Cloud"), conflicted: true });
    const remote = { content: "AA==", encoding: "base64" as const };
    expect(mergeVaultFile("image.png", { content: "AQ==", encoding: "base64" }, { content: "Ag==", encoding: "base64" }, remote)).toEqual({ file: remote, conflicted: true });
    expect(mergeVaultFile("data.json", file('{"x":0}'), file('{"x":1}'), file('{"x":2}')).conflicted).toBe(true);
  });

  test("bounds work for a large region with no useful common baseline", () => {
    const base = Array.from({ length: 1100 }, (_, i) => `base${i}`).join(" ");
    const local = Array.from({ length: 1100 }, (_, i) => `local${i}`).join(" ");
    const remote = Array.from({ length: 1100 }, (_, i) => `remote${i}`).join(" ");
    expect(merge(base, local, remote)).toEqual({ file: file(remote), conflicted: true });
  });
});

describe("stable document blocks", () => {
  test("merges different blocks and regenerates accurate content lengths", () => {
    const fixture = document([["one", "First."], ["two", "Second."]]);
    const base = fixture.render();
    fixture.state.conversations[fixture.id].document!.blocks[0].content = "A longer first paragraph.";
    const local = fixture.render();
    fixture.state.conversations[fixture.id].document!.blocks[0].content = "First.";
    fixture.state.conversations[fixture.id].document!.blocks[1].content = "Another second paragraph.";
    const result = merge(base, local, fixture.render());
    expect(result.conflicted).toBe(false);
    expect(blocks(result.file!.content)).toEqual([["one", "A longer first paragraph."], ["two", "Another second paragraph."]]);
    expect(result.file?.content).toContain('"contentLength":25');
  });

  test("merges disjoint edits inside a stable block", () => {
    const fixture = document([["one", "The cat likes the red chair."]]);
    const base = fixture.render();
    const result = merge(base, base.replace("The cat likes", "The dog likes"), base.replace("red chair", "blue chair"));
    expect(result.conflicted).toBe(false);
    expect(blocks(result.file!.content)).toEqual([["one", "The dog likes the blue chair."]]);
  });

  test("retains external whitespace between unchanged block identities", () => {
    const fixture = document([["one", "First."], ["two", "Second."]]);
    const base = fixture.render();
    const gap = '<!-- margin-chat-document-block-end "one" -->\n\n';
    const local = base.replace(gap, `${gap}\n \t\n`).replace("First.", "Local first.");
    const result = merge(base, local, base.replace("Second.", "Cloud second."));
    expect(result.file?.content).toContain(`${gap}\n \t\n`);
    expect(blocks(result.file!.content)).toEqual([["one", "Local first."], ["two", "Cloud second."]]);
    expect(result.conflicted).toBe(false);
  });

  test("shares a bounded diff allowance across many difficult blocks while retaining cheap edits", () => {
    const content = `localstart cloudstart ${Array.from({ length: 200 }, (_, index) => `word${index}`).join(" ")} localend cloudend`;
    const fixture = document([...Array.from({ length: 24 }, (_, index): [string, string] => [`block${index}`, content]), ["simple", "Baseline."]]);
    const base = fixture.render();
    const local = base.replaceAll("localstart", "localfirst").replaceAll("localend", "locallast").replace("Baseline.", "Simple local edit.");
    const remote = base.replaceAll("cloudstart", "cloudfirst").replaceAll("cloudend", "cloudlast");
    const result = merge(base, local, remote);
    const merged = blocks(result.file!.content);
    expect(result.conflicted).toBe(true);
    expect(merged[0][1]).toContain("localfirst cloudfirst");
    expect(merged[0][1]).toContain("locallast cloudlast");
    expect(merged[23][1]).toBe(content.replace("cloudstart", "cloudfirst").replace("cloudend", "cloudlast"));
    expect(merged[24]).toEqual(["simple", "Simple local edit."]);
    // Exhaustion belongs to one invocation, never the next save or document.
    expect(merge("The cat likes red.", "The dog likes red.", "The cat likes blue.")).toEqual({ file: file("The dog likes blue."), conflicted: false });
  });

  test("a cloud move retains a local block edit", () => {
    const fixture = document([["one", "First."], ["two", "Second."], ["three", "Third."]]);
    const base = fixture.render();
    const local = base.replace("Second.", "Second locally edited.");
    fixture.state.conversations[fixture.id].document!.blocks.reverse();
    const result = merge(base, local, fixture.render());
    expect(result.conflicted).toBe(false);
    expect(blocks(result.file!.content)).toEqual([["three", "Third."], ["two", "Second locally edited."], ["one", "First."]]);
  });

  test("a local move retains a cloud block edit", () => {
    const fixture = document([["one", "First."], ["two", "Second."], ["three", "Third."]]);
    const base = fixture.render();
    const remote = base.replace("Second.", "Second remotely edited.");
    fixture.state.conversations[fixture.id].document!.blocks.reverse();
    const result = merge(base, fixture.render(), remote);
    expect(result.conflicted).toBe(false);
    expect(blocks(result.file!.content)).toEqual([["three", "Third."], ["two", "Second remotely edited."], ["one", "First."]]);
  });

  test("both simultaneous inserted blocks survive", () => {
    const fixture = document([["one", "First."], ["two", "Second."]]);
    const base = fixture.render();
    const original = fixture.state.conversations[fixture.id].document!.blocks;
    const make = (id: string, content: string) => ({ ...original[0], id, content });
    fixture.state.conversations[fixture.id].document!.blocks = [original[0], make("local", "Local addition."), original[1]];
    const local = fixture.render();
    fixture.state.conversations[fixture.id].document!.blocks = [original[0], make("remote", "Remote addition."), original[1]];
    const result = merge(base, local, fixture.render());
    expect(blocks(result.file!.content)).toEqual([["one", "First."], ["remote", "Remote addition."], ["local", "Local addition."], ["two", "Second."]]);
    expect(result.conflicted).toBe(false);
  });

  test.each([{ initial: [] }, { initial: [["one", "First."]] }])("concurrent first blocks and appended blocks remain inside the document: %j", ({ initial }) => {
    const fixture = document(initial as [string, string][]);
    fixture.state.conversations[fixture.id].messages.push({ id: "message", role: "user", content: "A context message.", createdAt: date });
    const base = fixture.render();
    const doc = fixture.state.conversations[fixture.id].document!;
    const original = [...doc.blocks];
    const make = (id: string, content: string) => ({ id, content, kind: "markdown" as const, createdAt: date, updatedAt: date });
    doc.blocks = [...original, make("local", "Local first.")];
    const local = fixture.render();
    doc.blocks = [...original, make("remote", "Remote first.")];
    const result = merge(base, local, fixture.render());
    expect(blocks(result.file!.content)).toEqual([...initial, ["remote", "Remote first."], ["local", "Local first."]]);
    expect(result.conflicted).toBe(false);
  });

  test.each(["$&", "$'", "local\0x"])("stable IDs are opaque even with replacement syntax: %s", (id) => {
    const fixture = document([["one", "First."], ["two", "Second."]]);
    const base = fixture.render();
    const doc = fixture.state.conversations[fixture.id].document!;
    const original = [...doc.blocks];
    doc.blocks = [original[0], { ...original[0], id, content: "Local addition." }, original[1]];
    const local = fixture.render();
    doc.blocks = [original[0], { ...original[0], id: "remote", content: "Remote addition." }, { ...original[1], content: "Cloud second." }];
    const result = merge(base, local, fixture.render());
    expect(blocks(result.file!.content)).toEqual([["one", "First."], ["remote", "Remote addition."], [id, "Local addition."], ["two", "Cloud second."]]);
    expect(result.conflicted).toBe(false);
  });

  test("competing block moves use cloud order while preserving independent content", () => {
    const fixture = document([["a", "A."], ["b", "B."], ["c", "C."], ["d", "D."]]);
    const base = fixture.render();
    const original = fixture.state.conversations[fixture.id].document!.blocks;
    fixture.state.conversations[fixture.id].document!.blocks = [original[1], { ...original[0], content: "Local A." }, original[2], original[3]];
    const local = fixture.render();
    fixture.state.conversations[fixture.id].document!.blocks = [original[0], original[2], original[3], { ...original[1], content: "Remote B." }];
    const result = merge(base, local, fixture.render());
    expect(blocks(result.file!.content)).toEqual([["a", "Local A."], ["c", "C."], ["d", "D."], ["b", "Remote B."]]);
    expect(result.conflicted).toBe(true);
  });

  test("block deletion wins an opposing edit while other edits survive", () => {
    const fixture = document([["one", "First."], ["two", "Second."]]);
    const base = fixture.render();
    const remote = base.replace("First.", "Cloud edited first.");
    fixture.state.conversations[fixture.id].document!.blocks.shift();
    fixture.state.conversations[fixture.id].document!.blocks[0].content = "Local second.";
    const result = merge(base, fixture.render(), remote);
    expect(result.conflicted).toBe(true);
    expect(blocks(result.file!.content)).toEqual([["two", "Local second."]]);
  });

  test("conflicting block wording does not discard independent block edits", () => {
    const fixture = document([["one", "Launch Friday."], ["two", "Owner Pat."]]);
    const base = fixture.render();
    const result = merge(base, base.replace("Friday", "Monday").replace("Owner Pat.", "Owner Alex."), base.replace("Friday", "Tuesday"));
    expect(result.conflicted).toBe(true);
    expect(blocks(result.file!.content)).toEqual([["one", "Launch Tuesday."], ["two", "Owner Alex."]]);
  });

  test("malformed markers, duplicate IDs and changed document identities never synthesize a document", () => {
    const fixture = document([["one", "First."], ["two", "Second."]]);
    const base = fixture.render();
    const remote = base.replace("First.", "Cloud first.");
    for (const local of [base.replace('document-block-end "one"', 'document-block-end "missing"'), base.replaceAll('"two"', '"one"'), base.replaceAll(fixture.id, "another-document")]) {
      expect(merge(base, local, remote)).toEqual({ file: file(remote), conflicted: true });
    }
  });

  test("metadata fields merge structurally and updated timestamps do not create spurious ambiguity", () => {
    const fixture = document([["one", "First."], ["two", "Second."]]);
    const base = fixture.render();
    fixture.state.conversations[fixture.id].modelId = "local-model";
    fixture.state.conversations[fixture.id].updatedAt = "2026-09-10T00:00:00.000Z";
    const local = fixture.render();
    // Retain the baseline model without relying on independently generated IDs.
    const metadata = JSON.parse(base.match(/<!-- margin-chat-metadata (.+) -->/)![1]);
    fixture.state.conversations[fixture.id].modelId = metadata.conversation.modelId;
    fixture.state.conversations[fixture.id].serviceId = "openai-api";
    fixture.state.conversations[fixture.id].updatedAt = "2026-09-11T00:00:00.000Z";
    const result = merge(base, local, fixture.render());
    const mergedMeta = JSON.parse(result.file!.content.match(/<!-- margin-chat-metadata (.+) -->/)![1]);
    expect(mergedMeta.conversation.modelId).toBe("local-model");
    expect(mergedMeta.conversation.serviceId).toBe("openai-api");
    expect(mergedMeta.conversation.updatedAt).toBe("2026-09-11T00:00:00.000Z");
    expect(result.conflicted).toBe(false);
  });

  test("concurrent first context messages remain readable", () => {
    const fixture = document([["one", "First."]]);
    const base = fixture.render();
    const conversation = fixture.state.conversations[fixture.id];
    conversation.messages = [{ id: "local", role: "user", content: "Local context.", createdAt: date }];
    const local = fixture.render();
    conversation.messages = [{ id: "remote", role: "user", content: "Remote context.", createdAt: date }];
    const result = merge(base, local, fixture.render());
    const workspace = discoverMarkdownWorkspace({ "Note.md": result.file!.content });
    const parsed = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
    expect(parsed.conversations[fixture.id].messages.map(({ id, content }) => [id, content])).toEqual([["remote", "Remote context."], ["local", "Local context."]]);
  });
});

describe("newer recorded wording", () => {
  const earlier = "2026-09-02T12:00:00.000Z";
  const later = "2026-09-03T12:00:00.000Z";

  test("chooses newer local wording only in overlaps and keeps independent cloud edits", () => {
    const fixture = document([["one", "Launch Friday. Owner Pat. Room red."], ["two", "Budget small."]]);
    const conversation = fixture.state.conversations[fixture.id];
    const base = fixture.render();
    const doc = conversation.document!;
    doc.blocks[0] = { ...doc.blocks[0], content: "Launch Monday. Owner Alex. Room red.", updatedAt: later };
    conversation.updatedAt = earlier;
    const local = fixture.render();
    doc.blocks[0] = { ...doc.blocks[0], content: "Launch Tuesday. Owner Pat. Room blue.", updatedAt: earlier };
    doc.blocks[1] = { ...doc.blocks[1], content: "Budget large.", updatedAt: later };
    conversation.updatedAt = later;
    const remote = fixture.render();
    const result = merge(base, local, remote);
    expect(result.conflicted).toBe(true);
    expect(blocks(result.file!.content)).toEqual([["one", "Launch Monday. Owner Alex. Room blue."], ["two", "Budget large."]]);
    // Recorded-time comparison is direction independent; repeating a save keeps it.
    expect(blocks(merge(base, remote, local).file!.content)).toEqual(blocks(result.file!.content));
    expect(blocks(merge(base, result.file!.content, remote).file!.content)).toEqual(blocks(result.file!.content));
  });

  test("a newer remote block wins even when another local block raises the document time", () => {
    const fixture = document([["one", "Launch Friday."], ["two", "Owner Pat."]]);
    const conversation = fixture.state.conversations[fixture.id];
    const base = fixture.render();
    const doc = conversation.document!;
    doc.blocks[0] = { ...doc.blocks[0], content: "Launch Monday.", updatedAt: earlier };
    doc.blocks[1] = { ...doc.blocks[1], content: "Owner Alex.", updatedAt: later };
    conversation.updatedAt = later;
    const local = fixture.render();
    doc.blocks[0] = { ...doc.blocks[0], content: "Launch Tuesday.", updatedAt: later };
    doc.blocks[1] = { ...doc.blocks[1], content: "Owner Pat.", updatedAt: date };
    conversation.updatedAt = earlier;
    const result = merge(base, local, fixture.render());
    expect(blocks(result.file!.content)).toEqual([["one", "Launch Tuesday."], ["two", "Owner Alex."]]);
  });

  test("equal block timestamps keep cloud wording despite a newer document timestamp", () => {
    const fixture = document([["one", "Launch Friday."]]);
    const conversation = fixture.state.conversations[fixture.id];
    const base = fixture.render();
    conversation.document!.blocks[0].content = "Launch Monday.";
    conversation.updatedAt = later;
    const local = fixture.render();
    conversation.document!.blocks[0].content = "Launch Tuesday.";
    conversation.updatedAt = earlier;
    expect(blocks(merge(base, local, fixture.render()).file!.content)).toEqual([["one", "Launch Tuesday."]]);
  });

  test("newer timestamps alone do not override an actual one-sided content change", () => {
    const fixture = document([["one", "Launch Friday."]]);
    const conversation = fixture.state.conversations[fixture.id];
    const base = fixture.render();
    conversation.document!.blocks[0].updatedAt = later;
    const local = fixture.render();
    conversation.document!.blocks[0] = { ...conversation.document!.blocks[0], content: "Launch Tuesday.", updatedAt: earlier };
    const result = merge(base, local, fixture.render());
    expect(blocks(result.file!.content)).toEqual([["one", "Launch Tuesday."]]);
    expect(result.conflicted).toBe(false);
  });

  test("document metadata uses recorded edit times while keeping disjoint settings", () => {
    const fixture = document([["one", "First."]]);
    const conversation = fixture.state.conversations[fixture.id];
    const base = fixture.render();
    const oldService = conversation.serviceId;
    conversation.title = "Device title";
    conversation.serviceId = "local-service";
    conversation.updatedAt = later;
    const local = fixture.render();
    conversation.title = "Cloud title";
    conversation.serviceId = oldService;
    conversation.modelId = "cloud-model";
    conversation.updatedAt = earlier;
    const result = merge(base, local, fixture.render());
    const metadata = JSON.parse(result.file!.content.match(/<!-- margin-chat-metadata (.+) -->/)![1]);
    expect(metadata.conversation.title).toBe("Device title");
    expect(metadata.conversation.serviceId).toBe("local-service");
    expect(metadata.conversation.modelId).toBe("cloud-model");
    expect(result.file?.content).toContain("# Device title");
  });

  test("legacy message edits use document edit time, not message creation time", () => {
    const fixture = document([]);
    const conversation = fixture.state.conversations[fixture.id];
    conversation.messages = [{ id: "message", role: "user", content: "Launch Friday. Room red.", createdAt: date }];
    const base = fixture.render();
    conversation.messages[0].content = "Launch Monday. Room red.";
    conversation.updatedAt = later;
    const local = fixture.render();
    conversation.messages[0].content = "Launch Tuesday. Room blue.";
    conversation.updatedAt = earlier;
    const result = merge(base, local, fixture.render());
    const workspace = discoverMarkdownWorkspace({ "Note.md": result.file!.content });
    const parsed = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
    expect(parsed.conversations[fixture.id].messages[0].content).toBe("Launch Monday. Room blue.");
  });

  test("plain notes use frontmatter update time and preserve unknown source syntax", () => {
    const source = (time: string, text: string) => `---\nupdated: '${time}'\ncustom: true\n---\n\n<custom attr='raw'>\n${text}\n</custom>\n`;
    const result = merge(source(date, "Launch Friday. Room red."), source(later, "Launch Monday. Room red."), source(earlier, "Launch Tuesday. Room blue."));
    expect(result.file?.content).toBe(source(later, "Launch Monday. Room blue.").replace(`updated: '${later}'`, `updated: "${later}"`));
    expect(result.conflicted).toBe(true);
  });

  test.each([undefined, date, "not-a-date"])("missing, equal or invalid note timestamps keep cloud wording: %s", (timestamp) => {
    const header = timestamp === undefined ? "" : `---\nupdated: ${JSON.stringify(timestamp)}\n---\n\n`;
    const base = `${header}Launch Friday. Room red.`;
    const result = merge(base, `${header}Launch Monday. Room red.`, `${header}Launch Tuesday. Room blue.`);
    expect(result.file?.content).toBe(`${header}Launch Tuesday. Room blue.`);
  });

  test.each([undefined, "2026-09-04T12:00:00", "2026-09-03T08:00:00-04:00"])("a missing, timezone-less or equal instant does not claim newer wording: %s", (timestamp) => {
    const source = (updated: string | undefined, text: string) => `${updated ? `---\nupdated: ${JSON.stringify(updated)}\n---\n\n` : ""}${text}`;
    const result = merge(source(date, "Launch Friday. Room red."), source(timestamp, "Launch Monday. Room red."), source(later, "Launch Tuesday. Room blue."));
    expect(result.file?.content).toContain("Launch Tuesday. Room blue.");
    expect(result.file?.content).not.toContain("Monday");
  });
});

describe("readable-format merging", () => {
  test("merges compact blocks and regenerates the frontmatter registry", () => {
    const fixture = document([["one", "Launch Friday."], ["two", "Owner Pat."]]);
    const base = encodeReadableMarkdown(fixture.render());
    const result = merge(base, base.replace("Friday", "Monday").replace("Owner Pat.", "Owner Alexandra."), base.replace("Friday", "Tuesday"));
    expect(isReadableMarkdown(result.file!.content)).toBe(true);
    expect(result.conflicted).toBe(true);
    expect(blocks(result.file!.content)).toEqual([["one", "Launch Tuesday."], ["two", "Owner Alexandra."]]);
    expect(decodeReadableMarkdown(result.file!.content)).toContain('"contentLength":16');
    expect(result.file?.content).not.toContain('<!-- margin-chat-document-block {');
  });

  test("combines legacy and readable device versions without dropping stable identities", () => {
    const fixture = document([["one", "First."], ["two", "Second."]]);
    const base = fixture.render();
    const local = encodeReadableMarkdown(base).replace("First.", "Local first.");
    const remote = base.replace("Second.", "Cloud second.");
    const result = merge(base, local, remote);
    expect(result.conflicted).toBe(false);
    expect(isReadableMarkdown(result.file!.content)).toBe(true);
    expect(blocks(result.file!.content)).toEqual([["one", "Local first."], ["two", "Cloud second."]]);
  });

  test("malformed readable registry falls back to the intact cloud file", () => {
    const fixture = document([["one", "First."], ["two", "Second."]]);
    const base = encodeReadableMarkdown(fixture.render());
    const local = base.replace('"blocks": {', '"invalidBlocks": {').replace("First.", "Local first.");
    const remote = base.replace("Second.", "Cloud second.");
    expect(merge(base, local, remote)).toEqual({ file: file(remote), conflicted: true });
  });

  test.each([true, false])("surviving cloud path retains its managed/external status: %s", (managed) => {
    const fixture = document([["one", "First."], ["two", "Second."]]);
    fixture.state.conversations[fixture.id].updatedAt = date;
    const source = fixture.render();
    const path = managed ? "Chats/Original.md" : "Archive/My custom name.md";
    function named(managedPath: string, aliases: string[], body = source) {
      return encodeReadableMarkdown(body.replace(/<!-- margin-chat-metadata (.+) -->/, (_match, json) => {
        const metadata = JSON.parse(json);
        metadata.file = { managedPath, aliases };
        return `<!-- margin-chat-metadata ${JSON.stringify(metadata)} -->`;
      }));
    }
    const base = named("Chats/Original.md", ["Chats/Older.md"]);
    const local = named("Chats/Local title.md", ["Chats/Original.md", "Chats/Local alias.md"], source.replace("First.", "Local first.").replaceAll(date, "2026-09-03T00:00:00.000Z"));
    const remote = named("Chats/Original.md", ["Chats/Cloud alias.md"], source.replace("Second.", "Cloud second."));
    const result = mergeVaultFile(path, file(base), file(local), file(remote));
    const metadata = JSON.parse(decodeReadableMarkdown(result.file!.content).match(/<!-- margin-chat-metadata (.+) -->/)![1]);
    expect(metadata.file.managedPath).toBe("Chats/Original.md");
    expect(metadata.file.managedPath === path).toBe(managed);
    expect(metadata.file.aliases).toEqual(expect.arrayContaining(["Chats/Older.md", "Chats/Local title.md", "Chats/Local alias.md", "Chats/Cloud alias.md"]));
    expect(metadata.file.aliases).not.toContain(path);
    expect(blocks(result.file!.content)).toEqual([["one", "Local first."], ["two", "Cloud second."]]);
  });
});

describe("workspace sidecar merge", () => {
  test("combines independent settings and preserves unknown metadata", () => {
    const base = { ...createMarkdownWorkspace(createEmptyState()).manifest, custom: { local: "old", remote: "old", untouched: ["raw"] } };
    const local = structuredClone(base);
    const remote = structuredClone(base);
    local.custom.local = "new local";
    remote.custom.remote = "new remote";
    const result = mergeVaultFile("workspace.json", file(JSON.stringify(base)), file(JSON.stringify(local)), file(JSON.stringify(remote)));
    expect(JSON.parse(result.file!.content).custom).toEqual({ local: "new local", remote: "new remote", untouched: ["raw"] });
    expect(result.conflicted).toBe(false);
  });

  test("unsafe JSON uses the intact current sidecar", () => {
    const source = JSON.stringify(createMarkdownWorkspace(createEmptyState()).manifest);
    const remote = file(source.replace('"railOpen":false', '"railOpen":true'));
    expect(mergeVaultFile("workspace.json", file(source), file("{invalid"), remote)).toEqual({ file: remote, conflicted: true });
  });
});
