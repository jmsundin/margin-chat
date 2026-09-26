import type { Conversation } from "../types";

export function sanitizePinnedThreadIds(
  input: unknown,
  conversations: Record<string, Conversation>,
): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set<string>();
  const pinnedThreadIds: string[] = [];

  for (const value of input) {
    if (typeof value !== "string" || seen.has(value)) {
      continue;
    }

    if (!Object.hasOwn(conversations, value) || !conversations[value]) {
      continue;
    }

    seen.add(value);
    pinnedThreadIds.push(value);
  }

  return pinnedThreadIds;
}
