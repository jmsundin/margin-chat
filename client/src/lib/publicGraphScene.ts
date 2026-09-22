import type { PublicExpansion, PublicRelation, PublicTopic } from "./publicKnowledge";
import { resolveGraphFocusLayout } from "./graphFocusLayout";
import { matchesPublicRelationFilter, type PublicRelationFilters } from "./publicRelationFilters";

export const PUBLIC_NODE_WIDTH = 248;
export const PUBLIC_NODE_HEIGHT = 152;
export const PUBLIC_FOCUSED_WIDTH = 320;
export const PUBLIC_FOCUSED_HEIGHT = 214;

export interface PublicGraphPosition { x: number; y: number }
export interface PublicGraphExpansion {
  topicIds: string[];
  relations: PublicRelation[];
  visible: boolean;
  hasMore: boolean;
  nextOffset: number;
}
export interface PublicGraphState {
  topics: Record<string, PublicTopic>;
  roots: string[];
  positions: Record<string, PublicGraphPosition>;
  expansions: Record<string, PublicGraphExpansion>;
}

export interface PublicGraphViewOptions {
  filters?: PublicRelationFilters;
  /** Keep the current topic while filtering, provided its branch is still open. */
  selectedId?: string | null;
}

export function emptyPublicGraph(): PublicGraphState {
  return { topics: {}, roots: [], positions: {}, expansions: {} };
}

/** Choose an unused slot near the anchor without moving any established topic. */
function placeTopic(positions: PublicGraphState["positions"], anchor: PublicGraphPosition): PublicGraphPosition {
  const occupied = Object.values(positions);
  const free = (point: PublicGraphPosition) => occupied.every((other) =>
    Math.abs(other.x - point.x) >= PUBLIC_NODE_WIDTH + 72 || Math.abs(other.y - point.y) >= PUBLIC_NODE_HEIGHT + 96);
  if (free(anchor)) return anchor;
  for (let ring = 1; ring < occupied.length + 2; ring += 1) {
    // Begin beside the expanded topic. Rings grow in a stable clockwise order.
    const candidates: PublicGraphPosition[] = [];
    for (let y = -ring; y <= ring; y += 1) candidates.push({ x: anchor.x + ring * 360, y: anchor.y + y * 270 });
    for (let x = ring - 1; x >= -ring; x -= 1) candidates.push({ x: anchor.x + x * 360, y: anchor.y + ring * 270 });
    for (let y = ring - 1; y >= -ring; y -= 1) candidates.push({ x: anchor.x - ring * 360, y: anchor.y + y * 270 });
    for (let x = -ring + 1; x < ring; x += 1) candidates.push({ x: anchor.x + x * 360, y: anchor.y - ring * 270 });
    const point = candidates.find(free);
    if (point) return point;
  }
  return { x: anchor.x + (occupied.length + 2) * 360, y: anchor.y };
}

export function addPublicGraphRoot(state: PublicGraphState, topic: PublicTopic): PublicGraphState {
  return {
    ...state,
    topics: { ...state.topics, [topic.id]: topic },
    roots: state.roots.includes(topic.id) ? state.roots : [...state.roots, topic.id],
    positions: state.positions[topic.id] ? state.positions : {
      ...state.positions, [topic.id]: placeTopic(state.positions, { x: 0, y: 0 }),
    },
  };
}

export function appendPublicGraphExpansion(state: PublicGraphState, result: PublicExpansion): PublicGraphState {
  const root = state.topics[result.topic.id] ? state : addPublicGraphRoot(state, result.topic);
  const topics = { ...root.topics, [result.topic.id]: result.topic };
  const positions = { ...root.positions };
  const anchor = positions[result.topic.id];
  for (const topic of result.topics) {
    topics[topic.id] = topic;
    positions[topic.id] ??= placeTopic(positions, anchor);
  }
  const previous = root.expansions[result.topic.id];
  const relations = [...new Map([...(previous?.relations ?? []), ...result.relations].map((relation) => [relation.id, relation])).values()];
  return {
    ...root, topics, positions,
    expansions: {
      ...root.expansions,
      [result.topic.id]: {
        topicIds: [...new Set([...(previous?.topicIds ?? []), ...result.topics.map((topic) => topic.id)])],
        relations, visible: true, hasMore: result.hasMore, nextOffset: result.nextOffset,
      },
    },
  };
}

export function setPublicExpansionVisible(state: PublicGraphState, id: string, visible: boolean): PublicGraphState {
  const expansion = state.expansions[id];
  return expansion ? { ...state, expansions: { ...state.expansions, [id]: { ...expansion, visible } } } : state;
}

/** Reachability keeps shared neighbors and their branches when another branch is hidden. */
export function visiblePublicGraph(state: PublicGraphState, options: PublicGraphViewOptions = {}) {
  const visible = new Set<string>();
  const relations = new Map<string, PublicRelation>();
  const pending = [...state.roots];
  // A filter should not dismiss the topic being read. A collapsed branch is
  // deliberately hidden, however, and must not be resurrected by selection.
  if (options.filters && options.selectedId
    && visiblePublicGraph(state).topics.some((topic) => topic.id === options.selectedId)) {
    pending.push(options.selectedId);
  }
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index];
    if (visible.has(id) || !state.topics[id]) continue;
    visible.add(id);
    const expansion = state.expansions[id];
    if (!expansion?.visible) continue;
    const matching = options.filters
      ? expansion.relations.filter((relation) => matchesPublicRelationFilter(relation, options.filters))
      : expansion.relations;
    pending.push(...(options.filters ? matching.map((relation) => relation.targetId) : expansion.topicIds));
    for (const relation of matching) relations.set(relation.id, relation);
  }
  return {
    topics: [...visible].map((id) => state.topics[id]),
    relations: [...relations.values()].filter((relation) => visible.has(relation.sourceId) && visible.has(relation.targetId)),
  };
}

export function publicGraphPlacements(state: PublicGraphState, selectedId: string | null, options: PublicGraphViewOptions = {}) {
  const placements = visiblePublicGraph(state, options).topics.map((topic) => ({
    conversationId: topic.id, ...state.positions[topic.id], depth: 0,
    width: topic.id === selectedId ? PUBLIC_FOCUSED_WIDTH : PUBLIC_NODE_WIDTH,
    height: topic.id === selectedId ? PUBLIC_FOCUSED_HEIGHT : PUBLIC_NODE_HEIGHT,
  }));
  return selectedId ? resolveGraphFocusLayout({ placements, selectedConversationId: selectedId, gapX: 48, gapY: 64 }) : placements;
}
