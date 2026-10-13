import { describe, expect, test } from "bun:test";
import { createChildConversation, createMainConversation } from "../client/src/initialState";
import { FAMILY_MIN_SIZE, getMapFamilyStyles, mapFamilySize } from "../client/src/lib/graphFamilies";
import type { Conversation } from "../client/src/types";

function vault() {
  const conversations: Record<string, Conversation> = {};
  const add = (conversation: Conversation) => (conversations[conversation.id] = conversation);
  const root = add(createMainConversation({ id: "root" }));
  const child = add(createChildConversation({ id: "child", parentConversation: root }));
  add(createChildConversation({ id: "grandchild", parentConversation: child }));
  add(createChildConversation({ id: "sibling", parentConversation: root }));
  const other = add(createMainConversation({ id: "other" }));
  add(createChildConversation({ id: "other-child", parentConversation: other }));
  add(createMainConversation({ id: "lone" }));
  return conversations;
}

describe("map families", () => {
  test("parents draw larger than children, shrinking by level down to a floor", () => {
    const styles = getMapFamilyStyles(vault());
    expect(styles.get("root")).toMatchObject({ depth: 0, size: 1 });
    expect(styles.get("child")!.depth).toBe(1);
    expect(styles.get("grandchild")!.depth).toBe(2);
    expect(styles.get("root")!.size).toBeGreaterThan(styles.get("child")!.size);
    expect(styles.get("child")!.size).toBeGreaterThan(styles.get("grandchild")!.size);
    expect(styles.get("lone")).toMatchObject({ depth: 0, size: 1 });
    expect(mapFamilySize(20)).toBe(FAMILY_MIN_SIZE);
  });

  test("a family shares one hue, families differ, and lone documents stay neutral", () => {
    const styles = getMapFamilyStyles(vault());
    const hue = styles.get("root")!.hue;
    expect(hue).not.toBeNull();
    for (const id of ["child", "grandchild", "sibling"]) expect(styles.get(id)!.hue).toBe(hue);
    expect(styles.get("other")!.hue).not.toBeNull();
    expect(styles.get("other")!.hue).not.toBe(hue);
    expect(styles.get("other-child")!.hue).toBe(styles.get("other")!.hue);
    expect(styles.get("lone")!.hue).toBeNull();
  });

  test("a parent cycle or a missing parent does not hang or throw", () => {
    const conversations = vault();
    conversations.root.parentId = "grandchild";
    conversations.lone.parentId = "deleted";
    const styles = getMapFamilyStyles(conversations);
    expect(styles.size).toBe(Object.keys(conversations).length);
    expect(styles.get("lone")).toMatchObject({ depth: 0, hue: null });
  });
});
