import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "../client/node_modules/react-dom/server";
import ChatPanel from "../client/src/components/ChatPanel";
import LiveMarkdownEditor, {
  parseMarkdownBlocks,
} from "../client/src/components/LiveMarkdownEditor";
import MarginNoteTreeNode from "../client/src/components/MarginNoteTreeNode";
import StandaloneNotePanel from "../client/src/components/StandaloneNotePanel";
import {
  getMarkdownBackspaceEdit,
  getMarkdownEnterEdit,
} from "../client/src/lib/markdownEditing";
import {
  findObsidianCalloutBlocks,
  findObsidianInlineTokens,
  getObsidianCalloutFamily,
} from "../client/src/lib/obsidianMarkdown";
import { getConversationSelectionViewMode } from "../client/src/lib/conversationNavigation";
import { getStandaloneNoteActivationEvent } from "../client/src/lib/standaloneNoteActivation";
import {
  getStandaloneNoteContextMessageId,
  upsertStandaloneNoteContextMessage,
} from "../client/src/lib/standaloneNotes";
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
      kind: "comment",
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
  test("creates a hidden, updatable message for chatting with a note", () => {
    const note = {
      content: "A note worth discussing.",
      createdAt,
      endOffset: null,
      id: "standalone-body",
      kind: "standalone" as const,
      quote: null,
      sourceMessageId: null,
      startOffset: null,
      updatedAt: createdAt,
    };
    const firstMessages = upsertStandaloneNoteContextMessage(
      [],
      note,
      createdAt,
    );
    const updatedMessages = upsertStandaloneNoteContextMessage(
      firstMessages,
      { ...note, content: "Updated note context." },
      "2026-08-15T12:00:00.000Z",
    );

    expect(firstMessages).toEqual([
      {
        content: note.content,
        createdAt,
        id: getStandaloneNoteContextMessageId(note.id),
        role: "user",
      },
    ]);
    expect(updatedMessages).toHaveLength(1);
    expect(updatedMessages[0].content).toBe("Updated note context.");
    expect(updatedMessages[0].createdAt).toBe(createdAt);
  });

  test("persists a chat branch anchored to standalone-note context", () => {
    const standaloneNote = {
      content: "Discuss this architectural constraint.",
      createdAt,
      endOffset: null,
      id: "standalone-body",
      kind: "standalone" as const,
      quote: null,
      sourceMessageId: null,
      startOffset: null,
      updatedAt: createdAt,
    };
    const sourceMessageId = getStandaloneNoteContextMessageId(
      standaloneNote.id,
    );
    const root: Conversation = {
      ...makeConversation(),
      childIds: ["note-branch"],
      id: "standalone-root",
      kind: "note",
      messages: upsertStandaloneNoteContextMessage(
        [],
        standaloneNote,
        createdAt,
      ),
      notes: [standaloneNote],
      title: "Architecture note",
    };
    const branch: Conversation = {
      ...makeConversation(),
      branchAnchor: {
        createdAt,
        endOffset: 12,
        id: "note-anchor",
        prompt: "Explain the tradeoff.",
        quote: "architectural",
        sourceConversationId: root.id,
        sourceMessageId,
        startOffset: 0,
      },
      childIds: [],
      id: "note-branch",
      messages: [
        {
          content: "Explain the tradeoff.",
          createdAt,
          id: "note-branch-user",
          role: "user",
        },
      ],
      notes: [],
      parentId: root.id,
      title: "Architecture tradeoff",
    };
    const normalized = normalizeAppState({
      activeConversationId: branch.id,
      conversations: { [branch.id]: branch, [root.id]: root },
      defaultModelId: "smart-routing",
      defaultServiceId: "backend-services",
      graphLayouts: {},
      pinnedThreadIds: [],
      railOpen: false,
      rootId: root.id,
    });

    expect(normalized.conversations).toHaveLength(2);
    expect(normalized.conversations.find((item) => item.id === branch.id)?.branchAnchor)
      .toMatchObject({ sourceConversationId: root.id, sourceMessageId });
  });

  test("keeps standalone notes in graph view when selected there", () => {
    expect(
      getConversationSelectionViewMode({
        currentViewMode: "graph",
        targetKind: "note",
      }),
    ).toBe("graph");
    expect(
      getConversationSelectionViewMode({
        currentViewMode: "chat",
        targetKind: "note",
      }),
    ).toBe("chat");
    expect(
      getConversationSelectionViewMode({
        currentViewMode: "graph",
        targetKind: "chat",
      }),
    ).toBe("graph");
    expect(
      getConversationSelectionViewMode({
        currentViewMode: "tiles",
        targetKind: "chat",
      }),
    ).toBe("chat");
  });

  test("persists an empty standalone note as a first-class workspace item", () => {
    const conversation: Conversation = {
      ...makeConversation(),
      id: "standalone-note",
      kind: "note",
      messages: [],
      notes: [
        {
          content: "",
          createdAt,
          endOffset: null,
          id: "standalone-note-body",
          kind: "standalone",
          quote: null,
          sourceMessageId: null,
          startOffset: null,
          updatedAt: createdAt,
        },
      ],
      title: "Untitled note",
    };
    const state = normalizeAppState({
      activeConversationId: conversation.id,
      conversations: { [conversation.id]: conversation },
      defaultModelId: "smart-routing",
      defaultServiceId: "backend-services",
      graphLayouts: {
        [conversation.id]: {
          height: 640,
          positioned: true,
          treeOriginX: 120,
          treeOriginY: 180,
          width: 520,
          x: 700,
          y: 420,
        },
      },
      pinnedThreadIds: [],
      railOpen: false,
      rootId: conversation.id,
    });

    expect(state.conversations[0].kind).toBe("note");
    expect(state.conversations[0].notes[0].kind).toBe("standalone");
    expect(state.conversations[0].notes[0].content).toBe("");
    expect(state.graphLayouts[conversation.id]).toMatchObject({
      positioned: true,
      treeOriginX: 120,
      treeOriginY: 180,
      x: 700,
      y: 420,
    });

    const markup = renderToStaticMarkup(
      <StandaloneNotePanel
        conversation={conversation}
        isActive
        onActivate={() => {}}
        onRename={() => {}}
        onUpdate={() => {}}
        registerPanelRef={() => {}}
      />,
    );

    expect(markup).not.toContain("standalone-note-kicker");
    expect(markup).toContain('aria-label="Note title"');
    expect(markup).toContain("Markdown Live Preview");
  });

  test("renders a margin note as a compact side-lane card", () => {
    const markup = renderToStaticMarkup(
      <MarginNoteTreeNode
        conversationId="standalone-note"
        note={{
          content: "Compare this with the simpler option.",
          createdAt,
          endOffset: 34,
          id: "margin-note",
          kind: "comment",
          quote: "architectural constraint",
          sourceMessageId: "standalone-note-context-body",
          startOffset: 10,
          updatedAt: createdAt,
        }}
        onDelete={() => {}}
        onUpdate={() => {}}
      />,
    );

    expect(markup).toContain('data-margin-note-tree-node="margin-note"');
    expect(markup).toContain("Margin note");
    expect(markup).toContain("Compare this with the simpler option.");
    expect(markup).toContain("architectural constraint");
    expect(markup).toContain("Private note");
    expect(markup).toContain("Not sent to AI");
  });

  test("normalizes note anchors as part of persisted state", () => {
    const conversation = makeConversation();
    conversation.notes?.push({
      content: "# Side note\n\n- keep Markdown spacing\n",
      createdAt,
      endOffset: null,
      id: "note-side",
      kind: "side-chat",
      quote: null,
      sourceMessageId: null,
      startOffset: null,
      updatedAt: createdAt,
    });
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

    expect(state.conversations[0].notes).toHaveLength(2);
    expect(state.conversations[0].notes[0].quote).toBe("Keep this insight");
    expect(state.conversations[0].notes[0].kind).toBe("comment");
    expect(state.conversations[0].notes[1].kind).toBe("side-chat");
    expect(state.conversations[0].notes[1].content).toEndWith("\n");
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
        onAddSideChat={() => {}}
        onCreateNote={() => "note-created"}
        onDeleteNote={() => {}}
        onDraftChange={() => {}}
        onModelChange={() => {}}
        onOpenBranch={() => {}}
        onStopStreaming={() => {}}
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
    expect(markup).not.toContain("message-note-group");
    expect(markup).toContain('aria-label="Open a side note for this message"');
    expect(markup).toContain('aria-label="Add a sticky comment to this message"');
    expect(markup).toContain('aria-label="Open a new side note"');
    expect(markup).toContain('aria-label="Add side chat"');
  });

  test("keeps normal Markdown line-based but groups fenced code", () => {
    const blocks = parseMarkdownBlocks(
      "# Launch notes\n\nRemember the **privacy boundary**.\n\n```ts\nconst safe = true;\n```",
    );

    expect(blocks.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: "line", value: "# Launch notes" },
      { kind: "blank", value: "" },
      { kind: "line", value: "Remember the **privacy boundary**." },
      { kind: "blank", value: "" },
      {
        kind: "fenced-code",
        value: "```ts\nconst safe = true;\n```",
      },
    ]);
    expect(
      parseMarkdownBlocks("First line\n").map((block) => block.value),
    ).toEqual(["First line", ""]);
  });

  test("recognizes Markdown structures that must edit as multi-line blocks", () => {
    const examples = [
      {
        kind: "blockquote",
        value: "> First thought\n> Continued thought",
      },
      {
        kind: "list",
        value: "1. First item\n2. Second item\n   - Nested item",
      },
      {
        kind: "table",
        value: "| Name | Status |\n| --- | --- |\n| Notes | Ready |",
      },
      {
        kind: "indented-code",
        value: "    const one = 1;\n    const two = 2;",
      },
      {
        kind: "setext-heading",
        value: "Release notes\n=============",
      },
      {
        kind: "hard-break-paragraph",
        value: "First line  \nSecond line",
      },
    ] as const;

    for (const example of examples) {
      expect(parseMarkdownBlocks(example.value)).toMatchObject([example]);
    }
  });

  test("keeps an unfinished hard-break line active", () => {
    expect(parseMarkdownBlocks("First line  \n")).toMatchObject([
      {
        kind: "hard-break-paragraph",
        value: "First line  \n",
      },
    ]);
  });

  test("recognizes Obsidian-flavored syntax outside code blocks", () => {
    const value = [
      "==Highlighted== [[Architecture|System design]] ![[diagram.png|Diagram]]",
      "%%private editing comment%%",
      "```md",
      "==literal code== [[literal link]]",
      "```",
    ].join("\n");

    expect(
      findObsidianInlineTokens(value).map((token) => ({
        kind: token.kind,
        target: token.target,
      })),
    ).toEqual([
      { kind: "highlight", target: undefined },
      { kind: "wikilink", target: "Architecture" },
      { kind: "embed", target: "diagram.png" },
      { kind: "comment", target: undefined },
    ]);
  });

  test("groups and categorizes Obsidian callouts", () => {
    const value = "> [!warning]- Check this\n> Keep the whole callout together.";
    expect(findObsidianCalloutBlocks(value)).toMatchObject([
      {
        fold: "-",
        lineFroms: [0, 25],
        title: "Check this",
        type: "warning",
      },
    ]);
    expect(getObsidianCalloutFamily("caution")).toBe("warning");
    expect(getObsidianCalloutFamily("custom-type")).toBe("note");
  });

  test("uses a continuous editor canvas with Live Preview modes", () => {
    const markup = renderToStaticMarkup(
      <LiveMarkdownEditor
        ariaLabel="Side note Markdown editor"
        onChange={() => {}}
        placeholder="Start a side note…"
        value=""
      />,
    );

    expect(markup).toContain('role="group"');
    expect(markup).toContain('data-placeholder="Start a side note…"');
    expect(markup).toContain("live-markdown-editor-host");
    expect(markup).toContain('aria-label="Use Live Preview"');
    expect(markup).toContain('aria-label="Use Source"');
    expect(markup).toContain('aria-label="Use Reading"');
    expect(markup).not.toContain("live-markdown-placeholder");
  });

  test("exposes standalone selection context in editable Markdown modes", () => {
    const markup = renderToStaticMarkup(
      <LiveMarkdownEditor
        ariaLabel="Standalone Markdown editor"
        onChange={() => {}}
        readingSelectionContext={{
          conversationId: "standalone-note",
          messageId: "standalone-note-context-body",
          noteId: "body",
        }}
        value="Select this text"
      />,
    );

    expect(markup).toContain('data-selection-source="standalone-note"');
    expect(markup).toContain('data-conversation-id="standalone-note"');
    expect(markup).toContain('data-message-id="standalone-note-context-body"');
    expect(markup).toContain('data-note-id="body"');
  });

  test("activates standalone editors before their click establishes the caret", () => {
    expect(getStandaloneNoteActivationEvent(false, true)).toBe("pointerdown");
    expect(getStandaloneNoteActivationEvent(false, false)).toBe("click");
    expect(getStandaloneNoteActivationEvent(true, true)).toBeNull();
    expect(getStandaloneNoteActivationEvent(true, false)).toBeNull();
  });

  test("opens and preserves fenced code as a multiline editing context", () => {
    expect(getMarkdownEnterEdit("```ts", 5)).toEqual({
      from: 5,
      insert: "\n\n```",
      selection: 6,
      to: 5,
    });

    expect(getMarkdownEnterEdit("```ts\nconst safe = true;\n```", 24)).toBeNull();
  });

  test("continues lists, tasks, quotes, and tables", () => {
    expect(getMarkdownEnterEdit("1. First", 8)?.insert).toBe("\n2. ");
    expect(getMarkdownEnterEdit("- [x] Done", 10)?.insert).toBe("\n- [ ] ");
    expect(getMarkdownEnterEdit("> Thought", 9)?.insert).toBe("\n> ");
    expect(getMarkdownEnterEdit("| A | B |\n| --- | --- |\n| one | two |", 37)?.insert).toBe(
      "\n|  |  |",
    );
  });

  test("removes empty continuation markers before normal Backspace behavior", () => {
    expect(getMarkdownBackspaceEdit("First\n- ", 8)).toEqual({
      from: 6,
      insert: "",
      selection: 6,
      to: 8,
    });
    expect(getMarkdownBackspaceEdit("First\nSecond", 6)).toBeNull();
    expect(getMarkdownBackspaceEdit("> > ", 4)).toEqual({
      from: 2,
      insert: "",
      selection: 2,
      to: 4,
    });
  });

  test("exits empty table rows instead of creating an endless table", () => {
    const value = "| A | B |\n| --- | --- |\n|  |  |";
    expect(getMarkdownEnterEdit(value, value.length)).toEqual({
      from: 24,
      insert: "",
      selection: 24,
      to: value.length,
    });
  });
});
