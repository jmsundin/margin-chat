/** A gentle cubic bow with unchanged endpoints and a label on its midpoint. */
export function curvedGraphConnection({ startX, startY, endX, endY }: {
  startX: number; startY: number; endX: number; endY: number;
}) {
  const dx = endX - startX, dy = endY - startY;
  const length = Math.hypot(dx, dy);
  const bow = Math.min(48, length * 0.12);
  const offsetX = length ? -dy / length * bow : 0;
  const offsetY = length ? dx / length * bow : 0;
  const control1X = startX + dx / 3 + offsetX;
  const control1Y = startY + dy / 3 + offsetY;
  const control2X = startX + dx * 2 / 3 + offsetX;
  const control2Y = startY + dy * 2 / 3 + offsetY;
  return {
    path: `M ${startX} ${startY} C ${control1X} ${control1Y}, ${control2X} ${control2Y}, ${endX} ${endY}`,
    labelX: (startX + control1X * 3 + control2X * 3 + endX) / 8,
    labelY: (startY + control1Y * 3 + control2Y * 3 + endY) / 8,
  };
}
