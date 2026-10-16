import type { ConversationGraphNodePlacement } from "./conversationGraph";
import type { MapTerritory } from "./graphPresentation";
import { getConversationRootId } from "./tree";
import type { Conversation, ConversationGroup } from "../types";

export const NOT_PLACED_FRAME_ID = "__not-placed__";
/** Space around a frame's cards, in screen pixels, with room above them for the frame's name. */
const FRAME_PADDING = 22;
const FRAME_HEADING = 18;

export interface CanvasGroupFrame extends MapTerritory {
  kind: "group" | "not-placed";
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

function frame(id: string, label: string, color: string, kind: CanvasGroupFrame["kind"], nodes: ConversationGraphNodePlacement[]): CanvasGroupFrame {
  return { id, label, color, kind, nodes,
    x: nodes.reduce((sum, node) => sum + node.x + node.width / 2, 0) / nodes.length,
    y: nodes.reduce((sum, node) => sum + node.y + node.height / 2, 0) / nodes.length };
}

/** Your groups as frames around their cards, plus the documents no one has placed on the Canvas yet. */
export function buildCanvasGroupFrames({ nodes, conversations, groups, unplacedRootIds }: {
  nodes: ConversationGraphNodePlacement[];
  conversations: Record<string, Conversation>;
  groups: Record<string, ConversationGroup>;
  unplacedRootIds: string[];
}): CanvasGroupFrame[] {
  const index = groupIndex(groups);
  const members = new Map<string, ConversationGraphNodePlacement[]>();
  const unplaced = new Set(unplacedRootIds);
  const waiting: ConversationGraphNodePlacement[] = [];
  for (const node of nodes) {
    const groupId = canvasGroupOf(conversations, groups, node.conversationId, index);
    if (groupId && groups[groupId]) members.set(groupId, [...members.get(groupId) ?? [], node]);
    else if (unplaced.has(getConversationRootId(conversations, node.conversationId) ?? node.conversationId)) waiting.push(node);
  }
  const frames = Object.values(groups).filter((group) => members.has(group.id))
    .map((group) => frame(group.id, group.name, group.color, "group", members.get(group.id)!));
  // A new vault starts with every card in the grid; call that out only once something has been placed.
  if (waiting.length && waiting.length < nodes.length) frames.push(frame(NOT_PLACED_FRAME_ID, "Not placed yet", "var(--muted)", "not-placed", waiting));
  return frames;
}

/** The smallest frame containing a point on the Canvas, measured without the cards being moved. */
export function canvasFrameAt(frames: CanvasGroupFrame[], point: { x: number; y: number }, scale: number, movedIds: ReadonlySet<string>) {
  let found: CanvasGroupFrame | null = null;
  let foundArea = Infinity;
  const padding = FRAME_PADDING / scale;
  for (const candidate of frames) {
    const remaining = candidate.nodes.filter((node) => !movedIds.has(node.conversationId));
    // A frame holding only the moved cards keeps the spot they were moved from.
    const nodes = remaining.length ? remaining : candidate.nodes;
    const left = Math.min(...nodes.map((node) => node.x)) - padding;
    const top = Math.min(...nodes.map((node) => node.y)) - padding - FRAME_HEADING / scale;
    const right = Math.max(...nodes.map((node) => node.x + node.width)) + padding;
    const bottom = Math.max(...nodes.map((node) => node.y + node.height)) + padding;
    const area = (right - left) * (bottom - top);
    if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom && area < foundArea) {
      found = candidate;
      foundArea = area;
    }
  }
  return found;
}

/** Group changes for cards dropped into a frame, or out of every frame. */
export function canvasGroupDropChanges({ ids, conversations, groups, target }: {
  ids: string[];
  conversations: Record<string, Conversation>;
  groups: Record<string, ConversationGroup>;
  target: CanvasGroupFrame | null;
}): Array<[string, string | null]> {
  const index = groupIndex(groups);
  const moved = new Set(ids);
  const next = target?.kind === "group" ? target.id : null;
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

/** Main documents by group, your groups first and everything else last, so Tidy up can gather each group in one place. */
export function canvasGroupBuckets(conversations: Record<string, Conversation>, groups: Record<string, ConversationGroup>): string[][] {
  const index = groupIndex(groups);
  const byGroup = new Map<string, string[]>(Object.keys(groups).map((id) => [id, []]));
  const rest: string[] = [];
  for (const conversation of Object.values(conversations)) {
    if (conversation.parentId) continue;
    const groupId = index.get(conversation.id);
    (groupId && byGroup.get(groupId) || rest).push(conversation.id);
  }
  return [...byGroup.values(), rest];
}
