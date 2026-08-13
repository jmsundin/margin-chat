import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "../client/node_modules/react-dom/server";
import ChatPanel from "../client/src/components/ChatPanel";
import type { Conversation } from "../client/src/types";
import { normalizeAppState } from "../server/db/validation.mjs";

const createdAt = "2026-08-13T12:00:00.000Z";

function makeConversation(): Conversation {
  return {
    branchAnchor: null,
    childIds: [],
    createdAt,
    id: "root",
    messages: [{
      content: "Keep this insight close.",
      createdAt,
      id: "message-root",
      role: "user",
    }],
    modelId: "smart-routing",
    notes: [{
      content: "This is the decision to revisit.",
      createdAt,
      endOffset: 17,
      id: "note-one",
      quote: "Keep this insight",
      sourceMessageId: "message-root",
      startOffset: 0,
      updatedAt: createdAt,
    }],
    parentId: null,
    serviceId: "backend-services",
    title: "Notes test",
    updatedAt: createdAt,
  };
}

describe("personal notes", () => {
  test("normalizes note anchors as part of persisted state", () => {
    const conversation = makeConversation();
    const state = normalizeAppState({
      activeConversationId: "root",
      conversations: { root: conversation },
      defaultModelId: "smart-routing",
      defaultServiceId: "backend-services",
      graphLayouts: {},
      pinnedThreadIds: [],
      railOpen: false,
      rootId: "root",
    });

    expect(state.conversations[0].notes).toHaveLength(1);
    expect(state.conversations[0].notes[0].quote).toBe("Keep this insight");
  });

  test("renders notes as private annotations", () => {
    const markup = renderToStaticMarkup(
      <ChatPanel
        anchorsByMessageId={{}}
        conversation={makeConversation()}
        draft=""
        isActive
        isSubmitting={false}
        onActivate={() => {}}
        onCreateNote={() => {}}
        onDeleteNote={() => {}}
        onDraftChange={() => {}}
        onModelChange={() => {}}
        onOpenBranch={() => {}}
        onStopTypewriter={() => {}}
        onSubmit={() => {}}
        onTypewriterComplete={() => {}}
        onTypewriterProgress={() => {}}
        onUpdateNote={() => {}}
        onUseNote={() => {}}
        recentModelSelections={[]}
        registerAnchorRef={() => {}}
        registerComposerSurfaceRef={() => {}}
        registerPanelRef={() => {}}
        selectionPreview={null}
        theme="dark"
        typingMessageIds={{}}
        typingProgressByMessageId={{}}
      />,
    );

    expect(markup).toContain("Text with a personal note");
    expect(markup).toContain("Private, not sent to AI");
    expect(markup).toContain('aria-label="1 personal notes. Private, not sent to AI. Open notes"');
  });
});
