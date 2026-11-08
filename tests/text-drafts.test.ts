import { beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://fixture.test" });
Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
const { loadTextDraft, saveTextDraft, TEXT_DRAFT_MAX_AGE_MS } = await import("../client/src/lib/textDrafts");

beforeEach(() => browser.localStorage.clear());

test("an unsent question is still there after a reload, and is forgotten once sent or cleared", () => {
  saveTextDraft("user:ask-note:a", "What dose did the trial use?", 1_000);
  expect(loadTextDraft("user:ask-note:a", 2_000)).toBe("What dose did the trial use?");
  expect(loadTextDraft("user:ask-note:b", 2_000)).toBe("");
  saveTextDraft("user:ask-note:a", "   ", 3_000);
  expect(loadTextDraft("user:ask-note:a", 4_000)).toBe("");
});

test("drafts left alone for two weeks are dropped, and damaged entries are ignored", () => {
  saveTextDraft("old", "Stale question", 0);
  expect(loadTextDraft("old", TEXT_DRAFT_MAX_AGE_MS + 1)).toBe("");
  browser.localStorage.setItem("margin-chat:text-draft:broken", "{not json");
  expect(loadTextDraft("broken")).toBe("");
});
