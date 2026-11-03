import { describe, expect, test } from "bun:test";
import { createEmptyState, createMainConversation, createSideConversation, createStandaloneNoteConversation } from "../client/src/initialState";
import {
  collectExpiredEmptyDocuments, EMPTY_DOCUMENT_CLEANUP_DELAY_MS, isUntouchedEmptyDocument, noteDocumentFocusChange,
} from "../client/src/lib/emptyDocumentCleanup";
import type { AppState, Conversation } from "../client/src/types";

const T0 = Date.parse("2026-11-03T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

function workspace(): { state: AppState; kept: Conversation; fresh: Conversation } {
  const base = createEmptyState();
  const kept = { ...base.conversations[base.rootId]!, title: "Senolytics", createdAt: at(-86_400_000) };
  const fresh = { ...createMainConversation({ id: "fresh", createdAt: at(1_000) }), title: "Untitled document" };
  const state: AppState = { ...base, rootId: kept.id, activeConversationId: kept.id,
    conversations: { [kept.id]: kept, fresh } };
  return { state, kept, fresh };
}

const withDoc = (state: AppState, conversation: Conversation): AppState =>
  ({ ...state, conversations: { ...state.conversations, [conversation.id]: conversation } });

describe("untouched empty documents", () => {
  test("a new document with nothing in it counts, with every placeholder name", () => {
    const { state } = workspace();
    expect(isUntouchedEmptyDocument(state, "fresh")).toBe(true);
    const note = createStandaloneNoteConversation({ id: "note", noteId: "n", createdAt: at(1_000) });
    expect(isUntouchedEmptyDocument(withDoc(state, note), "note")).toBe(true);
  });

  test("anything you put in keeps it", () => {
    const { state, fresh, kept } = workspace();
    const block = { id: "b", kind: "markdown" as const, content: "kidney", createdAt: at(0), updatedAt: at(0), authorship: "user" as const };
    const cases: Array<[string, AppState, string?]> = [
      ["renamed", withDoc(state, { ...fresh, title: "Kidneys" })],
      ["typed", withDoc(state, { ...fresh, document: { schemaVersion: 1, blocks: [block], prompts: [], generations: [] } })],
      ["asked AI", withDoc(state, { ...fresh, messages: [{ id: "m", role: "user", content: "hi", createdAt: at(0) } as Conversation["messages"][number]] })],
      ["has a child", withDoc(state, { ...fresh, childIds: ["x"] })],
      ["tagged", withDoc(state, { ...fresh, tags: ["aging"] })],
      ["linked from elsewhere", withDoc(state, { ...kept, linkedConversationIds: ["fresh"] })],
      ["pinned", { ...state, pinnedThreadIds: ["fresh"] }],
      ["in a group", { ...state, groups: { g: { id: "g", name: "G", color: "", collapsed: false, conversationIds: ["fresh"] } } }],
      ["unsent prompt", state, "what is mTOR"],
    ];
    for (const [label, next, draft] of cases) expect([label, isUntouchedEmptyDocument(next, "fresh", draft)]).toEqual([label, false]);
  });

  test("an empty side document beside a passage still counts", () => {
    const { state, kept } = workspace();
    const side = createSideConversation({ id: "side", createdAt: at(1_000), sourceConversation: kept });
    const next = withDoc({ ...state, conversations: { ...state.conversations, [kept.id]: { ...kept, childIds: ["side"] } } }, side);
    expect(isUntouchedEmptyDocument(next, "side")).toBe(true);
  });
});

describe("leaving and coming back", () => {
  test("leaving a new empty document starts its wait; coming back clears it", () => {
    const { state, kept } = workspace();
    const left = noteDocumentFocusChange({}, state, "fresh", kept.id, { createdSince: T0, now: T0 + 5_000 });
    expect(left).toEqual({ fresh: T0 + 5_000 });
    expect(noteDocumentFocusChange(left, state, kept.id, "fresh", { createdSince: T0, now: T0 + 6_000 })).toEqual({});
  });

  test("documents from before this visit are never put on the list", () => {
    const { state, kept } = workspace();
    expect(noteDocumentFocusChange({}, state, "fresh", kept.id, { createdSince: T0 + 10_000, now: T0 + 20_000 })).toEqual({});
  });

  test("removes only after the wait, and never while it is on screen or the only document", () => {
    const { state } = workspace();
    const left = { fresh: T0 };
    const early = collectExpiredEmptyDocuments(left, state, { now: T0 + EMPTY_DOCUMENT_CLEANUP_DELAY_MS - 1, visibleIds: new Set() });
    expect(early).toEqual({ remove: [], left });
    const late = T0 + EMPTY_DOCUMENT_CLEANUP_DELAY_MS;
    expect(collectExpiredEmptyDocuments(left, state, { now: late, visibleIds: new Set() })).toEqual({ remove: ["fresh"], left: {} });
    expect(collectExpiredEmptyDocuments(left, state, { now: late, visibleIds: new Set(["fresh"]) })).toEqual({ remove: [], left });
    expect(collectExpiredEmptyDocuments(left, { ...state, activeConversationId: "fresh" }, { now: late, visibleIds: new Set() }).remove).toEqual([]);
    const alone = { ...state, conversations: { fresh: state.conversations.fresh! } };
    expect(collectExpiredEmptyDocuments(left, alone, { now: late, visibleIds: new Set() }).remove).toEqual([]);
  });

  test("a document that got content or was deleted drops off the list", () => {
    const { state, fresh } = workspace();
    const renamed = withDoc(state, { ...fresh, title: "Kidneys" });
    expect(collectExpiredEmptyDocuments({ fresh: T0, gone: T0 }, renamed, { now: T0 + 1e9, visibleIds: new Set() }))
      .toEqual({ remove: [], left: {} });
  });
});
