import type { Conversation, PublicTopicSource } from "./types.mjs";

export function normalizePublicTopicId(input: unknown): string | null;
export function normalizePublicTopicSource(input: unknown): PublicTopicSource | undefined;
export function normalizeLinkedConversationIds(
  input: unknown,
  conversationId: string,
  conversations?: Record<string, Conversation>,
): string[] | undefined;
