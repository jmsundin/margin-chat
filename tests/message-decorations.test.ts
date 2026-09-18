import { describe, expect, test } from "bun:test";
import {
  buildMessageDecorations,
  getMessageDecorationKey,
  partitionDecoratedText,
  type MessageDecoration,
} from "../client/src/lib/messageDecorations";
import type { ConversationNote, MessageAnchorLink, SelectionDraft } from "../client/src/types";

function branch(startOffset = 2, endOffset = 8): MessageAnchorLink {
  return {
    branchConversationId: "branch",
    title: "Original title",
    anchor: { id: "anchor", sourceConversationId: "conversation", sourceMessageId: "message", startOffset, endOffset, quote: "", prompt: "", createdAt: "2026-09-18T00:00:00Z" },
  };
}

function note(id: string, startOffset: number | null, endOffset: number | null): ConversationNote {
  return {
    id, startOffset, endOffset, content: "Note", kind: "comment", quote: null,
    sourceMessageId: "message", createdAt: "2026-09-18T00:00:00Z", updatedAt: "2026-09-18T00:00:00Z",
  };
}

function selection(startOffset: number, endOffset: number): SelectionDraft {
  return {
    conversationId: "conversation", messageId: "message", startOffset, endOffset, quote: "", prompt: "",
    rect: { left: 0, top: 0, width: 0, height: 0 },
  };
}

describe("message annotation semantics", () => {
  test("segments overlapping branches and notes without losing any text", () => {
    const decorations = buildMessageDecorations([branch()], [note("note-a", 4, 10), note("note-b", 6, 9)], null);
    const segments = partitionDecoratedText("0123456789AB", decorations);
    expect(segments.map(({ value }) => value).join("")).toBe("0123456789AB");
    expect(segments.map(({ value, active }) => [value, active.map((item) => item.type)])).toEqual([
      ["01", []], ["23", ["anchor"]], ["45", ["anchor", "note"]],
      ["67", ["anchor", "note", "note"]], ["8", ["note", "note"]], ["9", ["note"]], ["AB", []],
    ]);
    expect(decorations.filter((item) => item.type === "note").map((item) => item.noteId)).toEqual(["note-a", "note-b"]);
  });

  test("suppresses previews that overlap branches but permits shared note highlights", () => {
    expect(buildMessageDecorations([branch()], [], selection(3, 5)).some((item) => item.type === "preview")).toBe(false);
    expect(buildMessageDecorations([branch()], [], selection(8, 10)).some((item) => item.type === "preview")).toBe(true);
    const decorations = buildMessageDecorations([], [note("note", 0, 4)], selection(2, 6));
    expect(partitionDecoratedText("abcdef", decorations).map(({ active }) => active.map((item) => item.type))).toEqual([
      ["note"], ["note", "preview"], ["preview"],
    ]);
  });

  test("clips decorations to visible streamed text and ignores empty or invalid ranges", () => {
    const decorations = buildMessageDecorations(
      [branch(-2, 20), branch(2, 2), branch(Number.NaN, 8)],
      [note("unanchored", null, null), note("backwards", 8, 2)],
      selection(3, 3),
    );
    expect(decorations).toHaveLength(1);
    expect(partitionDecoratedText("part", decorations).map(({ value }) => value)).toEqual(["part"]);
    expect(partitionDecoratedText("", decorations)).toEqual([]);
  });

  test("retains global offsets when Markdown splits a highlight between DOM text nodes", () => {
    const decorations: MessageDecoration[] = [{ type: "note", noteId: "note", startOffset: 2, endOffset: 9 }];
    const nodes = ["Alpha ", "beta", " gamma"];
    let offset = 0;
    const highlighted = nodes.flatMap((text) => {
      const segments = partitionDecoratedText(text, decorations, offset);
      offset += text.length;
      return segments.filter(({ active }) => active.length).map(({ value }) => value);
    });
    expect(highlighted.join("")).toBe("pha bet");
  });

  test("title-only changes invalidate decoration labels", () => {
    const original = branch();
    expect(getMessageDecorationKey(buildMessageDecorations([original], [], null)))
      .not.toBe(getMessageDecorationKey(buildMessageDecorations([{ ...original, title: "Renamed branch" }], [], null)));
  });
});

test("mounted Markdown annotations refresh branch titles and clean up references", async () => {
  // Isolate DOM globals from the server-rendering suites.
  const child = Bun.spawn([process.execPath, "tests/helpers/messageDecorationsHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Message decoration regression failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(5);
}, 15000);
