import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
  test("restores supported document layouts and safely defaults older or malformed choices", () => {
    const viewport = { x: -310, y: 170, scale: 0.38 };
    for (const documentLayoutMode of ["auto", "tree-right", "tree-down", "connections"]) {
      const restored = restoreLocation({ ...defaultGraphLocation(), overviewPresentation: "documents", documentLayoutMode, viewport });
      expect(restored.restored).toBe(true);
      expect(restored.state).toMatchObject({ overviewPresentation: "documents", documentLayoutMode, viewport });
    }
    const { documentLayoutMode: _mode, ...olderLocation } = defaultGraphLocation();
    expect(restoreLocation(olderLocation).state.documentLayoutMode).toBe("auto");
    for (const documentLayoutMode of [null, "tree", "TREE-RIGHT", "", 1, {}, ["connections"]]) {
      const restored = restoreLocation({ ...olderLocation, documentLayoutMode, viewport });
      expect(restored.state.documentLayoutMode).toBe("auto");
      expect(restored.state.viewport).toEqual(viewport);
    }
    const restored = restoreLocation({
      present: { ...defaultGraphLocation(), overviewPresentation: "documents", documentLayoutMode: "connections" },
      past: [{ ...olderLocation, overviewPresentation: "documents", documentLayoutMode: "tree-right" }],
      future: [{ ...olderLocation, overviewPresentation: "documents", documentLayoutMode: "tree-down" }],
    });
    expect(restored.state.documentLayoutMode).toBe("connections");
    expect(restored.canGoBack).toBe(true);
    expect(restored.canGoForward).toBe(true);
  });

  test("restores group focus alongside its camera and defaults older locations to no group focus", () => {
    const viewport = { x: -400, y: 120, scale: 0.45 };
    expect(restoreLocation({ ...defaultGraphLocation(), focusedTerritoryId: "research", focusedTerritoryScale: 0.6, viewport }).state)
      .toMatchObject({ focusedTerritoryId: "research", focusedTerritoryScale: 0.6, viewport });
    const { focusedTerritoryId: _focus, focusedTerritoryScale: _scale, ...olderLocation } = defaultGraphLocation();
    expect(restoreLocation(olderLocation).state.focusedTerritoryId).toBeNull();
    expect(restoreLocation({ ...olderLocation, focusedTerritoryId: { invalid: true } }).state.focusedTerritoryId).toBeNull();
    expect(restoreLocation({ ...olderLocation, focusedTerritoryId: "research", viewport }).state.focusedTerritoryScale).toBe(viewport.scale);
    for (const focusedTerritoryScale of [0, -1, "0.6", {}, null]) {
      expect(restoreLocation({ ...olderLocation, focusedTerritoryId: "research", focusedTerritoryScale, viewport }).state.focusedTerritoryScale)
        .toBe(viewport.scale);
    }
    expect(restoreLocation({ ...olderLocation, focusedTerritoryScale: 0.6 }).state.focusedTerritoryScale).toBeNull();
  });

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
