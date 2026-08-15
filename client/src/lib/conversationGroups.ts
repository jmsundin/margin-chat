import type { Conversation, ConversationGroup } from "../types";

export const CONVERSATION_GROUP_COLORS = [
  "#4fbf9f",
  "#6f88ff",
  "#e9945f",
  "#c87de8",
  "#d7aa3f",
  "#5fa9d8",
] as const;

const GROUP_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export function normalizeConversationGroups(
  input: unknown,
  conversations: Record<string, Conversation>,
): Record<string, ConversationGroup> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const assignedConversationIds = new Set<string>();
  const groups: Record<string, ConversationGroup> = {};

  for (const [groupId, candidate] of Object.entries(input)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }

    const partial = candidate as Partial<ConversationGroup>;
    const name = typeof partial.name === "string" ? partial.name.trim() : "";

    if (!groupId || !name) {
      continue;
    }

    const conversationIds = Array.isArray(partial.conversationIds)
      ? partial.conversationIds.filter((conversationId): conversationId is string => {
          if (
            typeof conversationId !== "string" ||
            !conversations[conversationId] ||
            assignedConversationIds.has(conversationId)
          ) {
            return false;
          }

          assignedConversationIds.add(conversationId);
          return true;
        })
      : [];

    groups[groupId] = {
      collapsed: Boolean(partial.collapsed),
      color:
        typeof partial.color === "string" &&
        GROUP_COLOR_PATTERN.test(partial.color)
          ? partial.color
          : CONVERSATION_GROUP_COLORS[Object.keys(groups).length % CONVERSATION_GROUP_COLORS.length],
      conversationIds,
      id: groupId,
      name,
    };
  }

  return groups;
}

export function getConversationGroupId(
  groups: Record<string, ConversationGroup>,
  conversationId: string,
) {
  return (
    Object.values(groups).find((group) =>
      group.conversationIds.includes(conversationId),
    )?.id ?? null
  );
}

export function assignConversationToGroup(
  groups: Record<string, ConversationGroup>,
  conversationId: string,
  groupId: string | null,
) {
  let changed = false;
  const nextGroups = Object.fromEntries(
    Object.entries(groups).map(([candidateGroupId, group]) => {
      const withoutConversation = group.conversationIds.filter(
        (candidateId) => candidateId !== conversationId,
      );
      const shouldInclude = candidateGroupId === groupId;
      const conversationIds = shouldInclude
        ? [...withoutConversation, conversationId]
        : withoutConversation;

      if (
        conversationIds.length !== group.conversationIds.length ||
        conversationIds.some(
          (candidateId, index) => candidateId !== group.conversationIds[index],
        )
      ) {
        changed = true;
        return [candidateGroupId, { ...group, conversationIds }];
      }

      return [candidateGroupId, group];
    }),
  );

  return changed ? nextGroups : groups;
}

export function removeConversationsFromGroups(
  groups: Record<string, ConversationGroup>,
  conversationIds: Iterable<string>,
) {
  const removedIds = new Set(conversationIds);

  return Object.fromEntries(
    Object.entries(groups).map(([groupId, group]) => [
      groupId,
      {
        ...group,
        conversationIds: group.conversationIds.filter(
          (conversationId) => !removedIds.has(conversationId),
        ),
      },
    ]),
  );
}
