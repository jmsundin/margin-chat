import { describe, expect, test } from "bun:test";
import { createMainConversation, createStandaloneNoteConversation } from "../client/src/initialState";
import { getConversationAnnotationPreview, summarizeAnnotationText } from "../client/src/lib/annotationPreview";
import { getStandaloneNoteContextMessageId } from "../client/src/lib/standaloneNotes";
import type { Message } from "../client/src/types";

const message = (id: string, role: Message["role"], content: string): Message => ({ id, role, content, createdAt: "2026-09-19" });

describe("saved annotation previews", () => {
  test("uses a standalone note's primary body, not private annotations or context messages", () => {
    const note = createStandaloneNoteConversation({ id: "note", noteId: "body" });
    note.notes![0].content = "## Decisions\n\nUse **larger text** for navigation.";
    note.notes!.unshift({ ...note.notes![0], id: "private", kind: "comment", content: "Private annotation" });
    note.messages = [message("response", "assistant", "Context-only reply")];
    const original = structuredClone(note);
    expect(getConversationAnnotationPreview(note)).toEqual({ kind: "note", content: "Decisions Use larger text for navigation." });
    expect(note).toEqual(original);
  });

  test("pairs the first actual user prompt with the latest substantive assistant response", () => {
    const chat = createMainConversation();
    chat.messages = [
      message("system", "system", "System instructions"),
      message(getStandaloneNoteContextMessageId("source"), "user", "Imported source context"),
      message("blank-user", "user", " \n "),
      message("prompt", "user", "Explain **this choice**."),
      message("first-response", "assistant", "The first answer."),
      message("follow-up", "user", "Give an example."),
      message("latest-response", "assistant", "Here is the [latest example](https://example.com)."),
      message("pending", "assistant", ""),
    ];
    expect(getConversationAnnotationPreview(chat)).toEqual({ kind: "chat", prompt: "Explain this choice.", content: "Here is the latest example.", messageCount: 4 });
  });

  test("leaves empty and waiting content empty so the caller can supply the right status", () => {
    const chat = createMainConversation();
    expect(getConversationAnnotationPreview(chat)).toEqual({ kind: "chat", content: "", messageCount: 0 });
    chat.messages = [message("system", "system", "Context"), message("prompt", "user", "Help with this."), message("pending", "assistant", " \n")];
    expect(getConversationAnnotationPreview(chat)).toEqual({ kind: "chat", prompt: "Help with this.", content: "", messageCount: 1 });
    const note = createStandaloneNoteConversation({ id: "note", noteId: "body" });
    expect(getConversationAnnotationPreview(note)).toEqual({ kind: "note", content: "" });
    note.notes = [];
    expect(getConversationAnnotationPreview(note)).toEqual({ kind: "note", content: "" });
  });

  test("removes formatting while retaining readable links, lists, code, tables, and entities", () => {
    const markdown = "# Summary\n\n- [x] **Done** and *reviewed*\n- [Docs](https://example.com) &amp; ![Diagram](image.png)\n\n```ts\nconst id = user_id;\n```\n\n| Item | Status |\n| --- | --- |\n| One | Ready |\n\n<div>Safe &lt;example&gt;</div><!-- hidden -->";
    expect(summarizeAnnotationText(markdown)).toBe("Summary Done and reviewed Docs & Diagram const id = user_id; Item Status One Ready Safe <example>");
    expect(summarizeAnnotationText("---\n\n<!-- hidden -->")).toBe("");
  });

  test("uses Obsidian labels and omits comments without altering literal code", () => {
    expect(summarizeAnnotationText("See [[Notes/Plan|the plan]] and ==the decision==. %%hidden%% `[[literal]]`"))
      .toBe("See the plan and the decision. [[literal]]");
  });

  test("bounds summaries and prompts, preserves whole words when possible, and avoids broken surrogates", () => {
    expect(summarizeAnnotationText("A readable sentence with a trailing detail", 24)).toBe("A readable sentence…");
    expect(summarizeAnnotationText("abcdef", 1)).toBe("…");
    expect(summarizeAnnotationText("abcdef", 0)).toBe("");
    expect(summarizeAnnotationText("abc😀def", 5)).toBe("abc…");
    const chat = createMainConversation();
    chat.messages = [message("prompt", "user", "Question ".repeat(100)), message("reply", "assistant", "Answer ".repeat(100))];
    const preview = getConversationAnnotationPreview(chat);
    expect(preview.prompt!.length).toBeLessThanOrEqual(160);
    expect(preview.content.length).toBeLessThanOrEqual(300);
    expect(preview.content.endsWith("…")).toBe(true);
  });
});
