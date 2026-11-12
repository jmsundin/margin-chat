import type { ConversationGraphNodePlacement } from "./conversationGraph";
import { similarityBlocks, type DocumentSimilarity } from "./similarityBlocks";
import { getConversationRootId } from "./tree";
import type { Conversation, ConversationGroup } from "../types";

export const NO_GROUP_BOX_ID = "__no-group__";
/** World units: space inside a box around its cards, with room at the top for the box's name. */
const BOX_PADDING = 28;
const BOX_PADDING_TOP = 44;
const BOX_GAP = 72;
const CELL_GAP_X = 24;
const CELL_GAP_Y = 16;
/** Cells of space around a block of alike documents, so blocks read as subjects. */
const BLOCK_GAP_X = 0.45;
const BLOCK_GAP_Y = 0.4;
/** Boxes come out a little wider than tall, like the screen they sit on. */
const BOX_ASPECT = 1.4;
/** Shapes (width over height) tried for the boxes when fitting them to a screen. */
const SHAPE_CANDIDATES = [0.4, 0.55, 0.75, 1, 1.4, 1.9, 2.6];

export interface CanvasGroupBox {
  id: string;
  label: string;
  color: string;
  kind: "group" | "none";
  x: number;
  y: number;
  width: number;
  height: number;
  conversationIds: string[];
}

/** Each document's own group; the first group listing it wins, as in the sidebar. */
function groupIndex(groups: Record<string, ConversationGroup>) {
  const index = new Map<string, string>();
  for (const group of Object.values(groups)) {
    for (const id of group.conversationIds) if (!index.has(id)) index.set(id, group.id);
  }
  return index;
}

/** A document sits in its own group, else in the group of the main document it belongs to. */
export function canvasGroupOf(conversations: Record<string, Conversation>, groups: Record<string, ConversationGroup>, id: string, index = groupIndex(groups)) {
  const own = index.get(id);
  if (own) return own;
  const root = getConversationRootId(conversations, id);
  return (root && index.get(root)) || null;
}

/**
 * Canvas with groups on: each group is a box that owns its space. Its cards sit as lineage trees,
 * a main document with its children to its right, so a box's size follows what it holds. Boxes
 * are packed in rows in sidebar order, with documents in no group last, so they never overlap.
 */
export function layoutCanvasGroupBoxes({ nodes, conversations, groups, noGroupLabel = "No group", similarity, aspect = BOX_ASPECT, screenAspect }: {
  nodes: ConversationGraphNodePlacement[];
  conversations: Record<string, Conversation>;
  groups: Record<string, ConversationGroup>;
  /** What the box of documents in no group is called: "No group", or "Unfiled" when boxes are topics. */
  noGroupLabel?: string;
  /** How alike two documents are; with it, alike documents in a box sit together in blocks. */
  similarity?: DocumentSimilarity;
  /** Width over height for boxes and the whole arrangement. */
  aspect?: number;
  /**
   * Width over height of the screen the map is fitted to. With it, the boxes take whichever shape
   * lets Fit draw them largest there (tall on a phone held upright, wide on a desktop), so titles,
   * which keep their size at any zoom, get the most room. Overrides `aspect`.
   */
  screenAspect?: number;
}): { boxes: CanvasGroupBox[]; nodes: ConversationGraphNodePlacement[] } {
  const index = groupIndex(groups);
  const byId = new Map(nodes.map((node) => [node.conversationId, node]));
  const members = new Map<string, string[]>();
  // Walk each tree from its main document so children follow their parent in reading order.
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (byId.has(id)) {
      const groupId = canvasGroupOf(conversations, groups, id, index);
      const key = groupId && groups[groupId] ? groupId : NO_GROUP_BOX_ID;
      members.set(key, [...members.get(key) ?? [], id]);
    }
    for (const childId of conversations[id]?.childIds ?? []) visit(childId);
  };
  for (const node of nodes) visit(getConversationRootId(conversations, node.conversationId) ?? node.conversationId);
  for (const node of nodes) visit(node.conversationId);

  const cellWidth = Math.max(1, ...nodes.map((node) => node.width)) + CELL_GAP_X;
  const cellHeight = Math.max(1, ...nodes.map((node) => node.height)) + CELL_GAP_Y;
  // Empty groups keep a box too, so cards can be dropped into them.
  const order = [...Object.values(groups)
    .map((group) => ({ id: group.id, label: group.name, color: group.color, kind: "group" as const })),
  ...(members.has(NO_GROUP_BOX_ID) ? [{ id: NO_GROUP_BOX_ID, label: noGroupLabel, color: "var(--muted)", kind: "none" as const }] : [])];
  // Each box's blocks of alike documents don't depend on its shape; find them once.
  const alikeCache = new Map<string, ReturnType<typeof similarityBlocks>>();
  const arrange = (shape: number) => {
    const sized = order.map((box) => {
      const ids = members.get(box.id) ?? [];
      const blocksOf = similarity && ((singles: string[]) => {
        const key = `${box.id}\n${singles.join("\n")}`;
        let found = alikeCache.get(key);
        if (!found) alikeCache.set(key, found = similarityBlocks(singles, similarity));
        return found;
      });
      const { cells, columns, rows } = layoutFamilyTrees(ids, conversations, cellHeight / cellWidth, { similarity, aspect: shape, blocksOf: blocksOf || undefined });
      return { ...box, ids, cells,
        width: columns * cellWidth - CELL_GAP_X + BOX_PADDING * 2,
        height: rows * cellHeight - CELL_GAP_Y + BOX_PADDING_TOP + BOX_PADDING };
    });
    // Rows about as wide as the whole arrangement is tall, so Fit fills a screen.
    const area = sized.reduce((sum, box) => sum + (box.width + BOX_GAP) * (box.height + BOX_GAP), 0);
    const rowWidth = Math.max(...sized.map((box) => box.width), Math.sqrt(area * shape));
    const boxes: CanvasGroupBox[] = [];
    const placed: ConversationGraphNodePlacement[] = [];
    let x = 0, y = 0, rowHeight = 0, width = 0;
    for (const box of sized) {
      if (x > 0 && x + box.width > rowWidth) { x = 0; y += rowHeight + BOX_GAP; rowHeight = 0; }
      boxes.push({ id: box.id, label: box.label, color: box.color, kind: box.kind, x, y, width: box.width, height: box.height, conversationIds: box.ids });
      for (const id of box.ids) {
        const node = byId.get(id)!, cell = box.cells.get(id)!;
        placed.push({ ...node, x: x + BOX_PADDING + cell.column * cellWidth, y: y + BOX_PADDING_TOP + cell.row * cellHeight });
      }
      width = Math.max(width, x + box.width);
      x += box.width + BOX_GAP;
      rowHeight = Math.max(rowHeight, box.height);
    }
    return { boxes, nodes: placed, width, height: y + rowHeight };
  };
  if (!screenAspect || !(screenAspect > 0)) { const { boxes, nodes: placed } = arrange(aspect); return { boxes, nodes: placed }; }
  // Fit scales an arrangement by its tighter side; keep the shape it draws largest.
  let best: ReturnType<typeof arrange> | null = null, bestScale = -1;
  for (const shape of SHAPE_CANDIDATES) {
    const candidate = arrange(shape);
    const scale = Math.min(screenAspect / Math.max(1, candidate.width), 1 / Math.max(1, candidate.height));
    if (scale > bestScale * 1.001) { best = candidate; bestScale = scale; }
  }
  return { boxes: best!.boxes, nodes: best!.nodes };
}

/**
 * Inside a box, each family is a lineage tree: the main document on the left and its children in
 * the next column, a parent level with the middle of its children. A child kept in another group
 * starts its own tree there. Trees come first, then single documents, packed in shelves about as
 * wide as the box is tall, each in reading order. Positions are in grid cells; rows may be fractional.
 * With `similarity`, single documents alike in meaning form blocks of their own, most alike next to
 * each other, with space around each block; documents alike to none share the last block.
 */
export function layoutFamilyTrees(ids: string[], conversations: Record<string, Conversation>, cellAspect = 1,
  { similarity, aspect = BOX_ASPECT, blocksOf }: {
    similarity?: DocumentSimilarity;
    aspect?: number;
    /** Finds the blocks of alike documents among singles, when the caller keeps them between calls. */
    blocksOf?: (singles: string[]) => ReturnType<typeof similarityBlocks>;
  } = {}) {
  const inBox = new Set(ids);
  const childrenOf = (id: string) => (conversations[id]?.childIds ?? []).filter((childId) => inBox.has(childId));
  const roots = ids.filter((id) => { const parentId = conversations[id]?.parentId; return !parentId || !inBox.has(parentId); });
  type Block = { cells: Map<string, { column: number; row: number }>; columns: number; rows: number };
  let blocks: Block[] = roots.map((rootId) => {
    const local = new Map<string, { column: number; row: number }>();
    let leaves = 0, depth = 0;
    const place = (id: string, column: number, trail: Set<string>): number => {
      depth = Math.max(depth, column);
      const kids = childrenOf(id).filter((childId) => !trail.has(childId) && !local.has(childId));
      const next = new Set(trail).add(id);
      const childRows = kids.map((childId) => place(childId, column + 1, next));
      const row = childRows.length ? (childRows[0] + childRows[childRows.length - 1]) / 2 : leaves++;
      local.set(id, { column, row });
      return row;
    };
    place(rootId, 0, new Set());
    return { cells: local, columns: depth + 1, rows: Math.max(1, leaves) };
  });
  // Families first, then single documents, so short rows of singles don't leave holes beside tall trees.
  blocks.sort((a, b) => Number(a.cells.size === 1) - Number(b.cells.size === 1));
  const area = blocks.reduce((sum, block) => sum + block.columns * block.rows, 0);
  // At least two columns wide, so even a one-document box has room for its name.
  const width = Math.max(2, ...blocks.map((block) => block.columns), Math.round(Math.sqrt(aspect * area * cellAspect)));
  let gapX = 0, gapY = 0;
  if (similarity) {
    const singles = blocks.filter((block) => block.cells.size === 1).map((block) => [...block.cells.keys()][0]);
    const { blocks: alike, loners } = blocksOf ? blocksOf(singles) : similarityBlocks(singles, similarity);
    if (alike.length) {
      gapX = BLOCK_GAP_X; gapY = BLOCK_GAP_Y;
      // A block of alike documents is about square on screen; documents alike to none fill whole rows.
      const shape = (members: string[], columns: number): Block => ({
        cells: new Map(members.map((id, at) => [id, { column: at % columns, row: Math.floor(at / columns) }])),
        columns, rows: Math.ceil(members.length / columns),
      });
      blocks = [...blocks.filter((block) => block.cells.size > 1),
        ...alike.map((members) => shape(members, Math.max(1, Math.min(width, members.length, Math.ceil(Math.sqrt(members.length * cellAspect)))))),
        ...loners.length ? [shape(loners, Math.min(width, loners.length))] : []];
    }
  }
  const cells = new Map<string, { column: number; row: number }>();
  let column = 0, row = 0, shelf = 0, used = 0;
  for (const block of blocks) {
    if (column > 0 && column + block.columns > width + gapX + 1e-9) { column = 0; row += shelf + gapY; shelf = 0; }
    for (const [id, cell] of block.cells) cells.set(id, { column: column + cell.column, row: row + cell.row });
    used = Math.max(used, column + block.columns);
    column += block.columns + gapX;
    shelf = Math.max(shelf, block.rows);
  }
  // Documents whose place a cycle hid still get a cell of their own.
  for (const id of ids) if (!cells.has(id)) { cells.set(id, { column: 0, row: row + shelf }); shelf += 1; }
  return { cells, columns: Math.max(2, used), rows: Math.max(1, row + shelf) };
}

/** The box under a point on the Canvas, if any. */
export function canvasBoxAt(boxes: CanvasGroupBox[], point: { x: number; y: number }) {
  return boxes.find((box) => point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height) ?? null;
}

/** Group changes for cards dropped into a box: a group's box adds them to it, the No group box takes them out. */
export function canvasGroupDropChanges({ ids, conversations, groups, target }: {
  ids: string[];
  conversations: Record<string, Conversation>;
  groups: Record<string, ConversationGroup>;
  target: Pick<CanvasGroupBox, "id" | "kind">;
}): Array<[string, string | null]> {
  const index = groupIndex(groups);
  const moved = new Set(ids);
  const next = target.kind === "group" ? target.id : null;
  const changes: Array<[string, string | null]> = [];
  for (const id of ids) {
    const own = index.get(id) ?? null;
    const root = getConversationRootId(conversations, id);
    // A child moved with its main document follows that document's group.
    if (!own && root && root !== id && moved.has(root)) continue;
    // A child that only shares its main document's group stays in it.
    if (next === null && !own) continue;
    if (canvasGroupOf(conversations, groups, id, index) !== next) changes.push([id, next]);
  }
  return changes;
}

/** A topic found on the map: its members, the document that anchors it, and its name. */
export interface CanvasTopic {
  id: string;
  label: string;
  /** CSS color for the box. */
  color: string;
  /** The most connected document, or null for documents the map couldn't file. */
  hubId: string | null;
  memberIds: string[];
}

/**
 * Topics as Map groups, so each topic gets a box like one of your groups. Boxes go in name order,
 * not size, so filing a card under another topic doesn't shuffle the boxes around.
 * Documents the map couldn't file (no hub) are left out and land in the "Unfiled" box.
 */
export function topicCanvasGroups(topics: CanvasTopic[]): Record<string, ConversationGroup> {
  return Object.fromEntries(topics.filter((topic) => topic.hubId !== null && topic.memberIds.length)
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id))
    .map((topic) => [topic.id, { id: topic.id, name: topic.label, color: topic.color, collapsed: false, conversationIds: [...topic.memberIds] }]));
}

/**
 * Cards dropped into another topic's box are filed under it: each moved document is tied to a
 * document that stays in that topic (its hub, or else any member that isn't moving). Dropping into
 * the Unfiled box, or into the box a card is already in, changes nothing.
 */
export function canvasTopicDropMoves({ ids, topics, target }: {
  ids: string[];
  topics: CanvasTopic[];
  target: Pick<CanvasGroupBox, "id" | "kind">;
}): Array<[string, string]> {
  if (target.kind !== "group") return [];
  const topic = topics.find((item) => item.id === target.id);
  if (!topic) return [];
  const moving = new Set(ids);
  const anchorId = topic.hubId && !moving.has(topic.hubId) ? topic.hubId : topic.memberIds.find((id) => !moving.has(id));
  if (!anchorId) return [];
  const members = new Set(topic.memberIds);
  return ids.filter((id) => !members.has(id)).map((id) => [id, anchorId]);
}
