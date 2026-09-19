import type { AppState, ThreadCategoryId } from "../types";
import type { JevGroupSuggestions } from "./jevAssistance";
import { CONVERSATION_GROUP_COLORS } from "./conversationGroups";
import { getStandaloneNote } from "./standaloneNotes";
import { THREAD_CATEGORY_DEFINITIONS } from "./threadCategories";

/** Persist accepted Jev judgments while preserving every existing or manual placement. */
export function applyJevGroupSuggestions(
  state: AppState,
  categories: Record<string, ThreadCategoryId>,
  suggestions: JevGroupSuggestions,
): AppState {
  const assignedIds = new Set(Object.values(state.groups).flatMap((group) => group.conversationIds));
  let groups = state.groups;
  let conversations = state.conversations;

  for (const id of new Set([...Object.keys(categories), ...Object.keys(suggestions)])) {
    const conversation = Object.hasOwn(state.conversations, id) ? state.conversations[id] : undefined;
    if (!conversation || conversation.grouping === "manual" || assignedIds.has(id)) continue;
    const hasContent = conversation.kind === "note"
      ? Boolean(getStandaloneNote(conversation)?.content.trim())
      : conversation.messages.some((message) => (message.role === "user" || message.role === "assistant") && message.content.trim());
    if (!hasContent) continue;

    const suggestion = Object.hasOwn(suggestions, id) ? suggestions[id] : undefined;
    let groupId = suggestion && Number.isFinite(suggestion.confidence) && suggestion.confidence >= 0.75 && suggestion.confidence <= 1
      && Object.hasOwn(groups, suggestion.groupId) ? suggestion.groupId : undefined;
    if (!groupId) {
      const category = THREAD_CATEGORY_DEFINITIONS.find((candidate) => Object.hasOwn(categories, id) && candidate.id === categories[id]);
      if (!category) continue;
      groupId = Object.values(groups).find((group) => group.name.trim().toLowerCase() === category.label.toLowerCase())?.id;
      if (!groupId) {
        const base = `jev-category-${category.id}`;
        groupId = base;
        for (let suffix = 2; Object.hasOwn(groups, groupId); suffix++) groupId = `${base}-${suffix}`;
        const color = CONVERSATION_GROUP_COLORS[THREAD_CATEGORY_DEFINITIONS.indexOf(category) % CONVERSATION_GROUP_COLORS.length];
        groups = { ...groups, [groupId]: { id: groupId, name: category.label, color, collapsed: false, conversationIds: [] } };
      }
    }
    const group = groups[groupId];
    groups = { ...groups, [groupId]: { ...group, conversationIds: [...group.conversationIds, id] } };
    conversations = { ...conversations, [id]: { ...conversation, grouping: "automatic" } };
    assignedIds.add(id);
  }

  return groups === state.groups ? state : { ...state, groups, conversations };
}
