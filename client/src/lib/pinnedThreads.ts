import type { Conversation } from "../types";

export const MAIN_THREAD_DRAG_MIME = "application/x-margin-chat-main-thread";
const MAIN_THREAD_DRAG_FALLBACK_PREFIX = "margin-chat-main-thread:";

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

    const conversation = conversations[value];

    if (!conversation || conversation.parentId !== null) {
      continue;
    }

    seen.add(value);
    pinnedThreadIds.push(value);
  }

  return pinnedThreadIds;
}

export function setMainThreadDragData(
  dataTransfer: DataTransfer,
  threadId: string,
) {
  dataTransfer.effectAllowed = "move";
  dataTransfer.setData(MAIN_THREAD_DRAG_MIME, threadId);
  dataTransfer.setData(
    "text/plain",
    `${MAIN_THREAD_DRAG_FALLBACK_PREFIX}${threadId}`,
  );
}

export function getMainThreadDragData(
  dataTransfer: DataTransfer,
): string | null {
  const typedValue = dataTransfer.getData(MAIN_THREAD_DRAG_MIME).trim();

  if (typedValue) {
    return typedValue;
  }

  const fallbackValue = dataTransfer.getData("text/plain").trim();

  if (!fallbackValue.startsWith(MAIN_THREAD_DRAG_FALLBACK_PREFIX)) {
    return null;
  }

  const threadId = fallbackValue.slice(MAIN_THREAD_DRAG_FALLBACK_PREFIX.length);

  return threadId || null;
}

export function upsertPinnedThreadIdAtIndex(
  pinnedThreadIds: string[],
  threadId: string,
  targetIndex: number,
): string[] {
  const currentIndex = pinnedThreadIds.indexOf(threadId);
  const nextPinnedThreadIds = pinnedThreadIds.filter(
    (currentThreadId) => currentThreadId !== threadId,
  );
  const adjustedIndex =
    currentIndex !== -1 && currentIndex < targetIndex
      ? targetIndex - 1
      : targetIndex;
  const clampedIndex = Math.max(
    0,
    Math.min(adjustedIndex, nextPinnedThreadIds.length),
  );

  nextPinnedThreadIds.splice(clampedIndex, 0, threadId);

  return nextPinnedThreadIds;
}
