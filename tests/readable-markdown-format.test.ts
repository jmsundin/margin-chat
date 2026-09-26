import { describe, expect, test } from "bun:test";
import { decodeReadableMarkdown, encodeReadableMarkdown, isReadableMarkdown } from "../packages/workspace-contracts/markdownReadable.mjs";
import { createEmptyState } from "../client/src/initialState";
import { createMarkdownWorkspace, discoverMarkdownWorkspace, parseMarkdownWorkspace } from "../client/src/lib/workspaceMarkdown";

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
    expect(source).toContain("margin-chat: |-\n  {\n    \"schemaVersion\": 2,");
    expect(source).toContain("# <!-- margin-chat-metadata: frontmatter format 4 -->");
    expect(source).toContain('<!-- margin-chat-block "one" -->\nFirst paragraph.');
    expect(source).toContain('<!-- margin-chat-msg "message" -->\nSource message content.');
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

  test("recognizes only a reserved header field, never prose or fenced examples", () => {
    const ordinary = "# Notes\n\n```yaml\nmargin-chat: |-\n  {}\n```\n";
    expect(isReadableMarkdown(ordinary)).toBe(false);
    expect(decodeReadableMarkdown(ordinary)).toBe(ordinary);
    expect(encodeReadableMarkdown(ordinary)).toBe(ordinary);
    expect(isReadableMarkdown("---\ncustom: |\n  margin-chat: |-\n    {}\n---\nBody")).toBe(false);
  });

  test("missing registries, duplicate anchors and broken boundaries are rejected", () => {
    const source = encodeReadableMarkdown(fixture());
    const block = source.match(/<!-- margin-chat-block "one" -->[\s\S]*?<!-- margin-chat-block-end "one" -->/)![0];
    const cases = [
      source.replace('"blocks": {', '"badBlocks": {'),
      source.replace('<!-- margin-chat-block "one" -->', '<!-- margin-chat-block "unknown" -->'),
      source.replace('<!-- margin-chat-block-end "one" -->', '<!-- margin-chat-block-end "unknown" -->'),
      source.replace(block, () => `${block}\n\n${block}`),
      source.replace("margin-chat: |-", "margin-chat: invalid"),
      source.replace("    \"schemaVersion\": 2,", "    \"schemaVersion\": 99,"),
    ];
    for (const malformed of cases) expect(() => decodeReadableMarkdown(malformed)).toThrow("preserved");
  });

  test("externally deleted blocks do not reappear from stale registry entries", () => {
    const source = encodeReadableMarkdown(fixture()).replace(/<!-- margin-chat-block "one" -->[\s\S]*?<!-- margin-chat-block-end "one" -->/, "");
    expect(parsed(source).document!.blocks).toEqual([]);
    expect(parsed(source).messages[0].content).toBe("Source message content.");
  });

  test("opaque IDs containing replacement syntax or control characters remain intact", () => {
    const legacy = fixture().replaceAll('"one"', () => '"$&\\u0000id"');
    const source = encodeReadableMarkdown(legacy);
    expect(decodeReadableMarkdown(source)).toBe(legacy);
    expect(parsed(source).document!.blocks[0].id).toBe("$&\0id");
  });
});
