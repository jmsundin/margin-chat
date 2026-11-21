import { describe, expect, test } from "bun:test";
import { createEmptyState } from "../client/src/initialState";
import { alreadyConnected, buildRelatedIndex, findRelatedNote, terms } from "../client/src/lib/relatedBeside";
import type { Conversation } from "../client/src/types";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
function doc(id: string, text: string, updatedAt = daysAgo(120), extra: Partial<Conversation> = {}): Conversation {
  const root = createEmptyState().conversations[createEmptyState().rootId];
  return { ...root, id, title: id, parentId: null, childIds: [], messages: [], kind: "note", updatedAt,
    document: { schemaVersion: 1, prompts: [], generations: [], blocks: [{ id: `${id}-b`, kind: "markdown", content: text, createdAt: updatedAt, updatedAt }] }, ...extra } as Conversation;
}
const vault = (...docs: Conversation[]) => ({ conversations: Object.fromEntries(docs.map((d) => [d.id, d])) });

const LACTATE = "Zone 2 is where the mitochondria get built. Lactate clearance improves when mitochondria multiply, so long easy rides at steady heart rate matter more than intervals for lactate.";
const SLEEP = "Deep sleep falls when screens stay on late. Melatonin timing and a cool bedroom helped my sleep scores more than supplements did.";
const FILLER = ["Groceries list for the weekend party with friends and family", "Notes on the novel chapter about the lighthouse keeper and his daughter", "Garden planting schedule for tomatoes peppers and basil in spring"];

describe("related note while writing", () => {
  const state = vault(doc("Mitochondria and lactate", LACTATE), doc("Sleep notes", SLEEP), ...FILLER.map((t, i) => doc(`Filler ${i}`, t)),
    doc("Zone 2 plan for winter", "", daysAgo(0)));

  test("finds the older note about what is being written, with the words they share", () => {
    const index = buildRelatedIndex(state, NOW);
    const pick = findRelatedNote({ index, now: NOW, exclude: new Set(["Zone 2 plan for winter"]),
      passage: "Indoor bike four times a week at a steady heart rate. The goal is better lactate clearance, which means more mitochondria before the spring hill block." });
    expect(pick?.id).toBe("Mitochondria and lactate");
    expect(pick?.shared).toContain("lactate");
    expect(pick?.lastEdited).toBe("4 months ago");
  });

  test("nothing when the passage is short, unrelated, already linked, or the note is fresh or stopped", () => {
    const index = buildRelatedIndex(state, NOW);
    const passage = "Indoor bike four times a week at a steady heart rate. The goal is better lactate clearance, which means more mitochondria before the spring hill block.";
    expect(findRelatedNote({ index, now: NOW, exclude: new Set(), passage: "lactate mitochondria" })).toBeNull();
    expect(findRelatedNote({ index, now: NOW, exclude: new Set(), passage: "The quarterly budget meeting moved to Thursday afternoon, bring the spreadsheet and the printed invoices for the auditors." })).toBeNull();
    expect(findRelatedNote({ index, now: NOW, exclude: new Set(["Mitochondria and lactate"]), passage })).toBeNull();
    expect(findRelatedNote({ index, now: NOW, exclude: new Set(), passage, log: { shown: 0, ignored: 0, notes: { "Mitochondria and lactate": { due: 0, gap: -1 } } } })).toBeNull();
    const fresh = buildRelatedIndex(vault(doc("Mitochondria and lactate", LACTATE, daysAgo(3))), NOW);
    expect(findRelatedNote({ index: fresh, now: NOW, exclude: new Set(), passage })).toBeNull();
  });

  test("links in either direction count as already connected", () => {
    const writing = doc("Draft", "See [[Sleep notes]] later.", daysAgo(0));
    const pointing = doc("Pointer", "x", daysAgo(50), { linkedConversationIds: ["Draft"] });
    expect([...alreadyConnected(writing, vault(writing, pointing, doc("Sleep notes", SLEEP)))].sort()).toEqual(["Draft", "Pointer", "Sleep notes"]);
  });

  test("terms drop short and common words and meet plurals", () => {
    expect(terms("The doses and the dose; mitochondria's role")).toEqual(["dose", "dose", "mitochondria", "role"]);
  });
});
