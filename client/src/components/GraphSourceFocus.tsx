import { useEffect, useRef } from "react";
import type { GraphEvidenceRef } from "../lib/graphExploration";

/** Keep the existing chat panel as a direct child of the graph's reader. */
export default function GraphSourceFocus({ source, getPanelElement }: {
  source?: GraphEvidenceRef | null;
  getPanelElement: () => HTMLElement | null;
}) {
  const getPanelRef = useRef(getPanelElement);
  getPanelRef.current = getPanelElement;

  useEffect(() => {
    if (!source) return;
    // The panel initializes its saved scroll position during mounting. Reveal
    // the requested source only after that initialization has completed.
    const frame = window.requestAnimationFrame(() => {
      const panel = getPanelRef.current();
      if (!panel) return;
      const target = source.sourceKind === "message"
        ? Array.from(panel.querySelectorAll<HTMLElement>("[data-message-row-id]"))
            .find((element) => element.dataset.messageRowId === source.messageId)
        : panel.querySelector<HTMLElement>(".panel-body");
      if (!target) return;
      if (source.sourceKind === "message") {
        const scroller = target.closest<HTMLElement>(".panel-body");
        if (!scroller || !panel.contains(scroller)) return;
        const targetBounds = target.getBoundingClientRect();
        const scrollerBounds = scroller.getBoundingClientRect();
        const visibleTargetHeight = Math.min(targetBounds.height, scroller.clientHeight);
        const nextScrollTop = scroller.scrollTop + targetBounds.top - scrollerBounds.top -
          scroller.clientTop - (scroller.clientHeight - visibleTargetHeight) / 2;
        // Only move the reader. scrollIntoView also scrolls hidden-overflow
        // ancestors and can clip the surrounding map's navigation controls.
        scroller.scrollTop = Math.max(0, Math.min(nextScrollTop, scroller.scrollHeight - scroller.clientHeight));
        target.focus({ preventScroll: true });
      } else {
        target.scrollTop = 0;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    source?.conversationId,
    source?.sourceKind,
    source?.messageId,
    source?.noteId,
    source?.quote,
    source?.startOffset,
    source?.endOffset,
  ]);

  return null;
}
