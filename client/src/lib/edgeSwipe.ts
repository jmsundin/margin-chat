/** Touch gestures that open phone navigation: the sidebar from the left edge, search from the document's top. */
export type EdgeSwipeKind = "open-sidebar" | "close-sidebar" | "pull-search";

/** Wide enough to start inside the iOS and Android system back-gesture zones' margin. */
export const SIDEBAR_EDGE_PX = 32;
export const SEARCH_PULL_TRIGGER_PX = 72;
export const SEARCH_PULL_MAX_PX = 112;
/** Movement before a gesture claims the touch, as native scrolling does. */
export const LOCK_SLOP_PX = 10;
const FLING_PX_PER_MS = 0.45;

/**
 * `atDocumentTop`: the touch is on a document already scrolled to its top. Pulling down there
 * reveals search, as in Mail and Settings; it never starts in the OS's own top-edge swipe zone.
 */
export type EdgeSwipeStart = { x: number; sidebarOpen: boolean; atDocumentTop: boolean };

/** The gestures a touch could become, from where it started. */
export function edgeSwipeCandidates({ x, sidebarOpen, atDocumentTop }: EdgeSwipeStart): EdgeSwipeKind[] {
  if (sidebarOpen) return ["close-sidebar"];
  const kinds: EdgeSwipeKind[] = [];
  if (x <= SIDEBAR_EDGE_PX) kinds.push("open-sidebar");
  if (atDocumentTop) kinds.push("pull-search");
  return kinds;
}

/**
 * Once the finger has moved past the slop, pick the gesture whose direction it follows,
 * or "none" to hand the touch back to scrolling and selection.
 */
export function lockEdgeSwipe(candidates: EdgeSwipeKind[], dx: number, dy: number): EdgeSwipeKind | "none" | "pending" {
  if (Math.hypot(dx, dy) < LOCK_SLOP_PX) return "pending";
  const horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
  const vertical = Math.abs(dy) > Math.abs(dx) * 1.2;
  if (horizontal && dx > 0 && candidates.includes("open-sidebar")) return "open-sidebar";
  if (horizontal && dx < 0 && candidates.includes("close-sidebar")) return "close-sidebar";
  if (vertical && dy > 0 && candidates.includes("pull-search")) return "pull-search";
  return "none";
}

/** Sidebar translateX while dragging: 0 is fully open, -width fully hidden. */
export function sidebarDragOffset(kind: "open-sidebar" | "close-sidebar", dx: number, width: number): number {
  const offset = kind === "open-sidebar" ? dx - width : dx;
  return Math.min(0, Math.max(-width, offset));
}

/** Whether the sidebar should end open, from where and how fast the finger let go. */
export function settleSidebarOpen(offset: number, width: number, velocityX: number): boolean {
  if (velocityX > FLING_PX_PER_MS) return true;
  if (velocityX < -FLING_PX_PER_MS) return false;
  return offset > -width / 2;
}

/** Rubber-banded pull distance, so the hint slows as it nears its limit. */
export function searchPullDistance(dy: number): number {
  if (dy <= 0) return 0;
  return SEARCH_PULL_MAX_PX * (1 - Math.exp(-dy / SEARCH_PULL_MAX_PX));
}

export function searchPullTriggers(dy: number): boolean {
  return dy >= SEARCH_PULL_TRIGGER_PX;
}
