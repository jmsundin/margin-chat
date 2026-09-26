import type { Conversation, DocumentLayout } from "./types.mjs";

/** Retain family members in their supplied order and clamp saved widths; malformed optional layouts are omitted. */
export function normalizeDocumentLayout(
  input: unknown,
  rootId: string,
  conversations: Record<string, Pick<Conversation, "parentId">>,
): DocumentLayout | undefined;
