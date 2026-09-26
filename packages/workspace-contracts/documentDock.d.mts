import type { Conversation, DocumentDockLayout } from "./types.mjs";

/** Recover a bounded, unique pane tree, pruning missing documents and empty splits. */
export function normalizeDocumentDock(
  input: unknown,
  conversations: Record<string, Pick<Conversation, "id">>,
): DocumentDockLayout | undefined;
