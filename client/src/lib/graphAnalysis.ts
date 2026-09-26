import type { Conversation, ConversationGroup } from "../types";

export type GraphAnalysisRelationKind = "branch" | "link";
export interface GraphAnalysisEdge {
  id: string;
  sourceId: string;
  targetId: string;
  kind: GraphAnalysisRelationKind;
}

/** Parent → child and authored source → target. A pair may have both kinds. */
export function getGraphAnalysisEdges(conversations: Record<string, Conversation>): GraphAnalysisEdge[] {
  const edges = new Map<string, GraphAnalysisEdge>();
  const add = (sourceId: string, targetId: string, kind: GraphAnalysisRelationKind) => {
    if (sourceId === targetId || !Object.hasOwn(conversations, sourceId) || !Object.hasOwn(conversations, targetId)) return;
    const id = JSON.stringify([kind, sourceId, targetId]);
    edges.set(id, { id, sourceId, targetId, kind });
  };
  for (const conversation of Object.values(conversations)) {
    if (conversation.parentId) add(conversation.parentId, conversation.id, "branch");
    for (const targetId of conversation.linkedConversationIds ?? []) add(conversation.id, targetId, "link");
  }
  return [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface GraphTimelineEntry {
  conversationId: string;
  timestamp: number | null;
}

/** Retains undated documents so invalid/imported dates never hide a source. */
export function getGraphTimelineEntries(
  conversations: Record<string, Conversation>, basis: "created" | "updated",
): GraphTimelineEntry[] {
  return Object.values(conversations).map((conversation) => {
    const value = basis === "created" ? conversation.createdAt : conversation.updatedAt;
    const parsed = typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
    return { conversationId: conversation.id, timestamp: Number.isFinite(parsed) ? parsed : null };
  }).sort((a, b) => {
    if (a.timestamp === null && b.timestamp !== null) return 1;
    if (b.timestamp === null && a.timestamp !== null) return -1;
    return (b.timestamp ?? 0) - (a.timestamp ?? 0) || a.conversationId.localeCompare(b.conversationId);
  });
}

export interface GraphFlowGroup {
  id: string;
  label: string;
  groupIds: string[];
  conversationIds: string[];
}
export interface GraphFlowBand {
  id: string;
  sourceGroupId: string;
  targetGroupId: string;
  count: number;
  branchCount: number;
  linkCount: number;
  edges: GraphAnalysisEdge[];
}
export interface GraphFlowSummary {
  groups: GraphFlowGroup[];
  bands: GraphFlowBand[];
  totalCount: number;
}

/**
 * A document belongs to one exact membership combination, including Ungrouped.
 * This preserves overlapping groups while counting each relationship once.
 */
export function getGraphFlowSummary(
  conversations: Record<string, Conversation>,
  groups: Record<string, ConversationGroup>,
  edges: GraphAnalysisEdge[] = getGraphAnalysisEdges(conversations),
): GraphFlowSummary {
  const memberships = new Map<string, Set<string>>();
  for (const group of Object.values(groups)) {
    for (const conversationId of group.conversationIds) {
      if (!Object.hasOwn(conversations, conversationId)) continue;
      if (!memberships.has(conversationId)) memberships.set(conversationId, new Set());
      memberships.get(conversationId)!.add(group.id);
    }
  }
  const groupById = new Map(Object.values(groups).map((group) => [group.id, group]));
  const flowGroups = new Map<string, GraphFlowGroup>();
  const documentGroups = new Map<string, string>();
  for (const conversation of Object.values(conversations)) {
    const groupIds = [...memberships.get(conversation.id) ?? []].sort();
    const id = JSON.stringify(groupIds);
    if (!flowGroups.has(id)) flowGroups.set(id, {
      id, groupIds, label: groupIds.length ? groupIds.map((groupId) => groupById.get(groupId)!.name).join(" + ") : "Ungrouped",
      conversationIds: [],
    });
    flowGroups.get(id)!.conversationIds.push(conversation.id);
    documentGroups.set(conversation.id, id);
  }
  const bands = new Map<string, GraphFlowBand>();
  const seen = new Set<string>();
  for (const edge of edges) {
    const sourceGroupId = documentGroups.get(edge.sourceId);
    const targetGroupId = documentGroups.get(edge.targetId);
    const edgeKey = JSON.stringify([edge.kind, edge.sourceId, edge.targetId]);
    if (sourceGroupId === undefined || targetGroupId === undefined || edge.sourceId === edge.targetId || seen.has(edgeKey)) continue;
    seen.add(edgeKey);
    const id = JSON.stringify([sourceGroupId, targetGroupId]);
    if (!bands.has(id)) bands.set(id, { id, sourceGroupId, targetGroupId, count: 0, branchCount: 0, linkCount: 0, edges: [] });
    const band = bands.get(id)!;
    band.count += 1;
    if (edge.kind === "branch") band.branchCount += 1;
    else band.linkCount += 1;
    band.edges.push(edge);
  }
  return {
    groups: [...flowGroups.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)),
    bands: [...bands.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    totalCount: seen.size,
  };
}
