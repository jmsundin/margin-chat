import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEmptyState } from "../client/src/initialState";
import {
  completedStarterTasks, isPristineWorkspace, seedStarterDocument, STARTER_NOTE_ID, STARTER_SIDE_DOCUMENT_ID,
  STARTER_TASKS, STARTER_TITLE, tickStarterTasks,
} from "../client/src/lib/starterDocument";
import { CHAT_IMPORT_REMIND_AFTER_MS, chatImportReminderDue, finishChatImportReminder } from "../client/src/lib/chatImportReminder";
import { loadOnboarding, saveOnboarding } from "../client/src/lib/onboarding";
import { clearRestartForUpdate, markRestartForUpdate, readRestartForUpdate } from "../client/src/lib/appUpdates";
import type { AppState, Conversation } from "../client/src/types";

const at = "2026-10-22T03:00:00.000Z";
const original = (globalThis as any).localStorage;
let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
  };
  (globalThis as any).window = { localStorage: (globalThis as any).localStorage };
});
afterEach(() => { (globalThis as any).localStorage = original; delete (globalThis as any).window; });

function starter(state: AppState): Conversation {
  return state.conversations[state.rootId];
}

describe("Start here document", () => {
  test("turns only the untouched first workspace into Start here with a margin note and a side document", () => {
    const seeded = seedStarterDocument(createEmptyState(), at);
    const root = starter(seeded);
    expect(root.title).toBe(STARTER_TITLE);
    expect(root.childIds).toEqual(expect.arrayContaining([STARTER_NOTE_ID, STARTER_SIDE_DOCUMENT_ID]));
    const markdown = root.document!.blocks.map((block) => block.content).join("\n\n");
    for (const shown of ["```python", "```mermaid", "$$", "| Repair pathway |", "youtube.com/watch", "![How a cell", "[[Hallmarks of aging]]"]) {
      expect(markdown).toContain(shown);
    }
    const note = seeded.conversations[STARTER_NOTE_ID];
    expect(note.document?.marginNote?.display).toBe("compact");
    expect(note.branchAnchor?.quote).toBe("Cells repair damaged DNA thousands of times a day.");
    const side = seeded.conversations[STARTER_SIDE_DOCUMENT_ID];
    expect(side.document?.marginNote).toBeUndefined();
    expect(side.title).toBe("Hallmarks of aging");
    expect(side.branchAnchor?.quote).toBe("hallmarks of aging");
    // It starts minimized, so Start here opens at full width.
    expect(root.documentLayout?.minimizedIds).toContain(STARTER_SIDE_DOCUMENT_ID);
    expect(seeded.activeConversationId).toBe(root.id);
    // Its anchors point at the passage's real text.
    const passage = root.document!.blocks.find((block) => block.id === note.branchAnchor!.sourceBlockId)!;
    expect(passage.content.slice(note.branchAnchor!.startOffset!, note.branchAnchor!.endOffset!)).toBe(note.branchAnchor!.quote);
    expect(passage.content.slice(side.branchAnchor!.startOffset!, side.branchAnchor!.endOffset!)).toBe("hallmarks of aging");

    expect(isPristineWorkspace(seeded)).toBe(false);
    expect(seedStarterDocument(seeded, at)).toBe(seeded);
    const written = createEmptyState();
    const id = written.rootId;
    written.conversations[id] = { ...written.conversations[id], title: "My plan" };
    expect(seedStarterDocument(written, at)).toBe(written);
  });

  test("ticks tasks the person did, not the starter's own note and side document", () => {
    const seeded = seedStarterDocument(createEmptyState(), at);
    expect(completedStarterTasks(seeded).size).toBe(0);
    const note = { ...seeded.conversations[STARTER_NOTE_ID], id: "their-note" };
    const withNote: AppState = { ...seeded, conversations: { ...seeded.conversations, [note.id]: note } };
    const done = completedStarterTasks(withNote, { map: true });
    expect([...done].sort()).toEqual(["map", "note"]);
    const ticked = tickStarterTasks(withNote, done);
    const list = starter(ticked).document!.blocks[1].content;
    expect(list).toContain(`- [x] ${STARTER_TASKS.find((task) => task.id === "note")!.line}`);
    expect(list).toContain(`- [x] ${STARTER_TASKS.find((task) => task.id === "map")!.line}`);
    expect(list).toContain(`- [ ] ${STARTER_TASKS.find((task) => task.id === "side")!.line}`);
    expect(tickStarterTasks(ticked, done)).toBe(ticked);
  });
});

describe("chat import reminder", () => {
  test("shows once, days after the first visit, and never after an import", () => {
    const start = Date.parse(at);
    expect(chatImportReminderDue("u1", start)).toBe(false);
    expect(chatImportReminderDue("u1", start + CHAT_IMPORT_REMIND_AFTER_MS - 1)).toBe(false);
    expect(chatImportReminderDue("u1", start + CHAT_IMPORT_REMIND_AFTER_MS)).toBe(true);
    finishChatImportReminder("u1");
    expect(chatImportReminderDue("u1", start + 10 * CHAT_IMPORT_REMIND_AFTER_MS)).toBe(false);
  });
});

describe("onboarding record", () => {
  test("round-trips and ignores unknown values", () => {
    expect(loadOnboarding("u2")).toEqual({ checked: false, tour: "none", step: 0, mapSeen: false, keepPill: false });
    saveOnboarding("u2", { checked: true, tour: "paused", step: 3, mapSeen: true, keepPill: false });
    expect(loadOnboarding("u2")).toEqual({ checked: true, tour: "paused", step: 3, mapSeen: true, keepPill: false });
    store.set("margin-chat:onboarding:u3", JSON.stringify({ tour: "dancing", step: -2 }));
    expect(loadOnboarding("u3").tour).toBe("none");
    expect(loadOnboarding("u3").step).toBe(0);
  });
});

describe("version toast", () => {
  test("is marked only by a restart someone asked for", () => {
    expect(readRestartForUpdate()).toBe(false);
    markRestartForUpdate();
    expect(readRestartForUpdate()).toBe(true);
    clearRestartForUpdate();
    expect(readRestartForUpdate()).toBe(false);
  });
});
