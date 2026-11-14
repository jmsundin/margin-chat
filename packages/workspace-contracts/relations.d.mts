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
  hiddenFromAI?: true;
  agentEdit?: "locked" | "open";
  aiInstruction?: string;
  languageLearning?: LanguageLearning;
};
export function extractMarkdownWikiLinks(markdown: string): MarkdownWikiLink[];
export function normalizeConversationGraphFields(input: unknown, conversationId: string, conversations?: Record<string, Conversation>):
  Pick<Conversation, "relations" | "nodeType" | "tags" | "hiddenFromAI" | "agentEdit" | "aiInstruction" | "languageLearning">;
export const HIDE_FROM_AI_KEY: "hide-from-ai";
export const AGENT_EDIT_KEY: "agent-edit";
export type AgentEditPolicy = "non-authored-only" | "locked" | "open";
export const AGENT_EDIT_POLICIES: AgentEditPolicy[];
export function normalizeAgentEditPolicy(value: unknown): "locked" | "open" | null;
export function readAgentEditPolicy(source: string): AgentEditPolicy;
export function isHiddenFromAI(conversation: Pick<Conversation, "hiddenFromAI"> | null | undefined): boolean;
export const AI_INSTRUCTION_KEY: "ai-instruction";
export const AI_INSTRUCTION_MAX_LENGTH: number;
/** A stored instruction as one trimmed line, or null when there's none. */
export function normalizeAIInstruction(value: unknown): string | null;
/** A document's Language learning pair: the language being learned and the one meanings are given in, as language codes like "es" and "en". */
export interface LanguageLearning { target: string; base: string }
export const LEARNING_LANGUAGE_KEY: "learning-language";
export const TRANSLATE_INTO_KEY: "translate-into";
export function normalizeLanguageLearning(value: unknown): LanguageLearning | null;
