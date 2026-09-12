import type { ThreadSummary } from "../types";

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
