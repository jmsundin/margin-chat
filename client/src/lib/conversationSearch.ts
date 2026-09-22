import type { Conversation, ThreadSummary } from "../types";
import { getStandaloneNote } from "./standaloneNotes";
import { categorizeThread, getThreadCategoryLabel } from "./threadCategories";
import { excerpt, getConversationRootId, getRootConversations } from "./tree";
import { getCurrentDocumentText, getPrimaryDocumentSources } from "./documentSources";

export { buildSearchExploration } from "./searchExploration";
export type {
  SearchDirection, SearchEvidenceRef, SearchExploration, SearchExplorationOptions,
  SearchFacet, SearchFacetKind, SearchPassageResult, SearchPurposeId,
} from "./searchExploration";

export interface ChatSearchResult {
  conversationId: string;
  locationLabel: string;
  matchLabel: string;
  preview: string;
  rootTitle: string;
  title: string;
  updatedLabel: string;
}

function groupConversationsByRoot(conversations: Record<string, Conversation>) {
  const threads = new Map<string, Conversation[]>();

  for (const conversation of Object.values(conversations)) {
    const rootId = getConversationRootId(conversations, conversation.id);

    if (!rootId) {
      continue;
    }

    const thread = threads.get(rootId) ?? [];
    thread.push(conversation);
    threads.set(rootId, thread);
  }

  for (const thread of threads.values()) {
    thread.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  return threads;
}

function getThreadPreviewFromConversations(
  threadConversations: Conversation[],
) {
  for (const conversation of threadConversations) {
    if (conversation.document) {
      const content = getCurrentDocumentText(conversation);
      if (content.trim()) return excerpt(content, 92);
      continue;
    }
    const latestMessage =
      conversation.messages[conversation.messages.length - 1];

    if (latestMessage?.content.trim()) {
      return excerpt(latestMessage.content, 92);
    }
  }

  return "No messages yet.";
}

function getThreadCategoryContext(threadConversations: Conversation[]) {
  const snippets: string[] = [];
  let remainingCharacters = 2200;

  for (const conversation of threadConversations) {
    if (remainingCharacters <= 0) {
      break;
    }

    const titleSnippet = conversation.title.replace(/\s+/g, " ").trim();

    if (titleSnippet) {
      const nextSnippet = titleSnippet.slice(0, remainingCharacters);
      snippets.push(nextSnippet);
      remainingCharacters -= nextSnippet.length + 1;
    }

    for (const message of (conversation.document ? getPrimaryDocumentSources(conversation) : conversation.messages).slice(-3).reverse()) {
      if (remainingCharacters <= 0) {
        break;
      }

      const contentSnippet = message.content.replace(/\s+/g, " ").trim();

      if (!contentSnippet) {
        continue;
      }

      const nextSnippet = `${message.role} ${contentSnippet}`.slice(
        0,
        remainingCharacters,
      );
      snippets.push(nextSnippet);
      remainingCharacters -= nextSnippet.length + 1;
    }
  }

  return snippets.join(" ");
}

function getThreadPreview(
  conversations: Record<string, Conversation>,
  rootConversationId: string,
) {
  const rootConversation = conversations[rootConversationId];

  if (!rootConversation) {
    return "No messages yet.";
  }

  return getThreadPreviewFromConversations([rootConversation]);
}

function formatRelativeTime(value: string) {
  const elapsedMs = Date.now() - new Date(value).getTime();
  const elapsedMinutes = Math.max(0, Math.round(elapsedMs / 60000));

  if (elapsedMinutes < 1) {
    return "just now";
  }

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.round(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.round(elapsedHours / 24);

  if (elapsedDays < 7) {
    return `${elapsedDays}d ago`;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function getMatchPreview(content: string, query: string) {
  const normalizedContent = content.replace(/\s+/g, " ").trim();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedContent) {
    return "";
  }

  const matchIndex = normalizedContent.toLowerCase().indexOf(normalizedQuery);

  if (matchIndex === -1) {
    return excerpt(normalizedContent, 108);
  }

  const startIndex = Math.max(0, matchIndex - 42);
  const endIndex = Math.min(
    normalizedContent.length,
    matchIndex + normalizedQuery.length + 52,
  );
  const prefix = startIndex > 0 ? "..." : "";
  const suffix = endIndex < normalizedContent.length ? "..." : "";

  return `${prefix}${normalizedContent.slice(startIndex, endIndex)}${suffix}`;
}

export function buildThreadSummaries(
  conversations: Record<string, Conversation>,
): ThreadSummary[] {
  const threads = groupConversationsByRoot(conversations);

  return getRootConversations(conversations)
    .map((rootConversation) => {
      const threadConversations = threads.get(rootConversation.id) ?? [];
      const latestConversation = threadConversations[0] ?? rootConversation;
      const standaloneNote = getStandaloneNote(rootConversation);
      const preview = standaloneNote
        ? excerpt(rootConversation.document ? getCurrentDocumentText(rootConversation) : standaloneNote.content, 108) || "Empty note"
        : getThreadPreviewFromConversations(threadConversations);
      const categoryId = categorizeThread({
        context: getThreadCategoryContext(threadConversations),
        preview,
        title: rootConversation.title,
      });

      return {
        categoryId,
        categoryLabel: getThreadCategoryLabel(categoryId),
        conversationCount: threadConversations.length,
        id: rootConversation.id,
        kind: standaloneNote ? ("note" as const) : ("chat" as const),
        preview,
        title: rootConversation.title,
        updatedAt: latestConversation.updatedAt,
        updatedLabel: formatRelativeTime(latestConversation.updatedAt),
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function buildSearchResults(
  conversations: Record<string, Conversation>,
  query: string,
  recentThreads?: ThreadSummary[],
): ChatSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return (recentThreads ?? buildThreadSummaries(conversations)).map(
      (thread) => ({
        conversationId: thread.id,
        locationLabel: thread.title,
        matchLabel: thread.kind === "note" ? "Recent note" : "Recent chat",
        preview: thread.preview,
        rootTitle: thread.title,
        title: thread.title,
        updatedLabel: thread.updatedLabel,
      }),
    );
  }

  return Object.values(conversations)
    .map((conversation) => {
      const rootId = getConversationRootId(conversations, conversation.id);

      if (!rootId) {
        return null;
      }

      const rootConversation = conversations[rootId];

      if (!rootConversation) {
        return null;
      }

      const lowerTitle = conversation.title.toLowerCase();

      if (lowerTitle.includes(normalizedQuery)) {
        const isStandaloneNote = conversation.kind === "note";
        return {
          conversationId: conversation.id,
          locationLabel: isStandaloneNote
            ? "Standalone note"
            : conversation.parentId === null
              ? "Main chat"
              : "Branch conversation",
          matchLabel: isStandaloneNote
            ? "Note title"
            : conversation.parentId === null
              ? "Thread title"
              : "Branch title",
          preview: conversation.parentId
            ? `Inside "${rootConversation.title}"`
            : getThreadPreview(conversations, rootConversation.id),
          rootTitle: rootConversation.title,
          title: conversation.title,
          updatedAt: conversation.updatedAt,
          updatedLabel: formatRelativeTime(conversation.updatedAt),
        };
      }

      const matchingMessage = (conversation.document ? getPrimaryDocumentSources(conversation).map((source) => ({ ...source, createdAt: source.updatedAt })) : conversation.messages).find((message) =>
        message.content.toLowerCase().includes(normalizedQuery),
      );

      const matchingNote = (conversation.notes ?? []).find((note) =>
        (!conversation.document || note.kind !== "standalone") && note.content.toLowerCase().includes(normalizedQuery),
      );

      if (!matchingMessage && !matchingNote) {
        return null;
      }

      if (matchingNote) {
        return {
          conversationId: conversation.id,
          locationLabel:
            conversation.kind === "note"
              ? "Standalone note"
              : conversation.parentId === null
                ? "Main chat"
                : "Branch conversation",
          matchLabel:
            conversation.kind === "note" ? "Note content" : "Margin note",
          preview: getMatchPreview(matchingNote.content, normalizedQuery),
          rootTitle: rootConversation.title,
          title: conversation.title,
          updatedAt: matchingNote.updatedAt,
          updatedLabel: formatRelativeTime(matchingNote.updatedAt),
        };
      }

      if (!matchingMessage) {
        return null;
      }

      return {
        conversationId: conversation.id,
        locationLabel:
          conversation.parentId === null ? "Main chat" : "Branch conversation",
        matchLabel: conversation.document ? "Document passage" : `${matchingMessage.role} message`,
        preview: getMatchPreview(matchingMessage.content, normalizedQuery),
        rootTitle: rootConversation.title,
        title: conversation.title,
        updatedAt: matchingMessage.createdAt,
        updatedLabel: formatRelativeTime(matchingMessage.createdAt),
      };
    })
    .filter(
      (
        result,
      ): result is ChatSearchResult & {
        updatedAt: string;
      } => Boolean(result),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 40)
    .map(({ updatedAt: _updatedAt, ...result }) => result);
}
