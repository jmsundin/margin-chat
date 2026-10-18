import type { ConversationGraphNodePlacement } from "./conversationGraph";
import { getConversationRootId } from "./tree";
import type { Conversation, ConversationGroup } from "../types";

export const NO_GROUP_BOX_ID = "__no-group__";
/** World units: space inside a box around its cards, with room at the top for the box's name. */
const BOX_PADDING = 28;
const BOX_PADDING_TOP = 44;
const BOX_GAP = 72;
const CELL_GAP_X = 24;
const CELL_GAP_Y = 16;
/** Boxes come out a little wider than tall, like the screen they sit on. */
const BOX_ASPECT = 1.4;

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
 * Canvas with groups on: each group is a box that owns its space. Its cards sit in a grid, a main
 * document followed by its children, so a box's size follows how many documents it holds. Boxes
 * are packed in rows in sidebar order, with documents in no group last, so they never overlap.
 */
export function layoutCanvasGroupBoxes({ nodes, conversations, groups }: {
  nodes: ConversationGraphNodePlacement[];
  conversations: Record<string, Conversation>;
  groups: Record<string, ConversationGroup>;
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
  ...(members.has(NO_GROUP_BOX_ID) ? [{ id: NO_GROUP_BOX_ID, label: "No group", color: "var(--muted)", kind: "none" as const }] : [])];
  const sized = order.map((box) => {
    const ids = members.get(box.id) ?? [];
    // At least two columns wide, so even a one-document box has room for its name.
    const columns = Math.max(2, Math.min(ids.length, Math.round(Math.sqrt(BOX_ASPECT * ids.length * cellHeight / cellWidth))));
    const rows = Math.max(1, Math.ceil(ids.length / columns));
    return { ...box, ids, columns,
      width: columns * cellWidth - CELL_GAP_X + BOX_PADDING * 2,
      height: rows * cellHeight - CELL_GAP_Y + BOX_PADDING_TOP + BOX_PADDING };
  });

  // Rows about as wide as the whole arrangement is tall, so Fit fills a screen.
  const area = sized.reduce((sum, box) => sum + (box.width + BOX_GAP) * (box.height + BOX_GAP), 0);
  const rowWidth = Math.max(...sized.map((box) => box.width), Math.sqrt(area * BOX_ASPECT));
  const boxes: CanvasGroupBox[] = [];
  const placed: ConversationGraphNodePlacement[] = [];
  let x = 0, y = 0, rowHeight = 0;
  for (const box of sized) {
    if (x > 0 && x + box.width > rowWidth) { x = 0; y += rowHeight + BOX_GAP; rowHeight = 0; }
    boxes.push({ id: box.id, label: box.label, color: box.color, kind: box.kind, x, y, width: box.width, height: box.height, conversationIds: box.ids });
    box.ids.forEach((id, slot) => {
      const node = byId.get(id)!;
      placed.push({ ...node,
        x: x + BOX_PADDING + (slot % box.columns) * cellWidth,
        y: y + BOX_PADDING_TOP + Math.floor(slot / box.columns) * cellHeight });
    });
    x += box.width + BOX_GAP;
    rowHeight = Math.max(rowHeight, box.height);
  }
  return { boxes, nodes: placed };
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
