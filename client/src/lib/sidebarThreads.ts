import type { ThreadSummary } from "../types";

/** Editing or pinning an older document does not move it above newer documents. */
export function sortDocumentsByCreation(threads: ThreadSummary[]) {
  const timestamp = (thread: ThreadSummary) => Date.parse(thread.createdAt ?? thread.updatedAt) || 0;
  return [...threads].sort((left, right) => timestamp(right) - timestamp(left));
}

export function sortThreadsByRecentActivity(threads: ThreadSummary[]) {
  return [...threads].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export function getSidebarThreadDropAction(args: {
  isPinned: boolean;
  targetGroupId?: string | null;
  targetPinned?: boolean;
}) {
  if (args.targetPinned) {
    return {
      assignGroup: false,
      groupId: null,
      pin: !args.isPinned,
      unpin: false,
    };
  }

  return {
    assignGroup: true,
    groupId: args.targetGroupId ?? null,
    pin: false,
    unpin: args.isPinned,
  };
}
