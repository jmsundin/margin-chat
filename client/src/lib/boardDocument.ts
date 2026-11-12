import type { DocumentBlock } from "@margin-chat/workspace-contracts";
import type { Conversation } from "../types";
import { getEditableDocument } from "./editableDocument";
import { drawingMarkdown, EMPTY_DRAWING, isDrawingMarkdown } from "./documentDrawing";

/** Frontmatter `type: "board"`: the document opens as one full-page Excalidraw canvas. */
export const BOARD_NODE_TYPE = "board";

export const isBoardDocument = (conversation: Conversation | null | undefined) => conversation?.nodeType === BOARD_NODE_TYPE;

/** The drawing a board shows: its first Excalidraw block. Other blocks stay as text under the canvas. */
export function findBoardBlock(blocks: DocumentBlock[]): DocumentBlock | undefined {
  return blocks.find((block) => isDrawingMarkdown(block.content));
}

function drawingBlock(now: string): DocumentBlock {
  return { id: `block-${crypto.randomUUID()}`, kind: "markdown", content: drawingMarkdown(EMPTY_DRAWING), createdAt: now, updatedAt: now, authorship: "user" };
}

/**
 * Turn a document into a board. Its first drawing becomes the canvas; a document with
 * no drawing gets an empty one at the top. No existing block is changed or removed.
 */
export function makeBoardDocument(conversation: Conversation, updatedAt: string): Conversation {
  const document = getEditableDocument(conversation);
  const blocks = findBoardBlock(document.blocks) ? document.blocks
    // An empty document's lone blank line is replaced, so a new board holds only its canvas.
    : [drawingBlock(updatedAt), ...document.blocks.filter((block) => block.content.trim())];
  return { ...conversation, nodeType: BOARD_NODE_TYPE, document: { ...document, blocks }, updatedAt };
}

/** Back to a normal document: the canvas stays in it as a drawing block. */
export function unmakeBoardDocument(conversation: Conversation, updatedAt: string): Conversation {
  const { nodeType: _nodeType, ...rest } = conversation;
  return { ...rest, updatedAt };
}

/** Put the board's block back where it was after the text editor sends the blocks it shows. */
export function withBoardBlock(edited: DocumentBlock[], all: DocumentBlock[], board: DocumentBlock): DocumentBlock[] {
  const index = all.findIndex((block) => block.id === board.id);
  const before = new Set(all.slice(0, Math.max(0, index)).map((block) => block.id));
  const at = edited.findIndex((block) => !before.has(block.id));
  const rest = edited.filter((block) => block.id !== board.id);
  const position = at < 0 ? rest.length : Math.min(at, rest.length);
  return [...rest.slice(0, position), board, ...rest.slice(position)];
}
