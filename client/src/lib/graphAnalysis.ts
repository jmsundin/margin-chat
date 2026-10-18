import type { Conversation } from "../types";
import { getDocumentGraphEdges } from "./documentRelations";

/** `relation` covers typed relations and links written in a document's text. */
export type GraphAnalysisRelationKind = "branch" | "link" | "relation";
export interface GraphAnalysisEdge {
  id: string;
  sourceId: string;
  targetId: string;
  kind: GraphAnalysisRelationKind;
}

/** Parent → child, authored source → target, and typed or written relations. A pair may have several kinds. */
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
  for (const edge of getDocumentGraphEdges(conversations)) add(edge.sourceId, edge.targetId, "relation");
  return [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
}
