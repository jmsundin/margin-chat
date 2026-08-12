import type { Conversation } from "../types";

export interface ConversationTreeLane {
  conversationIds: string[];
  parentId: string;
  selectedConversationId: string | null;
}

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

export function getBranchNavigation(
  conversations: Record<string, Conversation>,
  conversationId: string,
) {
  const activeConversation = conversations[conversationId];
  const path = getConversationPath(conversations, conversationId);
  const parent = activeConversation?.parentId
    ? conversations[activeConversation.parentId] ?? null
    : null;
  const byCreatedAt = (left: Conversation, right: Conversation) =>
    left.createdAt.localeCompare(right.createdAt);
  const children = (activeConversation?.childIds ?? [])
    .map((childId) => conversations[childId])
    .filter((conversation): conversation is Conversation => Boolean(conversation))
    .sort(byCreatedAt);
  const siblings = (parent?.childIds ?? [])
    .filter((siblingId) => siblingId !== conversationId)
    .map((siblingId) => conversations[siblingId])
    .filter((conversation): conversation is Conversation => Boolean(conversation))
    .sort(byCreatedAt);

  return {
    children,
    parent,
    path,
    siblings,
  };
}

export function getConversationTraversalCandidates(
  conversations: Record<string, Conversation>,
  conversationId: string,
  direction: "left" | "right",
): Conversation[] {
  const activeConversation = conversations[conversationId];

  if (!activeConversation) {
    return [];
  }

  const byCreatedAt = (left: Conversation, right: Conversation) =>
    left.createdAt.localeCompare(right.createdAt);
  const parent = activeConversation.parentId
    ? conversations[activeConversation.parentId] ?? null
    : null;
  const peerGroup = (parent?.childIds ?? [])
    .map((childId) => conversations[childId])
    .filter((conversation): conversation is Conversation => Boolean(conversation))
    .sort(byCreatedAt);
  const activePeerIndex = peerGroup.findIndex(
    (conversation) => conversation.id === conversationId,
  );

  if (direction === "left") {
    const earlierPeers =
      activePeerIndex > 0
        ? peerGroup.slice(0, activePeerIndex).reverse()
        : [];

    return parent ? [...earlierPeers, parent] : earlierPeers;
  }

  const children = activeConversation.childIds
    .map((childId) => conversations[childId])
    .filter((conversation): conversation is Conversation => Boolean(conversation))
    .sort(byCreatedAt);
  const laterPeers =
    activePeerIndex >= 0 ? peerGroup.slice(activePeerIndex + 1) : [];

  return [...children, ...laterPeers];
}

export function getConversationTraversalOrder(
  conversations: Record<string, Conversation>,
  rootId: string,
): Conversation[] {
  const root = conversations[rootId];

  if (!root) {
    return [];
  }

  const ordered: Conversation[] = [];
  const queue = [root];
  const visited = new Set<string>();
  const byCreatedAt = (left: Conversation, right: Conversation) =>
    left.createdAt.localeCompare(right.createdAt);

  while (queue.length) {
    const conversation = queue.shift();

    if (!conversation || visited.has(conversation.id)) {
      continue;
    }

    visited.add(conversation.id);
    ordered.push(conversation);
    queue.push(
      ...conversation.childIds
        .map((childId) => conversations[childId])
        .filter(
          (child): child is Conversation =>
            Boolean(child) && !visited.has(child.id),
        )
        .sort(byCreatedAt),
    );
  }

  return ordered;
}

export function getConversationTreeLanes(
  conversations: Record<string, Conversation>,
  activeConversationId: string,
): ConversationTreeLane[] {
  const activePath = getConversationPath(conversations, activeConversationId);

  return activePath.flatMap((parentConversation, pathIndex) => {
    const selectedConversationId = activePath[pathIndex + 1]?.id ?? null;
    const children = parentConversation.childIds
      .map((childId) => conversations[childId])
      .filter((child): child is Conversation => Boolean(child))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    if (!children.length) {
      return [];
    }

    const orderedChildren = selectedConversationId
      ? [
          ...children.filter((child) => child.id === selectedConversationId),
          ...children.filter((child) => child.id !== selectedConversationId),
        ]
      : children;

    return [
      {
        conversationIds: orderedChildren.map((child) => child.id),
        parentId: parentConversation.id,
        selectedConversationId,
      },
    ];
  });
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
