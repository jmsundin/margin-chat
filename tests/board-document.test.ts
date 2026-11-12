import { describe, expect, test } from "bun:test";
import { BOARD_NODE_TYPE, findBoardBlock, isBoardDocument, makeBoardDocument, unmakeBoardDocument, withBoardBlock } from "../client/src/lib/boardDocument";
import { drawingMarkdown, EMPTY_DRAWING, isDrawingMarkdown, readDrawing } from "../client/src/lib/documentDrawing";
import { createEmptyState } from "../client/src/initialState";
import { getEditableDocument } from "../client/src/lib/editableDocument";
import { stateToVaultFiles, vaultToState } from "../client/src/lib/vaultWorkspace";
import type { DocumentBlock } from "@margin-chat/workspace-contracts";

const now = "2026-11-12T03:30:00.000Z";
const block = (id: string, content: string): DocumentBlock => ({ id, kind: "markdown", content, createdAt: now, updatedAt: now, authorship: "user" });
const scene = drawingMarkdown(JSON.stringify({ ...JSON.parse(EMPTY_DRAWING), elements: [{ id: "shape", type: "rectangle", x: 1, y: 2, width: 30, height: 40 }] }));

describe("board documents", () => {
  test("a new empty document becomes a board holding only an empty canvas", () => {
    const state = createEmptyState();
    const board = makeBoardDocument(state.conversations[state.rootId], now);
    expect(isBoardDocument(board)).toBe(true);
    const blocks = getEditableDocument(board).blocks;
    expect(blocks).toHaveLength(1);
    expect(isDrawingMarkdown(blocks[0].content)).toBe(true);
    expect(readDrawing(blocks[0].content).elements).toEqual([]);
  });

  test("an existing drawing becomes the canvas and no text is changed or lost", () => {
    const state = createEmptyState();
    const conversation = state.conversations[state.rootId];
    conversation.document = { ...getEditableDocument(conversation), blocks: [block("intro", "Notes first"), block("drawing", scene), block("after", "More")] };
    const board = makeBoardDocument(conversation, now);
    expect(getEditableDocument(board).blocks.map((item) => item.id)).toEqual(["intro", "drawing", "after"]);
    expect(findBoardBlock(getEditableDocument(board).blocks)?.id).toBe("drawing");
    const back = unmakeBoardDocument(board, now);
    expect(back.nodeType).toBeUndefined();
    expect(getEditableDocument(back).blocks).toEqual(getEditableDocument(board).blocks);
  });

  test("a document with text and no drawing keeps its text under a new canvas", () => {
    const state = createEmptyState();
    const conversation = state.conversations[state.rootId];
    conversation.document = { ...getEditableDocument(conversation), blocks: [block("text", "Keep me")] };
    const blocks = getEditableDocument(makeBoardDocument(conversation, now)).blocks;
    expect(blocks.map((item) => isDrawingMarkdown(item.content))).toEqual([true, false]);
    expect(blocks[1]).toEqual(block("text", "Keep me"));
  });

  test("the board and its scene survive a vault save and reopen", () => {
    const state = createEmptyState();
    const conversation = state.conversations[state.rootId];
    conversation.document = { ...getEditableDocument(conversation), blocks: [block("drawing", scene)] };
    state.conversations[state.rootId] = makeBoardDocument(conversation, now);
    const restored = vaultToState(stateToVaultFiles(state, {}), state).conversations[state.rootId];
    expect(restored.nodeType).toBe(BOARD_NODE_TYPE);
    expect(readDrawing(findBoardBlock(getEditableDocument(restored).blocks)!.content)).toEqual(readDrawing(scene));
  });

  test("text edits under the canvas put the board back where it was", () => {
    const board = block("drawing", scene);
    const all = [block("a", "A"), board, block("b", "B")];
    expect(withBoardBlock([block("a", "A2"), block("b", "B")], all, board).map((item) => item.id)).toEqual(["a", "drawing", "b"]);
    expect(withBoardBlock([block("b", "B")], [board, block("b", "B")], board).map((item) => item.id)).toEqual(["drawing", "b"]);
    expect(withBoardBlock([], [board], board)).toEqual([board]);
    // An undo that still holds an older copy of the scene keeps the current one.
    expect(withBoardBlock([{ ...board, content: "old" }, block("b", "B")], [board, block("b", "B")], board)[0].content).toBe(scene);
  });
});
