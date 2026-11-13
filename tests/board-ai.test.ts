import { describe, expect, test } from "bun:test";
import { boardNotes, buildBoardNoteMessage, nearbyNotes, notesToAnswer, placeBeside, type BoardElementLike } from "../client/src/lib/boardAI";
import { drawingMarkdown, EMPTY_DRAWING } from "../client/src/lib/documentDrawing";
import { createEmptyState } from "../client/src/initialState";
import { getEditableDocument } from "../client/src/lib/editableDocument";

const text = (id: string, words: string, x = 0, y = 0, extra: Partial<BoardElementLike> = {}): BoardElementLike =>
  ({ id, type: "text", x, y, width: 120, height: 24, text: words, ...extra });
const ai = { marginChat: { author: "ai", turn: "t1", answers: "n1" } };

describe("board notes the AI answers", () => {
  test("only new, finished, unanswered notes written by the person", () => {
    const elements = [
      text("old", "On the board when it opened"),
      text("n1", "Already answered"), { id: "a1", type: "rectangle", x: 300, y: 0, width: 80, height: 40, customData: ai },
      text("typing", "Still being typed"),
      text("asked", "Waiting for the AI"),
      text("ai-label", "AI's own words", 300, 0, { customData: ai }),
      text("short", "ok"),
      text("gone", "Deleted note", 0, 0, { isDeleted: true }),
      text("new", "Why does sleep matter?"),
    ];
    const due = notesToAnswer(elements, { known: new Set(["old"]), editingId: "typing", asked: new Set(["asked"]) });
    expect(due.map((note) => note.id)).toEqual(["new"]);
  });

  test("a label inside a shape is a note placed by its shape", () => {
    const shape: BoardElementLike = { id: "box", type: "rectangle", x: 50, y: 60, width: 200, height: 100 };
    const [note] = boardNotes([shape, text("label", "Glucose spikes", 90, 100, { containerId: "box" })]);
    expect(note).toMatchObject({ id: "label", x: 50, y: 60, width: 200, height: 100 });
    expect(boardNotes([{ ...shape, customData: ai }, text("label", "Glucose spikes", 90, 100, { containerId: "box" })])).toEqual([]);
  });

  test("other notes are context, nearest first", () => {
    const elements = [text("me", "Centre"), text("far", "Far away", 2000, 2000), text("near", "Close by", 150, 0)];
    expect(nearbyNotes(elements, boardNotes(elements)[0])).toEqual(["Close by", "Far away"]);
  });

  test("the diagram goes right of the note and covers nothing", () => {
    const note = { x: 0, y: 0, width: 100, height: 40 };
    const blocker: BoardElementLike = { id: "b", type: "rectangle", x: 180, y: 0, width: 200, height: 200 };
    const spot = placeBeside(note, { width: 150, height: 100 }, [blocker]);
    expect(spot.x).toBeGreaterThanOrEqual(180);
    const clear = !(spot.x < 380 + 20 && 180 < spot.x + 150 + 20 && spot.y < 200 + 20 && 0 < spot.y + 100 + 20);
    expect(clear).toBe(true);
    expect(placeBeside(note, { width: 150, height: 100 }, [])).toEqual({ x: 180, y: 0 });
    // The diagram's own bounds carry an x and y of their own; only its size counts.
    const noteElement: BoardElementLike = { id: "n", type: "text", text: "A note", ...note };
    const bounds = { x: 8, y: 8, width: 150, height: 100 };
    expect(placeBeside(note, bounds, [noteElement])).toEqual({ x: 180, y: 0 });
  });

  test("the request carries the note and the document's text, never the scene's JSON", () => {
    const state = createEmptyState();
    const conversation = state.conversations[state.rootId];
    const now = new Date().toISOString();
    conversation.document = { ...getEditableDocument(conversation), blocks: [
      { id: "d", kind: "markdown", content: drawingMarkdown(EMPTY_DRAWING), createdAt: now, updatedAt: now, authorship: "user" },
      { id: "t", kind: "markdown", content: "Goal: sleep 8 hours", createdAt: now, updatedAt: now, authorship: "user" }] };
    const message = buildBoardNoteMessage(conversation, { id: "m", role: "user", content: "Why sleep?", createdAt: now }, { note: "Why sleep?", nearby: ["Cortisol"] });
    expect(message.content).toContain("flowchart TD");
    expect(message.content).toContain("Why sleep?");
    expect(message.content).toContain("Goal: sleep 8 hours");
    expect(message.content).not.toContain("excalidraw");
  });
});
