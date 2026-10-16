import type { Conversation, WorkspaceSessions } from "./types.mjs";

/** Recover sessions, dropping missing documents and unknown tab or active ids. */
export function normalizeWorkspaceSessions(
  input: unknown,
  conversations: Record<string, Pick<Conversation, "id">>,
): WorkspaceSessions | undefined;
