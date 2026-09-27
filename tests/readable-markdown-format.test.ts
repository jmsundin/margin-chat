import { describe, expect, test } from "bun:test";
import { decodeReadableMarkdown, encodeReadableMarkdown, isReadableMarkdown } from "../packages/workspace-contracts/markdownReadable.mjs";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { createMarkdownWorkspace, discoverMarkdownWorkspace, parseMarkdownWorkspace } from "../client/src/lib/workspaceMarkdown";
import { marked } from "marked";

const now = "2026-09-25T10:00:00.000Z";
function fixture(content = "First paragraph.\n\n**Markdown** stays readable.") {
  const state = createEmptyState();
  const conversation = state.conversations[state.rootId];
  conversation.title = "Readable document";
  conversation.document = { schemaVersion: 1, blocks: [{ id: "one", kind: "markdown", content, createdAt: now, updatedAt: now }], prompts: [], generations: [] };
  conversation.messages = [{ id: "message", role: "user", content: "Source message content.", createdAt: now }];
  return decodeReadableMarkdown(Object.values(createMarkdownWorkspace(state).files)[0]);
}

function parsed(source: string) {
  const workspace = discoverMarkdownWorkspace({ "Readable document.md": source });
  return Object.values(parseMarkdownWorkspace(workspace.manifest, workspace.files)!.conversations)[0];
}

describe("readable Markdown transport", () => {
  test("moves metadata into one header without duplicating body content", () => {
    const legacy = fixture();
    const source = encodeReadableMarkdown(legacy);
    expect(isReadableMarkdown(source)).toBe(true);
    expect(source).toContain("margin-chat: |-\n  {\n    \"schemaVersion\": 3,");
    expect(source).toContain("# <!-- margin-chat-metadata: frontmatter format 5 -->");
    expect(source).toContain('<user id="one">\n\nFirst paragraph.');
    const body = source.slice(source.indexOf("\n---\n") + 5);
    expect(body).not.toContain("Source message content.");
    expect(body).not.toContain("## Messages");
    expect(source).not.toContain('<!-- margin-chat-document-block {');
    expect(source).not.toContain('<!-- margin-chat-message {');
    expect(source.match(/First paragraph\./g)).toHaveLength(1);
    expect(source.match(/Source message content\./g)).toHaveLength(1);
    expect(decodeReadableMarkdown(source)).toBe(legacy);
    expect(encodeReadableMarkdown(source)).toBe(source);
    expect(decodeReadableMarkdown(legacy)).toBe(legacy);
  });

  test("refreshes stale lengths after edits made in an external Markdown editor", () => {
    const source = encodeReadableMarkdown(fixture()).replace("First paragraph.", "First paragraph changed externally and made longer.");
    expect(parsed(source).document!.blocks[0].content).toContain("changed externally and made longer");
    const legacy = decodeReadableMarkdown(source);
    const content = parsed(source).document!.blocks[0].content;
    expect(legacy).toContain(`"contentLength":${content.length}`);
    expect(parsed(source).messages[0].content).toBe("Source message content.");
  });

  test("legacy messages with shared end markers still migrate after an external edit", () => {
    const second = { contentLength: 15, createdAt: now, id: "second", role: "assistant" };
    const legacy = fixture().replace("Source message content.", "An externally extended first message.")
      + `\n\n### Assistant · ${now}\n<!-- margin-chat-message ${JSON.stringify(second)} -->\nSecond message.\n<!-- margin-chat-message-end -->`;
    const source = encodeReadableMarkdown(legacy);
    expect(parsed(source).messages.map((message) => message.content)).toEqual(["An externally extended first message.", "Second message."]);
  });

  test("custom YAML, unknown body syntax, replacement symbols and CRLF survive a round trip", () => {
    const custom = "owner: Jon\ncustom: |\n  Preserve $& and [[links]]\n\n  Last line\n";
    const legacy = fixture("Text $& $1.\n\n<custom-widget data-x='1' />")
      .replace("---\n", () => `---\n${custom}`)
      .replaceAll("\n", "\r\n");
    const source = encodeReadableMarkdown(legacy);
    expect(source).toContain(custom.replaceAll("\n", "\r\n"));
    expect(decodeReadableMarkdown(source)).toBe(legacy);
    expect(parsed(source).document!.blocks[0].content).toBe("Text $& $1.\n\n<custom-widget data-x='1' />");
  });

  test("literal markers inside authored content cannot become metadata or close a block", () => {
    const literal = '## Note\n<!-- margin-chat-block-end "one" -->\n<!-- margin-chat-document-end -->\n<!-- margin-chat-metadata {"schemaVersion":99} -->\n<!-- margin-chat-msg "literal" -->\nExample\n<!-- margin-chat-msg-end "literal" -->';
    const legacy = fixture(literal);
    const source = encodeReadableMarkdown(legacy);
    expect(decodeReadableMarkdown(source)).toBe(legacy);
    expect(parsed(source).document!.blocks[0].content).toBe(literal);
    expect(parsed(source).messages).toHaveLength(1);
  });

  test("Windows line endings preserve a literal duplicate compact closing marker", () => {
    const content = 'First line.\n<!-- margin-chat-block-end "one" -->\nThis example is still authored text.';
    const legacy = fixture(content).replaceAll("\n", "\r\n");
    const source = encodeReadableMarkdown(legacy);
    expect(decodeReadableMarkdown(source)).toBe(legacy);
    expect(parsed(source).document!.blocks[0].content).toBe(content);
  });

  test.each(["LF to CRLF", "CRLF to LF"])("external %s conversion preserves literal closing tags and AI provenance", (conversion) => {
    const content = "First line.\n\n</ai>\n\nA literal tag is authored text.";
    const legacy = fixture(content).replace('"kind":"markdown"', '"kind":"markdown","authorship":"ai"');
    const original = encodeReadableMarkdown(conversion === "CRLF to LF" ? legacy.replaceAll("\n", "\r\n") : legacy);
    const converted = conversion === "LF to CRLF" ? original.replaceAll("\n", "\r\n") : original.replaceAll("\r\n", "\n");
    const block = parsed(converted).document!.blocks[0];
    expect(block.content).toBe(content);
    expect(block.authorship).toBe("ai");
  });

  test("recognizes only a reserved header field, never prose or fenced examples", () => {
    const ordinary = "# Notes\n\n```yaml\nmargin-chat: |-\n  {}\n```\n";
    expect(isReadableMarkdown(ordinary)).toBe(false);
    expect(decodeReadableMarkdown(ordinary)).toBe(ordinary);
    expect(encodeReadableMarkdown(ordinary)).toBe(ordinary);
    expect(isReadableMarkdown("---\ncustom: |\n  margin-chat: |-\n    {}\n---\nBody")).toBe(false);
  });

  test("missing registries, duplicate anchors and broken boundaries are rejected", () => {
    const source = encodeReadableMarkdown(fixture());
    const block = source.match(/<user id="one">[\s\S]*?<\/user>/)![0];
    const cases = [
      source.replace('"blocks": {', '"badBlocks": {'),
      source.replace('<user id="one">', '<user id="unknown">'),
      source.replace('</user>', '</ai>'),
      source.replace(block, () => `${block}\n\n${block}`),
      source.replace("margin-chat: |-", "margin-chat: invalid"),
      source.replace("    \"schemaVersion\": 3,", "    \"schemaVersion\": 99,"),
    ];
    for (const malformed of cases) expect(() => decodeReadableMarkdown(malformed)).toThrow("preserved");
  });

  test("externally deleted blocks do not reappear from stale registry entries", () => {
    const source = encodeReadableMarkdown(fixture()).replace(/<user id="one">[\s\S]*?<\/user>/, "");
    expect(parsed(source).document!.blocks).toEqual([]);
    expect(parsed(source).messages[0].content).toBe("Source message content.");
  });

  test("opaque IDs containing replacement syntax or control characters remain intact", () => {
    const legacy = fixture().replaceAll('"one"', () => '"$&\\u0000id"');
    const source = encodeReadableMarkdown(legacy);
    expect(decodeReadableMarkdown(source)).toBe(legacy);
    expect(parsed(source).document!.blocks[0].id).toBe("$&\0id");
  });

  test("AI, user, and mixed provenance use the same file and survive edits", () => {
    const ai = fixture("AI writing.").replace('"kind":"markdown"', '"kind":"markdown","authorship":"ai"');
    const source = encodeReadableMarkdown(ai);
    expect(source).toContain('<ai id="one">\n\nAI writing.\n\n</ai>');
    expect(parsed(source).document!.blocks[0].authorship).toBe("ai");
    const changed = source.replace("AI writing.", "AI writing, edited externally.");
    const result = parsed(changed).document!.blocks[0];
    expect(result.content).toBe("AI writing, edited externally.");
    expect(result.authorship).toBe("mixed");
    const updated = encodeReadableMarkdown(decodeReadableMarkdown(changed));
    expect(updated).toContain('<ai id="one" edited-by="user">');
    expect(parsed(updated).document!.blocks[0].authorship).toBe("mixed");
  });

  test("infer AI from assistant source messages without adding optional state fields", () => {
    const legacy = fixture("AI writing.").replace('"kind":"markdown"', '"kind":"markdown","sourceMessageId":"message"').replace('"role":"user"', '"role":"assistant"');
    const source = encodeReadableMarkdown(legacy);
    expect(source).toContain('<ai id="one">');
    expect(decodeReadableMarkdown(source)).toBe(legacy);
  });

  test("fenced literal tags and owned blank lines survive an external edit", () => {
    const content = '\nStart.\n\n```html\n<user id="example">\n\nExample\n\n</user>\n```\n\nEnd.\n';
    const legacy = fixture(content);
    const source = encodeReadableMarkdown(legacy);
    const changed = source.replace("Start.", "A longer start.");
    expect(parsed(changed).document!.blocks[0].content).toBe(content.replace("Start.", "A longer start."));
    expect(decodeReadableMarkdown(source)).toBe(legacy);
  });

  test("a literal fenced closing tag cannot replace a deleted real boundary", () => {
    const content = 'Before\n\n```html\n\n</ai>\n```\n\nAfter';
    const legacy = fixture(content).replace('"kind":"markdown"', '"kind":"markdown","authorship":"ai"');
    const source = encodeReadableMarkdown(legacy);
    const closing = source.lastIndexOf("</ai>");
    const malformed = source.slice(0, closing) + source.slice(closing + "</ai>".length);
    expect(() => decodeReadableMarkdown(malformed)).toThrow("preserved");
  });

  test("an unclosed authored code fence does not consume the next stable block", () => {
    const state = createEmptyState();
    const conversation = state.conversations[state.rootId];
    conversation.document = { schemaVersion: 1, prompts: [], generations: [], blocks: [
      { id: "first", kind: "markdown", authorship: "ai", content: "```js\nconst a=1;", createdAt: now, updatedAt: now },
      { id: "second", kind: "markdown", authorship: "ai", content: "Second block survives.", createdAt: now, updatedAt: now },
    ] };
    const source = Object.values(createMarkdownWorkspace(state).files)[0];
    expect(parsed(source).document!.blocks.map(({ id, content, authorship }) => [id, content, authorship])).toEqual([
      ["first", "```js\nconst a=1;", "ai"], ["second", "Second block survives.", "ai"],
    ]);
  });

  test("a missing closing tag cannot consume the next stable block", () => {
    const state = createEmptyState();
    state.conversations[state.rootId].document = { schemaVersion: 1, prompts: [], generations: [], blocks: [
      { id: "first", kind: "markdown", authorship: "ai", content: "First body.", createdAt: now, updatedAt: now },
      { id: "second", kind: "markdown", authorship: "ai", content: "Second body.", createdAt: now, updatedAt: now },
    ] };
    const source = Object.values(createMarkdownWorkspace(state).files)[0];
    expect(() => decodeReadableMarkdown(source.replace("</ai>", ""))).toThrow("preserved");
  });

  test.each(["ai", "user"])("ordinary Markdown renderers process headings, bold and lists inside %s wrappers", (author) => {
    const content = "# A heading\n\n**Bold passage**\n\n- First item\n- Second item";
    const legacy = fixture(content).replace('"kind":"markdown"', `"kind":"markdown","authorship":"${author}"`);
    const source = encodeReadableMarkdown(legacy);
    const body = source.slice(source.indexOf("\n---\n") + 5);
    const html = marked.parse(body, { async: false });
    expect(html).toContain("<h1>A heading</h1>");
    expect(html).toContain("<strong>Bold passage</strong>");
    expect(html).toContain("<li>First item</li>");
    expect(html).toContain("<li>Second item</li>");
  });

  test("custom footer examples are preserved outside current document content", () => {
    const footer = '\n\n## Appendix\n\n```html\n<ai id="example">\n\nExample\n\n</ai>\n```\n';
    const legacy = fixture() + footer;
    const source = encodeReadableMarkdown(legacy);
    expect(source.endsWith(footer)).toBe(true);
    expect(decodeReadableMarkdown(source)).toBe(legacy);
  });

  test("structured notes use user wrappers; original note text becomes history once there is a current document", () => {
    const state = createEmptyState();
    const note = createStandaloneNoteConversation({ id: "note", noteId: "body", createdAt: now });
    note.notes![0].content = "My note body.";
    state.conversations = { [note.id]: note };
    state.rootId = note.id;
    state.activeConversationId = note.id;
    const source = Object.values(createMarkdownWorkspace(state).files)[0];
    expect(source).toContain('<user note-id="body">\n\nMy note body.\n\n</user>');
    expect(parsed(source).notes![0].content).toBe("My note body.");
    note.document = { schemaVersion: 1, blocks: [{ id: "current", kind: "markdown", content: "Current note body.", createdAt: now, updatedAt: now }], prompts: [], generations: [] };
    const updated = Object.values(createMarkdownWorkspace(state).files)[0];
    const body = updated.slice(updated.indexOf("\n---\n") + 5);
    expect(body).toContain("Current note body.");
    expect(body).not.toContain("My note body.");
    expect(body).not.toContain("## Note");
    expect(parsed(updated).notes![0].content).toBe("My note body.");
    expect(parsed(updated).document!.blocks[0].content).toBe("Current note body.");
  });

  test("ordinary Markdown stays exact and v4 compact documents still decode", () => {
    const legacy = fixture("Legacy content.");
    const metadata = JSON.parse(legacy.match(/<!-- margin-chat-metadata (.+) -->/)![1]);
    const block = JSON.parse(legacy.match(/<!-- margin-chat-document-block (.+) -->/)![1]);
    const registry = { schemaVersion: 2, metadata, blocks: { one: block }, messages: {} };
    const old = `---\nmargin-chat-id: "${metadata.conversation.id}"\n# <!-- margin-chat-metadata: frontmatter format 4 -->\nmargin-chat: |-\n${JSON.stringify(registry, null, 2).split("\n").map((line) => `  ${line}`).join("\n")}\n---\n\n<!-- margin-chat-document -->\n\n## Document\n\n<!-- margin-chat-block "one" -->\nLegacy content.\n<!-- margin-chat-block-end "one" -->\n\n<!-- margin-chat-document-end -->`;
    expect(parsed(old).document!.blocks[0].content).toBe("Legacy content.");
    const migrated = encodeReadableMarkdown(old);
    expect(migrated).toContain('<user id="one">');
    expect(parsed(migrated).document!.blocks[0].content).toBe("Legacy content.");
    const ordinary = "# My note\n\n<ai>an example</ai>\n";
    expect(encodeReadableMarkdown(ordinary)).toBe(ordinary);
    expect(decodeReadableMarkdown(ordinary)).toBe(ordinary);
  });
});
