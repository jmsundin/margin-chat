import type { Conversation, ConversationGroup, ThreadCategoryId } from "../types";
import type { JevWorkspaceItem, JevWorkspaceSnapshot } from "./jevAssistance";
import { getCurrentDocumentText } from "./documentSources";
import { getStandaloneNote } from "./standaloneNotes";
import { THREAD_CATEGORY_DEFINITIONS, getThreadCategoryLabel } from "./threadCategories";

export interface JevGroupEvidence {
  groupId: string;
  fingerprint: string;
  item: JevWorkspaceItem;
}

// Ten fixed-size items fit the existing endpoint's 16,000-character allowance.
export const JEV_GROUP_BATCH_SIZE = 10;

function permittedExcerpt(conversation: Conversation) {
  if (conversation.document) return getCurrentDocumentText(conversation).slice(0, 180);
  if (conversation.kind === "note") return (getStandaloneNote(conversation)?.content ?? "").slice(0, 180);
  return conversation.messages.filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-2).map((message) => `${message.role}: ${message.content.slice(-180)}`).join("\n").slice(-180);
}

/** Group semantics use permitted evidence only, never map coordinates or private annotations. */
export function buildJevGroupEvidence(groups: Record<string, ConversationGroup>, conversations: Record<string, Conversation>): JevGroupEvidence[] {
  return Object.values(groups).sort((a, b) => a.id.localeCompare(b.id)).map((group) => {
    const members = [...new Set(group.conversationIds)].sort().flatMap((id) => conversations[id] ? [conversations[id]] : []);
    const titles = members.slice(0, 8).map((member) => member.title.slice(0, 80));
    const excerpts = members.slice(0, 2).map((member) => permittedExcerpt(member));
    const item: JevWorkspaceItem = { id: group.id, title: group.name.slice(0, 200), kind: "note",
      content: `Group: ${group.name.slice(0, 120)}\nMember titles:\n${titles.join("\n")}\nSelected member excerpts:\n${excerpts.join("\n")}`.slice(0, 1400) };
    return { groupId: group.id, item,
      fingerprint: JSON.stringify(["map-group-v1", group.id, group.name, members.map((member) => [member.id, member.title]), item.content]) };
  });
}

export function buildJevGroupSnapshot(evidence: readonly JevGroupEvidence[]): JevWorkspaceSnapshot | null {
  if (!evidence.length) return null;
  const items = evidence.slice(0, JEV_GROUP_BATCH_SIZE).map((entry) => entry.item);
  const { id, title, content } = items[0];
  return { items, current: { id, title, content } };
}

/** Stable within-category order keeps uncategorized groups useful without guessing. */
export function orderJevGroups(groupIds: readonly string[], categories: Record<string, ThreadCategoryId>) {
  const rank = new Map(THREAD_CATEGORY_DEFINITIONS.map((category, index) => [category.id, index]));
  const orderedGroupIds = [...groupIds].sort((a, b) => (rank.get(categories[a]) ?? rank.size) - (rank.get(categories[b]) ?? rank.size));
  const categoryLabels: Record<string, string> = Object.create(null);
  for (const id of groupIds) if (Object.hasOwn(categories, id)) categoryLabels[id] = getThreadCategoryLabel(categories[id]);
  return { orderedGroupIds, categoryLabels };
}
