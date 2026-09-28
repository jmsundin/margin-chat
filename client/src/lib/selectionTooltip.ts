const SELECTION_TOOLTIP_GAP_PX = 12;

export function isNativeSelectionInteraction(event: Pick<PointerEvent, "pointerType" | "target">, selection: Selection | null) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  // iOS selection handles aren't DOM nodes, so their event target may be outside
  // the selected block. Never remove the native range at the start of a touch.
  if (event.pointerType === "touch") return true;
  const source = (selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement)
    ?.closest("[data-selection-source], [data-message-bubble='true']");
  return Boolean(source && event.target instanceof Node && source.contains(event.target));
}

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
  viewportTop?: number;
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
  const viewportTop = args.viewportTop ?? 0;
  const rectTop = args.rect.top - viewportTop;
  const selectionBottom = rectTop + args.rect.height;
  const topBelow = Math.max(
    selectionBottom + SELECTION_TOOLTIP_GAP_PX,
    args.viewportMargin,
  );
  const availableBelow = Math.max(
    args.viewportHeight - topBelow - args.viewportMargin,
    0,
  );
  const availableAbove = Math.max(
    rectTop - SELECTION_TOOLTIP_GAP_PX - args.viewportMargin,
    0,
  );
  // A destination picker can be taller than either side of the selection.
  // Keep it on the roomier side rather than clipping it into a tiny strip above.
  const renderAbove = args.tooltipHeight > availableBelow && availableAbove > availableBelow;
  const top = renderAbove
    ? Math.max(
        rectTop - SELECTION_TOOLTIP_GAP_PX - args.tooltipHeight,
        args.viewportMargin,
      )
    : topBelow;

  return {
    left,
    maxHeight: renderAbove ? availableAbove : availableBelow,
    placement: renderAbove ? "above" : "below",
    top: top + viewportTop,
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
