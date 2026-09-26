const SELECTION_TOOLTIP_GAP_PX = 12;

export function getSelectionTooltipLayout(args: {
  rect: {
    height: number;
    left: number;
    top: number;
    width: number;
  };
  tooltipHeight: number;
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
  const selectionBottom = args.rect.top + args.rect.height;
  const topBelow = Math.max(
    selectionBottom + SELECTION_TOOLTIP_GAP_PX,
    args.viewportMargin,
  );
  const availableBelow = Math.max(
    args.viewportHeight - topBelow - args.viewportMargin,
    0,
  );
  const availableAbove = Math.max(
    args.rect.top - SELECTION_TOOLTIP_GAP_PX - args.viewportMargin,
    0,
  );
  // A destination picker can be taller than either side of the selection.
  // Keep it on the roomier side rather than clipping it into a tiny strip above.
  const renderAbove = args.tooltipHeight > availableBelow && availableAbove > availableBelow;
  const top = renderAbove
    ? Math.max(
        args.rect.top - SELECTION_TOOLTIP_GAP_PX - args.tooltipHeight,
        args.viewportMargin,
      )
    : topBelow;

  return {
    left,
    maxHeight: renderAbove ? availableAbove : availableBelow,
    placement: renderAbove ? "above" : "below",
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
