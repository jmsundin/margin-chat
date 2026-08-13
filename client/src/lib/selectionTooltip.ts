const SELECTION_TOOLTIP_GAP_PX = 12;

export function getSelectionTooltipLayout(args: {
  rect: {
    height: number;
    left: number;
    top: number;
    width: number;
  };
  tooltipWidth: number;
  viewportHeight: number;
  viewportMargin: number;
  viewportWidth: number;
}) {
  const halfTooltipWidth = args.tooltipWidth / 2;
  const minimumLeft = halfTooltipWidth + args.viewportMargin;
  const maximumLeft =
    args.viewportWidth - halfTooltipWidth - args.viewportMargin;
  const left =
    minimumLeft > maximumLeft
      ? args.viewportWidth / 2
      : Math.min(
          Math.max(args.rect.left + args.rect.width / 2, minimumLeft),
          maximumLeft,
        );
  const top = Math.max(
    args.rect.top + args.rect.height + SELECTION_TOOLTIP_GAP_PX,
    args.viewportMargin,
  );

  return {
    left,
    maxHeight: Math.max(args.viewportHeight - top - args.viewportMargin, 0),
    top,
  };
}

export function writeSelectedQuoteToClipboard(args: {
  clipboardData: Pick<DataTransfer, "setData"> | null;
  isEditingText: boolean;
  quote: string;
}) {
  if (args.isEditingText || !args.clipboardData) {
    return false;
  }

  args.clipboardData.setData("text/plain", args.quote);
  return true;
}
