import { describe, expect, test } from "bun:test";
import { dueHeldMessages, parseHeldMessages, type HeldMessage, type HoldFacts } from "../client/src/lib/heldMessages";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const held = (id: string, conversationId: string, condition: HeldMessage["condition"], createdAt = `2026-11-19T10:00:0${id.length}Z`): HeldMessage =>
  ({ id, conversationId, prompt: `ask ${id}`, condition, createdAt });
const facts = (over: Partial<HoldFacts> = {}): HoldFacts => ({ now: NOW, hasDocument: () => true, isBusy: () => false, synced: true, ...over });
const ids = (messages: HeldMessage[]) => messages.map((message) => message.id);

describe("send when", () => {
  test("a timed message waits for its time, then is released", () => {
    const later = held("a", "doc", { kind: "time", at: "2026-11-19T13:00:00Z" });
    expect(ids(dueHeldMessages([later], facts()).send)).toEqual([]);
    expect(ids(dueHeldMessages([later], facts({ now: NOW + 2 * 60 * 60 * 1000 })).send)).toEqual(["a"]);
  });

  test("nothing is released into a document where AI is still writing", () => {
    const message = held("a", "doc", { kind: "idle" });
    expect(ids(dueHeldMessages([message], facts({ isBusy: () => true })).keep)).toEqual(["a"]);
    expect(ids(dueHeldMessages([message], facts()).send)).toEqual(["a"]);
  });

  test("when-synced waits for sync, and doesn't wait in a vault that never syncs", () => {
    const message = held("a", "doc", { kind: "synced" });
    expect(ids(dueHeldMessages([message], facts({ synced: false })).keep)).toEqual(["a"]);
    expect(ids(dueHeldMessages([message], facts({ synced: true })).send)).toEqual(["a"]);
    expect(ids(dueHeldMessages([message], facts({ synced: null })).send)).toEqual(["a"]);
  });

  test("one message per document at a time, oldest first; a deleted document's message is dropped", () => {
    const first = held("a", "doc", { kind: "idle" }, "2026-11-19T10:00:00Z");
    const second = held("bb", "doc", { kind: "idle" }, "2026-11-19T10:05:00Z");
    const other = held("ccc", "other", { kind: "idle" }, "2026-11-19T10:06:00Z");
    const gone = held("dddd", "gone", { kind: "idle" });
    const result = dueHeldMessages([second, gone, other, first], facts({ hasDocument: (id) => id !== "gone" }));
    expect(ids(result.send)).toEqual(["a", "ccc"]);
    expect(ids(result.keep)).toEqual(["bb"]);
    expect(ids(result.orphaned)).toEqual(["dddd"]);
  });

  test("a released message is not in what is kept, so it can't be sent twice", () => {
    const message = held("a", "doc", { kind: "idle" });
    const { send, keep } = dueHeldMessages([message], facts());
    expect(send).toHaveLength(1);
    expect(dueHeldMessages(keep, facts()).send).toEqual([]);
  });

  test("damaged saved messages are dropped", () => {
    expect(parseHeldMessages("nope")).toEqual([]);
    const parsed = parseHeldMessages(JSON.stringify([
      { id: "a", conversationId: "doc", prompt: "ok", condition: { kind: "idle" }, createdAt: "2026-11-19T10:00:00Z" },
      { id: "a", conversationId: "doc", prompt: "duplicate id", condition: { kind: "idle" } },
      { id: "b", conversationId: "doc", prompt: "bad time", condition: { kind: "time", at: "soon" } },
      { id: "c", conversationId: "doc", prompt: "   ", condition: { kind: "idle" } },
    ]));
    expect(ids(parsed)).toEqual(["a"]);
  });
});
