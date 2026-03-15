import type { Conversation } from "../types";

export function getConversationPath(
  conversations: Record<string, Conversation>,
  conversationId: string,
): Conversation[] {
  const path: Conversation[] = [];
  const visited = new Set<string>();
  let current: Conversation | undefined = conversations[conversationId];

  while (current && !visited.has(current.id)) {
    path.unshift(current);
    visited.add(current.id);
    current = current.parentId ? conversations[current.parentId] : undefined;
  }

  return path;
}

export function getConversationRootId(
  conversations: Record<string, Conversation>,
  conversationId: string,
): string | null {
  const visited = new Set<string>();
  let current: Conversation | undefined = conversations[conversationId];

  while (current && !visited.has(current.id)) {
    if (current.parentId === null) {
      return current.id;
    }

    visited.add(current.id);
    current = conversations[current.parentId];
  }

  return null;
}

export function getRootConversations(
  conversations: Record<string, Conversation>,
): Conversation[] {
  return Object.values(conversations).filter(
    (conversation) => conversation.parentId === null,
  );
}

export function getConversationDepth(
  conversations: Record<string, Conversation>,
  conversationId: string,
): number {
  let depth = 0;
  let current: Conversation | undefined = conversations[conversationId];

  while (current?.parentId) {
    depth += 1;
    current = conversations[current.parentId];
  }

  return depth;
}

export function getAllBranches(
  conversations: Record<string, Conversation>,
): Conversation[] {
  return Object.values(conversations)
    .filter((conversation) => Boolean(conversation.parentId))
    .sort((left, right) => {
      const depthDelta =
        getConversationDepth(conversations, left.id) -
        getConversationDepth(conversations, right.id);

      if (depthDelta !== 0) {
        return depthDelta;
      }

      return left.createdAt.localeCompare(right.createdAt);
    });
}

export function excerpt(value: string, maxLength = 52): string {
  const compact = value.replace(/\s+/g, " ").trim();

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 1).trimEnd()}...`;
}

export function buildConversationTitle(quote: string, prompt: string): string {
  return excerpt(prompt || quote, 34);
}
