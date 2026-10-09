import type { Conversation, DocumentRelation, DocumentRelationOrigin, DocumentRelationTypeId } from "./types.mjs";

export interface DocumentRelationTypeDefinition {
  readonly id: DocumentRelationTypeId;
  readonly label: string;
  readonly inverseLabel: string;
  readonly directed: boolean;
}
export interface WikiLink { target: string; blockId?: string; heading?: string; label?: string }
export interface MarkdownWikiLink extends WikiLink { type?: DocumentRelationTypeId; embed: boolean; index: number }

export const DOCUMENT_RELATION_TYPES: readonly DocumentRelationTypeDefinition[];
export const DOCUMENT_RELATION_ORIGINS: readonly DocumentRelationOrigin[];
export const EDGE_META_KEY: "edge-meta";
export const RESERVED_DOCUMENT_TAGS: readonly string[];
export function isDocumentRelationType(value: unknown): value is DocumentRelationTypeId;
export function getDocumentRelationType(id: string): DocumentRelationTypeDefinition | null;
export function documentRelationKey(type: string, target: string): string;
export function parseWikiLink(value: unknown): WikiLink | null;
export function normalizeDocumentTags(input: unknown): string[];
export function normalizeDocumentNodeType(input: unknown): string | undefined;
export function normalizeDocumentRelations(input: unknown, conversationId: string, conversations?: Record<string, Conversation>): DocumentRelation[] | undefined;
export function documentRelationMetadata(relation: DocumentRelation): Record<string, unknown>;
export function readDocumentRelationMetadata(value: unknown): Partial<DocumentRelation>;
export function readDocumentGraphProperties(values: Record<string, unknown>): {
  relationTargets: { type: DocumentRelationTypeId; target: string; targetBlockId?: string }[];
  edgeMeta: Record<string, unknown>;
  nodeType?: string;
  tags: string[];
};
export function extractMarkdownWikiLinks(markdown: string): MarkdownWikiLink[];
export function normalizeConversationGraphFields(input: unknown, conversationId: string, conversations?: Record<string, Conversation>):
  Pick<Conversation, "relations" | "nodeType" | "tags">;
