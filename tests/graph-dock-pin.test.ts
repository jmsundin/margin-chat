import { describe, expect, test } from "bun:test";
import { defaultGraphLocation, keepPinnedDock } from "../client/src/lib/useGraphExplorationNavigation";

describe("pinned map split pane", () => {
  const docked = { ...defaultGraphLocation(), dockedConversationId: "pinned",
    source: { conversationId: "pinned", sourceKind: "conversation" as const } };

  test("keeps the pinned document when another document would replace it", () => {
    const next = keepPinnedDock({ ...docked, dockedConversationId: "other", selectedConversationId: "other",
      source: { conversationId: "other", sourceKind: "conversation" } }, "pinned");
    expect(next.dockedConversationId).toBe("pinned");
    expect(next.selectedConversationId).toBe("other");
    expect(next.source).toBeNull();
  });

  test("keeps the pinned document open when navigation would close it", () => {
    expect(keepPinnedDock({ ...docked, dockedConversationId: null }, "pinned").dockedConversationId).toBe("pinned");
  });

  test("leaves navigation alone when nothing is pinned or the pinned document stays", () => {
    const other = { ...docked, dockedConversationId: "other" };
    expect(keepPinnedDock(other, null)).toBe(other);
    expect(keepPinnedDock(docked, "pinned")).toBe(docked);
  });
});
