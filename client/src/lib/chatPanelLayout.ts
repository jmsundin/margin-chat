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

/** Resize one document within its bounds; neighboring documents keep their widths. */
export function resizeChatPanel({ width, delta, maxWidth = 980 }: {
  width: number;
  delta: number;
  maxWidth?: number;
}) {
  return { width: Math.max(320, Math.min(maxWidth, width + delta)) };
}
