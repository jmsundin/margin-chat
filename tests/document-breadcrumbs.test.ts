import { describe, expect, test } from "bun:test";
import { createMarginDocument } from "@margin-chat/workspace-contracts";
import { createEmptyState, createMainConversation, createSideConversation } from "../client/src/initialState";
import { addChildConversation, addRootConversation } from "../client/src/lib/workspaceCommands";
import { closeDocument, focusDocument, getDocumentWorkspace, minimizeDocument, openDocumentBeside, replaceDocument, showDocument } from "../client/src/lib/documentWorkspace";
import { getDocumentBackTarget, getDocumentBreadcrumbs, getDocumentKind, getPresentedParentId, isPeerDocument, recordDocumentNavigation, takeDocumentBack } from "../client/src/lib/documentBreadcrumbs";
import type { AppState, Conversation } from "../client/src/types";

function branch(child: Conversation): Conversation {
  return { ...child, branchAnchor: { id: `anchor-${child.id}`, sourceConversationId: child.parentId!, sourceMessageId: "message",
    startOffset: 0, endOffset: 4, quote: "Dense", prompt: "Explain", createdAt: child.createdAt } };
}

function fixture() {
  let state = createEmptyState();
  const mainId = state.rootId;
  for (const [id, parentId, anchored] of [["interviews", mainId], ["field", "interviews"], ["roofs", mainId, true],
    ["roofs-notes", "roofs"], ["followup", "interviews", true]] as const) {
    const side = createSideConversation({ id, sourceConversation: state.conversations[parentId] });
    state = addChildConversation(state, anchored ? branch(side) : side, { activate: true });
  }
  const parent = state.conversations[mainId];
  state = addChildConversation(state, createMarginDocument(parent, { id: "check", content: "Check source", createdAt: parent.createdAt, updatedAt: parent.createdAt }, "check"));
  state = addRootConversation(state, createMainConversation({ id: "unrelated" }));
  return { state: focusDocument(state, mainId), mainId };
}

const ids = (documents: Conversation[]) => documents.map((document) => document.id);
const visible = (state: AppState, id: string) => ids(getDocumentWorkspace(state.conversations, id).visibleDocuments);

describe("breadcrumb levels", () => {
  test("side documents are peers of their source; branches and margin notes are its children", () => {
    const { state: { conversations }, mainId } = fixture();
    expect(["interviews", "field", "roofs-notes"].map((id) => isPeerDocument(conversations[id]))).toEqual([true, true, true]);
    expect([mainId, "roofs", "followup", "check"].map((id) => isPeerDocument(conversations[id]))).toEqual([false, false, false, false]);
    expect(Object.fromEntries([mainId, "interviews", "field", "roofs", "roofs-notes", "followup", "check"]
      .map((id) => [id, getPresentedParentId(conversations, id)]))).toEqual({
      [mainId]: null, interviews: null, field: null, roofs: mainId, "roofs-notes": mainId, followup: "interviews", check: mainId,
    });
    expect([mainId, "interviews", "roofs", "check"].map((id) => getDocumentKind(conversations[id]))).toEqual(["main", "side", "branch", "note"]);
    expect(conversations.interviews.parentId).toBe(mainId);
  });

  test("each level lists the documents that share it, in tab order, and the last crumb lists children", () => {
    const { state: { conversations }, mainId } = fixture();
    const main = getDocumentBreadcrumbs(conversations, mainId);
    expect(main.levels.map((level) => [level.document.id, level.parent?.id ?? null, ids(level.options)])).toEqual([
      [mainId, null, [mainId, "interviews", "field"]],
    ]);
    expect(ids(main.children)).toEqual(["check", "roofs", "roofs-notes"]);
    const deep = getDocumentBreadcrumbs(conversations, "roofs-notes");
    expect(deep.levels.map((level) => [level.document.id, ids(level.options)])).toEqual([
      [mainId, [mainId, "interviews", "field"]],
      ["roofs-notes", ["check", "roofs", "roofs-notes"]],
    ]);
    expect(deep.children).toEqual([]);
    const followup = getDocumentBreadcrumbs(conversations, "followup");
    expect(followup.levels.map((level) => level.document.id)).toEqual(["interviews", "followup"]);
    expect(ids(followup.levels[1].options)).toEqual(["followup"]);
    expect(ids(getDocumentBreadcrumbs(conversations, "unrelated").levels[0].options)).toEqual(["unrelated"]);
    expect(getDocumentBreadcrumbs(conversations, "missing")).toMatchObject({ levels: [], children: [] });
  });
});

describe("expand here, open beside and back", () => {
  test("Expand here gives the focused document's place to the target and closes it until Back", () => {
    const { state, mainId } = fixture();
    const start = closeDocument(state, "interviews");
    expect(visible(start, mainId)).not.toContain("interviews");
    const expanded = replaceDocument(start, mainId, "interviews");
    expect(expanded.activeConversationId).toBe("interviews");
    expect(visible(expanded, mainId)).toEqual(["interviews", "check", "roofs", "roofs-notes", "followup", "field"]);
    expect(getDocumentWorkspace(expanded.conversations, mainId).closedIds).toEqual([mainId]);
    expect(expanded.conversations.interviews).toBe(state.conversations.interviews);
    expect(expanded.conversations[mainId].childIds).toEqual(state.conversations[mainId].childIds);
    const back = replaceDocument(expanded, "interviews", mainId);
    expect(back.activeConversationId).toBe(mainId);
    expect(visible(back, mainId)).toEqual([mainId, "check", "roofs", "roofs-notes", "followup", "field"]);
    expect(getDocumentWorkspace(back.conversations, mainId).closedIds).toEqual(["interviews"]);
    expect(replaceDocument(start, mainId, mainId)).toBe(start);
    expect(replaceDocument(start, mainId, "missing")).toBe(start);
  });

  test("a compact margin note keeps its place in its host's margin when it becomes the focused document", () => {
    const { state, mainId } = fixture();
    const start = closeDocument(closeDocument(state, "check"), mainId);
    const focused = replaceDocument({ ...start, activeConversationId: "roofs" }, "roofs", "check");
    expect(focused.activeConversationId).toBe("check");
    const layout = getDocumentWorkspace(focused.conversations, mainId);
    expect(ids(layout.documents)).toEqual(ids(getDocumentWorkspace(start.conversations, mainId).documents));
    expect(layout.closedIds).toEqual(["roofs"]);
  });

  test("tabs and breadcrumbs focus a document without reopening ancestors the user closed", () => {
    const { state, mainId } = fixture();
    const closed = closeDocument(state, mainId);
    const shown = showDocument(closed, "roofs");
    expect(shown.activeConversationId).toBe("roofs");
    expect(getDocumentWorkspace(shown.conversations, mainId).closedIds).toEqual([mainId]);
    expect(getDocumentWorkspace(focusDocument(closed, "roofs").conversations, mainId).closedIds).toEqual([]);
    const note = showDocument(minimizeDocument(closed, "check"), "check");
    expect(note.activeConversationId).toBe("check");
    expect(getDocumentWorkspace(note.conversations, mainId)).toMatchObject({ closedIds: [], minimizedIds: [] });
  });

  test("Open beside restores the target right after the focused document and keeps focus", () => {
    const { state, mainId } = fixture();
    const start = closeDocument(state, "field");
    const beside = openDocumentBeside(start, mainId, "field");
    expect(beside.activeConversationId).toBe(mainId);
    expect(visible(beside, mainId)).toEqual([mainId, "field", "check", "roofs", "roofs-notes", "interviews", "followup"]);
    expect(openDocumentBeside(start, mainId, "roofs")).toBe(start);
    const pinned = openDocumentBeside(start, null, "field");
    expect(visible(pinned, mainId)).toEqual([mainId, "check", "roofs", "roofs-notes", "interviews", "field", "followup"]);
    const hiddenHost = minimizeDocument(closeDocument(start, mainId), "check");
    const note = openDocumentBeside({ ...hiddenHost, activeConversationId: "interviews" }, "interviews", "check");
    expect(note.activeConversationId).toBe("interviews");
    expect(visible(note, mainId)).toEqual(["check", "roofs", "roofs-notes", "interviews", mainId, "followup"]);
  });

  test("Back history travels with the tab and skips deleted documents", () => {
    const { state: { conversations }, mainId } = fixture();
    let history = recordDocumentNavigation({}, mainId, "interviews");
    expect(history).toEqual({ interviews: [mainId] });
    history = recordDocumentNavigation(history, "interviews", "field");
    expect(history).toEqual({ field: [mainId, "interviews"] });
    expect(getDocumentBackTarget(history, "field", conversations)).toBe("interviews");
    expect(takeDocumentBack(history, "field", conversations, true)).toEqual({ interviews: [mainId] });
    expect(takeDocumentBack(history, "field", conversations, false)).toEqual({});
    expect(getDocumentBackTarget({ field: [mainId, "deleted"] }, "field", conversations)).toBe(mainId);
    expect(takeDocumentBack({ field: [mainId, "deleted"] }, "field", conversations, true)).toEqual({});
    expect(getDocumentBackTarget({}, "field", conversations)).toBeNull();
  });
});
