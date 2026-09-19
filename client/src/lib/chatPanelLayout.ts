/** Keep the active chat and its parent readable together when the canvas has room. */
export function getChatPanelLayout({
  availableWidth,
  preferredWidth,
  hasParent,
  hasSideItems,
  mobile,
}: {
  availableWidth: number;
  preferredWidth: number;
  hasParent: boolean;
  hasSideItems: boolean;
  mobile: boolean;
}) {
  if (availableWidth <= 0) return { width: preferredWidth, maxWidth: 980, fitsPair: false };
  if (mobile) return { width: availableWidth, maxWidth: availableWidth, fitsPair: false };
  const insetAndGap = 80; // Two 24px insets and the 32px lane gap.
  const fitsPair = hasParent && availableWidth >= 800;
  const maximum = fitsPair
    ? (availableWidth - insetAndGap) / 2
    : hasSideItems && !hasParent
      ? Math.max(360, availableWidth - 284 - insetAndGap)
      : Math.max(320, availableWidth - 48);
  return { width: Math.min(preferredWidth, maximum), maxWidth: maximum, fitsPair };
}

/** Resize a divider without squeezing either neighboring chat below its minimum. */
export function resizeChatPanels({ width, companionWidth, delta, maxWidth = 980 }: {
  width: number;
  companionWidth?: number;
  delta: number;
  maxWidth?: number;
}) {
  const total = width + (companionWidth ?? 0);
  const minimum = companionWidth === undefined ? 320 : Math.max(320, total - maxWidth);
  const maximum = companionWidth === undefined ? maxWidth : Math.min(maxWidth, total - 320);
  const nextWidth = Math.max(minimum, Math.min(maximum, width + delta));
  return { width: nextWidth, companionWidth: companionWidth === undefined ? undefined : total - nextWidth };
}
