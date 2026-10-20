/** Phone touch gestures: the sidebar from the left edge, and a cloud sync pulled down from the top of the page. */
export type EdgeSwipeKind = "open-sidebar" | "close-sidebar" | "pull-sync";

/** Wide enough to start inside the iOS and Android system back-gesture zones' margin. */
export const SIDEBAR_EDGE_PX = 32;
export const SYNC_PULL_TRIGGER_PX = 72;
export const SYNC_PULL_MAX_PX = 112;
/** Movement before a gesture claims the touch, as native scrolling does. */
export const LOCK_SLOP_PX = 10;
const FLING_PX_PER_MS = 0.45;

/**
 * `canPullSync`: the touch is on the document or the open sidebar, already scrolled to its top, and the
 * vault syncs to the cloud. Pulling down there syncs, as pull to refresh does in Mail; it never starts in
 * the OS's own top-edge swipe zone.
 */
export type EdgeSwipeStart = { x: number; sidebarOpen: boolean; canPullSync: boolean };

/** The gestures a touch could become, from where it started. */
export function edgeSwipeCandidates({ x, sidebarOpen, canPullSync }: EdgeSwipeStart): EdgeSwipeKind[] {
  const kinds: EdgeSwipeKind[] = [];
  if (sidebarOpen) kinds.push("close-sidebar");
  else if (x <= SIDEBAR_EDGE_PX) kinds.push("open-sidebar");
  if (canPullSync) kinds.push("pull-sync");
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
  if (vertical && dy > 0 && candidates.includes("pull-sync")) return "pull-sync";
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
export function syncPullDistance(dy: number): number {
  if (dy <= 0) return 0;
  return SYNC_PULL_MAX_PX * (1 - Math.exp(-dy / SYNC_PULL_MAX_PX));
}

export function syncPullTriggers(dy: number): boolean {
  return dy >= SYNC_PULL_TRIGGER_PX;
}
