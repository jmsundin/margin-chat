import { describe, expect, test } from "bun:test";
import { createMainConversation, createStandaloneNoteConversation } from "../client/src/initialState";
import { resolveSearchSource } from "../client/src/lib/searchSource";
import type { SearchEvidenceRef } from "../client/src/lib/conversationSearch";

function fixture() {
  const chat = createMainConversation({ id: "chat" });
  const standalone = createStandaloneNoteConversation({ id: "standalone", noteId: "body" });
  standalone.notes![0].content = "Standalone **source**.";
  chat.notes = [{ ...standalone.notes![0], id: "annotation", kind: "comment", content: "A **saved** passage." }];
  chat.messages = [{ id: "message", role: "assistant", content: "The **message** passage.", createdAt: chat.createdAt }];
  const source: SearchEvidenceRef = { conversationId: chat.id, sourceKind: "annotation", noteId: "annotation", quote: "**saved**", startOffset: 2, endOffset: 11 };
  return { chat, standalone, conversations: { chat, standalone }, source };
}

describe("exact search source resolution", () => {
  test("resolves raw Markdown offsets in messages, standalone notes, and private annotations", () => {
    const { conversations, source } = fixture();
    expect(resolveSearchSource(conversations, source)).toMatchObject({ status: "exact", highlight: { startOffset: 2, endOffset: 11 } });
    expect(resolveSearchSource(conversations, { conversationId: "chat", sourceKind: "message", messageId: "message", quote: "**message**", startOffset: 4, endOffset: 15 })).toMatchObject({ status: "exact", highlight: { startOffset: 4, endOffset: 15 } });
    expect(resolveSearchSource(conversations, { conversationId: "standalone", sourceKind: "standalone-note", noteId: "body", quote: "**source**", startOffset: 11, endOffset: 21 })).toMatchObject({ status: "exact", highlight: { startOffset: 11, endOffset: 21 } });
    expect(resolveSearchSource(conversations, { conversationId: "standalone", sourceKind: "annotation", noteId: "body" }).status).toBe("missing");
  });

  test("recovers unique moved annotations but never guesses between duplicate or removed quotes", () => {
    const { chat, conversations, source } = fixture();
    chat.notes![0].content = `Added context. ${chat.notes![0].content}`;
    expect(resolveSearchSource(conversations, source)).toMatchObject({ status: "recovered", highlight: { startOffset: 17, endOffset: 26 } });
    chat.notes![0].content = "**saved** repeats **saved**";
    expect(resolveSearchSource(conversations, source)).toMatchObject({ status: "stale", highlight: null });
    expect(resolveSearchSource(conversations, { ...source, startOffset: 0, endOffset: 9 })).toMatchObject({ status: "exact", highlight: { startOffset: 0, endOffset: 9 } });
    chat.notes![0].content = "Replaced content";
    expect(resolveSearchSource(conversations, source)).toMatchObject({ status: "stale", highlight: null });
    chat.notes = [];
    expect(resolveSearchSource(conversations, source)).toMatchObject({ status: "missing", highlight: null });
    expect(resolveSearchSource({}, source).status).toBe("missing");
  });

  test("validates annotation bounds before selecting in an editor", () => {
    const { chat, conversations, source } = fixture();
    const content = chat.notes![0].content;
    const invalid = { ...source, quote: content, startOffset: 0, endOffset: content.length + 200 };
    expect(resolveSearchSource(conversations, invalid)).toMatchObject({ status: "recovered", highlight: { startOffset: 0, endOffset: content.length } });
    expect(resolveSearchSource(conversations, { ...source, quote: undefined })).toMatchObject({ status: "stale", highlight: null });
    expect(resolveSearchSource(conversations, { ...source, quote: undefined, startOffset: undefined, endOffset: undefined })).toMatchObject({ status: "exact", highlight: null });
  });
});

test("search source focus maps rendered Markdown and safely handles editor navigation and cancellation", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/searchSourceHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Search source focus check failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("Search source focus checks passed.");
}, 15000);
