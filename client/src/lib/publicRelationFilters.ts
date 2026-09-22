import type { PublicRelation } from "./publicKnowledge";

export type PublicRelationFilter = "all" | "types" | "parts" | "other";

export interface PublicRelationFilters {
  relation: PublicRelationFilter;
  includeMetadata: boolean;
}

export const DEFAULT_PUBLIC_RELATION_FILTERS: PublicRelationFilters = {
  relation: "all", includeMetadata: false,
};

// Classify properties by their Wikidata IDs, never by translated topic labels.
// These link Wikimedia's own categories, portals, templates and project lists.
const METADATA_PROPERTIES = new Set([
  "P301", // category's main topic
  "P910", // topic's main category
  "P971", // category combines topics
  "P1151", // topic's main Wikimedia portal
  "P1204", // Wikimedia portal's main topic
  "P1423", // template has topic
  "P1424", // topic has template
  "P1753", // list related to category
  "P1754", // category related to list
  "P2667", // corresponding template
  "P4329", // template or module that populates category
  "P5008", // on focus list of Wikimedia project
  "P6186", // category for eponymous categories
  "P7084", // related category
]);

export function isPublicMetadataProperty(propertyId: string): boolean {
  return METADATA_PROPERTIES.has(propertyId);
}

export function isPublicMetadataRelation(relation: Pick<PublicRelation, "propertyId">): boolean {
  return isPublicMetadataProperty(relation.propertyId);
}

export function publicRelationType(relation: Pick<PublicRelation, "propertyId">): Exclude<PublicRelationFilter, "all"> {
  if (relation.propertyId === "P31" || relation.propertyId === "P279") return "types";
  if (relation.propertyId === "P361" || relation.propertyId === "P527") return "parts";
  return "other";
}

export function matchesPublicRelationFilter(
  relation: Pick<PublicRelation, "propertyId">,
  filters: PublicRelationFilters = DEFAULT_PUBLIC_RELATION_FILTERS,
): boolean {
  if (isPublicMetadataRelation(relation) && !filters.includeMetadata) return false;
  return filters.relation === "all" || publicRelationType(relation) === filters.relation;
}
