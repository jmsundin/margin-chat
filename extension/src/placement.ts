export interface Box { top: number; left: number; right: number; bottom: number }
export interface Size { width: number; height: number }

export const CARD_PLACEMENT = { width: 400, height: 460, minHeight: 240, gap: 10, edge: 8 } as const;

/**
 * Place the answer card next to a passage without covering it. Prefer below, then
 * above; when neither fits at full height, shrink to the roomier side rather than
 * overlap the quote. Only when there is no usable space above or below does the
 * card move beside the passage, and finally to the corner.
 */
export function placeCard(passage: Box | null, viewport: Size, preferred: Size = CARD_PLACEMENT, options: { gap: number; edge: number; minHeight: number } = CARD_PLACEMENT) {
  const { gap, edge, minHeight } = options;
  const width = Math.min(preferred.width, viewport.width - edge * 2);
  let height = Math.min(preferred.height, viewport.height - edge * 2);
  const corner = { width, height, top: viewport.height - height - edge, left: viewport.width - width - edge };
  if (!passage) return corner;
  const clampLeft = (value: number) => Math.max(edge, Math.min(value, viewport.width - width - edge));
  const below = viewport.height - edge - (passage.bottom + gap);
  const above = passage.top - gap - edge;
  if (below >= height) return { width, height, top: passage.bottom + gap, left: clampLeft(passage.left) };
  if (above >= height) return { width, height, top: passage.top - gap - height, left: clampLeft(passage.left) };
  const roomiest = Math.max(below, above);
  if (roomiest >= minHeight) {
    height = Math.floor(roomiest);
    return { width, height, top: below >= above ? passage.bottom + gap : passage.top - gap - height, left: clampLeft(passage.left) };
  }
  const top = Math.max(edge, Math.min(passage.top, viewport.height - height - edge));
  if (viewport.width - edge - (passage.right + gap) >= width) return { width, height, top, left: passage.right + gap };
  if (passage.left - gap - edge >= width) return { width, height, top, left: passage.left - gap - width };
  return corner;
}
