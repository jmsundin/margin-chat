import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "../client/node_modules/react";
import { renderToStaticMarkup } from "../client/node_modules/react-dom/server";
import { createEmptyState } from "../client/src/initialState";
import { resolveGraphEvidence } from "../client/src/lib/graphExploration";
import { defaultGraphLocation, useGraphExplorationNavigation } from "../client/src/lib/useGraphExplorationNavigation";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
});

function restoreLocation(stored: unknown) {
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem: () => JSON.stringify(stored) },
  });
  let navigation: ReturnType<typeof useGraphExplorationNavigation> | undefined;
  function Probe() {
    navigation = useGraphExplorationNavigation("validation-account");
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return navigation!;
}

describe("persisted map source validation", () => {
  test("strips invalid quotes and offsets without discarding the saved location", () => {
    const workspace = createEmptyState();
    const conversation = workspace.conversations[workspace.rootId];
    conversation.messages = [{ id: "message", role: "user", content: "A source passage", createdAt: conversation.createdAt }];
    const saved = {
      ...defaultGraphLocation(),
      query: "passage",
      viewport: { x: -500, y: 200, scale: 0.6 },
      source: {
        conversationId: conversation.id, sourceKind: "message", messageId: "message",
        quote: { invalid: true }, startOffset: "2", endOffset: [10], unrelated: "discard me",
      },
    };
    const restored = restoreLocation(saved);
    expect(restored.restored).toBe(true);
    expect(restored.state.query).toBe("passage");
    expect(restored.state.viewport).toEqual(saved.viewport);
    expect(restored.state.source).toEqual({ conversationId: conversation.id, sourceKind: "message", messageId: "message" });
    expect(() => resolveGraphEvidence(workspace.conversations, restored.state.source!)).not.toThrow();
  });

  test("rejects source variants without their required identifiers", () => {
    for (const source of [
      { conversationId: "chat", sourceKind: "message" },
      { conversationId: "chat", sourceKind: "message", messageId: 123 },
      { conversationId: "chat", sourceKind: "standalone-note", noteId: " " },
      { conversationId: "chat", sourceKind: ["message"], messageId: "message" },
      { conversationId: " ", sourceKind: "conversation" },
    ]) {
      const restored = restoreLocation({ ...defaultGraphLocation(), source });
      expect(restored.restored).toBe(true);
      expect(restored.state.source).toBeNull();
    }
  });

  test("keeps valid source evidence and history when restoring the history envelope", () => {
    const source = { conversationId: "chat", sourceKind: "message", messageId: "message", quote: "passage", startOffset: 9, endOffset: 16 };
    const present = { ...defaultGraphLocation(), source, readerScroll: 240, overviewPresentation: "map", selectedConversationId: "chat" };
    const restored = restoreLocation({
      present,
      past: [{ ...defaultGraphLocation(), source: { conversationId: "chat", sourceKind: "message", quote: false } }],
      future: [{ ...defaultGraphLocation(), source }],
    });
    expect(restored.state.source).toEqual(source);
    expect(restored.state.readerScroll).toBe(240);
    expect(restored.state.overviewPresentation).toBe("map");
    expect(restored.canGoBack).toBe(true);
    expect(restored.canGoForward).toBe(true);
  });
});
