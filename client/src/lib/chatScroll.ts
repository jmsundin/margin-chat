const SCROLL_DIRECTION_TOLERANCE_PX = 1;
export const JUMP_TO_TOP_MIN_SCROLL_PX = 72;

export function clampChatScrollPosition(
  scrollTop: number,
  maxScrollTop: number,
) {
  return Math.min(Math.max(scrollTop, 0), Math.max(maxScrollTop, 0));
}

export function getJumpToTopVisibility(args: {
  currentScrollTop: number;
  previousScrollTop: number;
  wasVisible: boolean;
}) {
  if (args.currentScrollTop <= JUMP_TO_TOP_MIN_SCROLL_PX) {
    return false;
  }

  if (
    args.currentScrollTop <
    args.previousScrollTop - SCROLL_DIRECTION_TOLERANCE_PX
  ) {
    return true;
  }

  if (
    args.currentScrollTop >
    args.previousScrollTop + SCROLL_DIRECTION_TOLERANCE_PX
  ) {
    return false;
  }

  return args.wasVisible;
}
