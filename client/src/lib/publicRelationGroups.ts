import type { PublicRelation } from "./publicKnowledge";
import { AI_ANSWER_PROPERTY } from "./publicGraphScene";

const RELATION_GROUPS: Record<string, string> = {
  "wikipedia-broader": "Broader topics", "wikipedia-lead": "Key topics", "wikipedia-main": "", "wikipedia-section": "", "wikipedia-see-also": "See also", [AI_ANSWER_PROPERTY]: "From members’ answers",
};

/** Connections as a hierarchy: broader topics, the lead's key topics, each article section, then the rest. */
export function groupRelations(selectedId: string, relations: PublicRelation[]) {
  const groups = new Map<string, PublicRelation[]>();
  for (const relation of relations) {
    const outbound = relation.sourceId === selectedId;
    const named = RELATION_GROUPS[relation.propertyId];
    const label = !outbound ? "Links here" : named === undefined ? "" : named || relation.label;
    groups.set(label, [...groups.get(label) ?? [], relation]);
  }
  const order = (label: string) => label === "Broader topics" ? 0 : label === "Key topics" ? 1 : label === "See also" ? 3 : label === "Links here" ? 5 : label === "" ? 4 : label === "From members’ answers" ? 3.5 : 2;
  return [...groups.entries()].map(([label, items]) => ({ label, relations: items })).sort((a, b) => order(a.label) - order(b.label));
}

