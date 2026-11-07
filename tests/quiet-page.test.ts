import { afterEach, describe, expect, test } from "bun:test";
import { readQuietPage, saveQuietPage, showsQuietTabs, subscribeQuietPage, syncPaper } from "../client/src/lib/quietPage";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage ??= {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
};

describe("quiet page", () => {
  afterEach(() => localStorage.removeItem("margin-chat:quiet-page"));

  test("is on until turned off, and tells listeners when it changes", () => {
    expect(readQuietPage()).toBe(true);
    let calls = 0;
    const stop = subscribeQuietPage(() => { calls += 1; });
    saveQuietPage(false);
    expect(readQuietPage()).toBe(false);
    saveQuietPage(true);
    expect(readQuietPage()).toBe(true);
    stop();
    saveQuietPage(false);
    expect(calls).toBe(2);
  });

  test("shows tabs only when there's more than one document or you're in a space", () => {
    expect(showsQuietTabs(0, false)).toBe(false);
    expect(showsQuietTabs(1, false)).toBe(false);
    expect(showsQuietTabs(2, false)).toBe(true);
    expect(showsQuietTabs(1, true)).toBe(true);
  });

  test("puts the page on paper while the quiet page is on", () => {
    const original = (globalThis as { document?: unknown }).document;
    const dataset: Record<string, string> = {};
    (globalThis as { document?: unknown }).document = { documentElement: { dataset } };
    try {
      syncPaper();
      expect("paper" in dataset).toBe(true);
      saveQuietPage(false);
      expect("paper" in dataset).toBe(false);
      saveQuietPage(true);
      expect("paper" in dataset).toBe(true);
    } finally {
      (globalThis as { document?: unknown }).document = original;
    }
  });
});
