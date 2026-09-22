import type { DocumentLayoutMode } from "./documentMapLayout";
import { curvedGraphConnection } from "./graphConnectionCurve";

type CardBounds = { x: number; y: number; width: number; height: number };

/** Attach connections to the visible card face for each document layout. */
export function documentConnectionGeometry(source: CardBounds, target: CardBounds, mode: DocumentLayoutMode) {
  const sx = source.x + source.width / 2, sy = source.y + source.height / 2;
  const tx = target.x + target.width / 2, ty = target.y + target.height / 2;
  const dx = tx - sx, dy = ty - sy;
  if (mode === "connections") {
    // A zero component imposes no boundary on that axis.
    const from = Math.min(dx ? source.width / 2 / Math.abs(dx) : Infinity, dy ? source.height / 2 / Math.abs(dy) : Infinity);
    const to = Math.min(dx ? target.width / 2 / Math.abs(dx) : Infinity, dy ? target.height / 2 / Math.abs(dy) : Infinity);
    const startX = sx + dx * (Number.isFinite(from) ? from : 0);
    const startY = sy + dy * (Number.isFinite(from) ? from : 0);
    const endX = tx - dx * (Number.isFinite(to) ? to : 0);
    const endY = ty - dy * (Number.isFinite(to) ? to : 0);
    const endpoints = { startX, startY, endX, endY };
    return { ...endpoints, ...curvedGraphConnection(endpoints) };
  }
  const vertical = mode === "tree-down" || (mode === "auto" && Math.abs(dy) / source.height > Math.abs(dx) / source.width);
  if (vertical) {
    const direction = dy >= 0 ? 1 : -1;
    const startX = sx, startY = sy + direction * source.height / 2;
    const endX = tx, endY = ty - direction * target.height / 2;
    const middle = (startY + endY) / 2;
    const endpoints = { startX, startY, endX, endY };
    return startX === endX ? { ...endpoints, ...curvedGraphConnection(endpoints) }
      : { ...endpoints, path: `M ${startX} ${startY} C ${startX} ${middle}, ${endX} ${middle}, ${endX} ${endY}`,
        labelX: (startX + endX) / 2, labelY: middle };
  }
  const direction = dx >= 0 ? 1 : -1;
  const startX = sx + direction * source.width / 2, startY = sy;
  const endX = tx - direction * target.width / 2, endY = ty;
  const middle = (startX + endX) / 2;
  const endpoints = { startX, startY, endX, endY };
  return startY === endY ? { ...endpoints, ...curvedGraphConnection(endpoints) }
    : { ...endpoints, path: `M ${startX} ${startY} C ${middle} ${startY}, ${middle} ${endY}, ${endX} ${endY}`,
      labelX: middle, labelY: (startY + endY) / 2 };
}
