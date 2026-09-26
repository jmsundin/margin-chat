import { describe, expect, test } from "bun:test";
import {
  createChildConversation,
  createEmptyState,
} from "../client/src/initialState";
import { hydratePersistedState } from "../client/src/lib/appState";
import {
  DEFAULT_BACKEND_SERVICE_ID,
  getDefaultModelIdForService,
} from "../client/src/lib/services";

describe("saved workspace recovery", () => {
  test("rebuilds child links and the active root without mutating the saved copy", () => {
    const state = createEmptyState();
    const root = state.conversations[state.rootId];
    const later = createChildConversation({
      id: "later",
      parentConversation: root,
      createdAt: "2026-01-03",
    });
    const earlier = createChildConversation({
      id: "earlier",
      parentConversation: root,
      createdAt: "2026-01-02",
    });
    state.conversations[later.id] = later;
    state.conversations[earlier.id] = earlier;
    root.childIds = ["deleted"];
    state.activeConversationId = later.id;
    state.rootId = "deleted";
    state.railOpen = true;
    const original = structuredClone(state);

    const recovered = hydratePersistedState(state)!;

    expect(recovered.rootId).toBe(root.id);
    expect(recovered.activeConversationId).toBe(later.id);
    expect(recovered.conversations[root.id].childIds).toEqual([
      earlier.id,
      later.id,
    ]);
    expect(recovered.railOpen).toBe(false);
    expect(state).toEqual(original);
  });

  test("recovers legacy fields and invalid selections while retaining note content", () => {
    const state = createEmptyState();
    const root = state.conversations[state.rootId];
    const recovered = hydratePersistedState({
      conversations: {
        [root.id]: {
          ...root,
          documents: undefined,
          kind: undefined,
          modelId: "retired-model",
          serviceId: "retired-provider",
          notes: [
            { id: "note", content: "Keep this annotation", kind: "legacy" },
          ],
        },
      },
      activeConversationId: "deleted",
      pinnedThreadIds: [root.id, "deleted", root.id],
    })!;

    expect(recovered.activeConversationId).toBe(root.id);
    expect(recovered.defaultServiceId).toBe(DEFAULT_BACKEND_SERVICE_ID);
    expect(recovered.defaultModelId).toBe(
      getDefaultModelIdForService(DEFAULT_BACKEND_SERVICE_ID),
    );
    expect(recovered.pinnedThreadIds).toEqual([root.id]);
    expect(recovered.conversations[root.id]).toMatchObject({
      documents: [],
      kind: "chat",
      notes: [{ id: "note", content: "Keep this annotation", kind: "comment" }],
    });
  });

  test("infers a missing default provider from the active conversation", () => {
    const state = createEmptyState();
    const root = state.conversations[state.rootId];
    root.serviceId = "gemini-api";
    root.modelId = getDefaultModelIdForService(root.serviceId);

    const recovered = hydratePersistedState({
      ...state,
      defaultServiceId: undefined,
      defaultModelId: undefined,
    })!;

    expect(recovered.defaultServiceId).toBe(root.serviceId);
    expect(recovered.defaultModelId).toBe(root.modelId);
  });

  test("retains pinned side documents in order while discarding missing and duplicate pins", () => {
    const state = createEmptyState();
    const root = state.conversations[state.rootId];
    const child = createChildConversation({ id: "pinned-side", parentConversation: root });
    state.conversations[child.id] = child;
    state.pinnedThreadIds = [child.id, "missing", root.id, child.id, "toString"];
    expect(hydratePersistedState(state)!.pinnedThreadIds).toEqual([child.id, root.id]);
  });

  test("returns no recovered workspace for unusable saved data", () => {
    for (const input of [
      null,
      [],
      {},
      { conversations: [] },
      { conversations: {} },
      { conversations: { broken: null } },
    ]) {
      expect(hydratePersistedState(input)).toBeNull();
    }
  });
});
