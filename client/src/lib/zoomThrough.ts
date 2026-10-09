import type { GraphViewport } from "./graphInteractions";

/**
 * Zooming through a map card into its document, and pinching back out.
 *
 * Zooming in over a card that shows the document grows it until it fills the
 * screen, then holds it there. Zooming further eases it to the center and
 * builds up "travel"; enough travel opens the document. A pause starts over,
 * so an ordinary zoom never opens anything by accident.
 */

/** A card filling this share of the viewport's width or height is full screen. */
export const ZOOM_THROUGH_FILL = 0.9;
/** Zooming this much further past full screen opens the document. */
export const ZOOM_THROUGH_TRAVEL = 1.8;
/** A pause this long between zoom steps starts the travel over. */
export const ZOOM_THROUGH_IDLE_MS = 700;
/** Share of the distance to the center a held card moves per zoom step. */
const ZOOM_THROUGH_GLIDE = 0.35;

/** A card's bounds in map coordinates. */
export type ZoomThroughCard = { id: string; x: number; y: number; width: number; height: number };
export type ZoomThroughState = { id: string; travel: number; at: number } | null;

/** The scale at which the card fills the screen, capped at the map's maximum. */
export function getFullScreenScale(card: ZoomThroughCard, size: { width: number; height: number }, maxScale: number) {
  return Math.min(maxScale, ZOOM_THROUGH_FILL / Math.max(card.width / Math.max(1, size.width), card.height / Math.max(1, size.height)));
}

/** 0 to 1, for showing how close the zoom is to opening the document. */
export function getZoomThroughProgress(travel: number) {
  return Math.min(1, Math.max(0, Math.log(travel) / Math.log(ZOOM_THROUGH_TRAVEL)));
}

function zoomAround(current: GraphViewport, scale: number, point: { x: number; y: number }): GraphViewport {
  const worldX = (point.x - current.x) / current.scale;
  const worldY = (point.y - current.y) / current.scale;
  return { scale, x: point.x - worldX * scale, y: point.y - worldY * scale };
}

/**
 * One zoom-in step toward `requestedScale` around `point` (viewport pixels)
 * while `card` is under it.
 */
export function zoomThroughStep({ current, requestedScale, point, card, size, maxScale, state, now }: {
  current: GraphViewport;
  requestedScale: number;
  point: { x: number; y: number };
  card: ZoomThroughCard;
  size: { width: number; height: number };
  maxScale: number;
  state: ZoomThroughState;
  now: number;
}): { viewport: GraphViewport; state: ZoomThroughState; open: boolean } {
  const fullScreen = getFullScreenScale(card, size, maxScale);
  if (requestedScale <= fullScreen) {
    return { viewport: zoomAround(current, requestedScale, point), state: null, open: false };
  }
  const held = current.scale >= fullScreen * 0.999;
  const extra = requestedScale / (held ? current.scale : fullScreen);
  const anchored = held ? current : zoomAround(current, fullScreen, point);
  const centerX = size.width / 2 - (card.x + card.width / 2) * fullScreen;
  const centerY = size.height / 2 - (card.y + card.height / 2) * fullScreen;
  const viewport = {
    scale: fullScreen,
    x: anchored.x + (centerX - anchored.x) * ZOOM_THROUGH_GLIDE,
    y: anchored.y + (centerY - anchored.y) * ZOOM_THROUGH_GLIDE,
  };
  const previous = state && state.id === card.id && now - state.at < ZOOM_THROUGH_IDLE_MS ? state.travel : 1;
  const travel = previous * extra;
  const open = travel >= ZOOM_THROUGH_TRAVEL;
  return { viewport, state: open ? null : { id: card.id, travel, at: now }, open };
}

/**
 * One pinch-out step in a document that was opened from the map. Returns the
 * new travel, or `null` once it is far enough to go back to the map.
 */
export function pinchOutStep(state: { travel: number; at: number } | null, zoomFactor: number, now: number) {
  const previous = state && now - state.at < ZOOM_THROUGH_IDLE_MS ? state.travel : 1;
  const travel = previous / Math.min(1, zoomFactor);
  return travel >= ZOOM_THROUGH_TRAVEL ? null : { travel, at: now };
}
