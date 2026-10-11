import { createMarginDocument, type DocumentBlock } from "@margin-chat/workspace-contracts";
import type { AppState, Conversation, ConversationNote, SelectionDraft } from "../types";
import { getEditableDocument } from "./editableDocument";
import { addChildConversation } from "./workspaceCommands";

/**
 * A small sample vault for the live previews on the marketing pages. It lives
 * only in the visitor's tab: nothing is saved and nothing is sent to the server.
 */
const createdAt = "2026-10-01T09:00:00.000Z";

function blocks(id: string, paragraphs: string[]): DocumentBlock[] {
  return paragraphs.map((content, index) => ({
    id: `${id}-block-${index + 1}`, kind: "markdown", content, createdAt, updatedAt: createdAt, authorship: "user",
  }));
}

function note(id: string, title: string, paragraphs: string[], extra: Partial<Conversation> = {}): Conversation {
  return {
    id, title, kind: "note", parentId: null, childIds: [], branchAnchor: null, messages: [], notes: [],
    serviceId: "backend-services", modelId: "auto", createdAt, updatedAt: createdAt,
    document: { schemaVersion: 1, blocks: blocks(id, paragraphs), prompts: [], generations: [] },
    ...extra,
  };
}

export const DEMO_MAIN_DOCUMENT_ID = "demo-printing-press";

export function createDemoVault(): AppState {
  const conversations: Record<string, Conversation> = {
    [DEMO_MAIN_DOCUMENT_ID]: note(DEMO_MAIN_DOCUMENT_ID, "The printing press", [
      "Before Gutenberg, a book was copied by hand, and a large library held a few hundred volumes.",
      "Within fifty years of his press, Europe had printed something like twenty million books, and the number of people who could check a claim against a source grew with it.",
      "The change was less about speed than about copies being identical, which made it possible to cite a page and a line, and to argue about the same text in different cities.",
    ], { childIds: ["demo-gutenberg-bible", "demo-literacy"], linkedConversationIds: ["demo-reformation", "demo-information-overload"] }),
    "demo-gutenberg-bible": note("demo-gutenberg-bible", "Gutenberg Bible", [
      "Printed in Mainz around 1455, in about 180 copies. Fewer than fifty survive.",
    ], { parentId: DEMO_MAIN_DOCUMENT_ID }),
    "demo-literacy": note("demo-literacy", "Who could read in 1500?", [
      "Signatures on marriage registers suggest that around 1500 perhaps one man in ten in England could sign his name. By 1640 it was closer to one in three.",
    ], { parentId: DEMO_MAIN_DOCUMENT_ID, childIds: ["demo-schools"] }),
    "demo-schools": note("demo-schools", "Grammar schools", [
      "Cheap printed primers made it practical to teach reading to far more children.",
    ], { parentId: "demo-literacy" }),
    "demo-reformation": note("demo-reformation", "The Reformation", [
      "Luther's pamphlets were among the first mass-market printed texts. Printers in many cities copied them within weeks.",
    ], { childIds: ["demo-luther"], linkedConversationIds: ["demo-information-overload"] }),
    "demo-luther": note("demo-luther", "Martin Luther", [
      "Wrote in German as well as Latin, which widened his audience far beyond the clergy.",
    ], { parentId: "demo-reformation" }),
    "demo-information-overload": note("demo-information-overload", "Information overload", [
      "Scholars in the 1500s already complained that there were too many books to read. Indexes, tables of contents and reference works grew out of that complaint.",
    ], { childIds: ["demo-indexes"] }),
    "demo-indexes": note("demo-indexes", "Indexes and reference books", [
      "Alphabetical indexes let a reader find a passage without reading the whole book.",
    ], { parentId: "demo-information-overload" }),
    "demo-journals": note("demo-journals", "Scientific journals", [
      "The first journals, in 1665, depended on cheap identical copies so readers everywhere could check the same results.",
    ], { linkedConversationIds: [DEMO_MAIN_DOCUMENT_ID] }),
  };
  return {
    rootId: DEMO_MAIN_DOCUMENT_ID,
    activeConversationId: DEMO_MAIN_DOCUMENT_ID,
    defaultServiceId: "backend-services",
    defaultModelId: "auto",
    railOpen: false,
    pinnedThreadIds: [],
    graphLayouts: {},
    groups: {},
    conversations,
  };
}

/**
 * Creates a side document from a selection, the way the app does: a child of
 * the selected document, anchored to the passage when it lies in one block.
 */
export function addDemoSideDocument(state: AppState, selection: SelectionDraft, text: string, id: string, now: string): AppState {
  const parent = state.conversations[selection.conversationId];
  if (!parent) return state;
  const singleBlock = !selection.joinBlockIds?.length;
  const note: ConversationNote = {
    id, kind: "comment", content: text.trim() || `> ${selection.quote}`,
    sourceMessageId: selection.messageId, sourceBlockId: singleBlock ? selection.sourceBlockId : undefined,
    startOffset: singleBlock ? selection.startOffset : null, endOffset: singleBlock ? selection.endOffset : null,
    quote: selection.quote, createdAt: now, updatedAt: now,
  };
  const child = createMarginDocument({ ...parent, document: getEditableDocument(parent) }, note);
  // A side document opens as a full pane beside its parent rather than as a compact margin note.
  const sideDocument: Conversation = { ...child, kind: "note", document: { ...child.document!, marginNote: { ...child.document!.marginNote!, display: "full" } } };
  return addChildConversation(state, sideDocument);
}
