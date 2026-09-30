import { useLayoutEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useVisualViewport } from "../lib/useVisualViewport";
import "./MobileSelectionActions.css";

type SelectionRect = { top: number; left: number; width: number; height: number };

type MobileSelectionActionsProps = {
  rect: SelectionRect;
  formRef: RefObject<HTMLFormElement | null>;
  onExplain: () => void;
  onRewrite: () => void;
  onAsk: () => void;
  onMore: () => void;
  onClose: () => void;
  disabled?: boolean;
};

/** Keep selection actions beside the native handles without opening an input. */
export function MobileSelectionActions({ rect, formRef, onExplain, onRewrite, onAsk, onMore, onClose, disabled = false }: MobileSelectionActionsProps) {
  const viewport = useVisualViewport(true);
  const [selectionRect, setSelectionRect] = useState(rect);
  const [height, setHeight] = useState(54);

  useLayoutEffect(() => {
    setSelectionRect(rect);
    let frame = 0;
    const measure = () => {
      frame = 0;
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed || formRef.current?.contains(selection.anchorNode)) return;
      const range = selection.getRangeAt(0);
      if (typeof range.getBoundingClientRect !== "function") return;
      const next = range.getBoundingClientRect();
      if (!next.width && !next.height) return;
      setSelectionRect((current) => current.top === next.top && current.left === next.left && current.width === next.width && current.height === next.height
        ? current : { top: next.top, left: next.left, width: next.width, height: next.height });
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("selectionchange", schedule);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [rect, formRef]);

  useLayoutEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const measure = () => {
      const next = form.getBoundingClientRect().height;
      if (next > 0) setHeight(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(form);
    return () => observer.disconnect();
  }, [formRef]);

  const margin = 12;
  const gap = 16;
  const width = Math.min(380, Math.max(0, viewport.width - margin * 2));
  const minimumLeft = viewport.left + margin;
  const maximumLeft = viewport.left + viewport.width - margin - width;
  const left = Math.max(minimumLeft, Math.min(selectionRect.left + selectionRect.width / 2 - width / 2, maximumLeft));
  const minimumTop = viewport.top + margin;
  const maximumTop = Math.max(minimumTop, viewport.top + viewport.height - margin - height);
  const below = selectionRect.top + selectionRect.height + gap;
  const above = selectionRect.top - gap - height;
  const hasRoomBelow = below <= maximumTop;
  const hasRoomAbove = above >= minimumTop;
  const placement = hasRoomBelow ? "below" : hasRoomAbove ? "above" : "edge";
  const preferredTop = hasRoomBelow ? below : hasRoomAbove ? above
    : (selectionRect.top + selectionRect.height / 2 < viewport.top + viewport.height / 2 ? maximumTop : minimumTop);
  const top = Math.max(minimumTop, Math.min(preferredTop, maximumTop));

  return createPortal(<form ref={formRef} className="mobile-selection-actions" data-testid="branch-composer" data-placement={placement}
    role="group" aria-label="Selected text actions" style={{ top, left, width }}
    onSubmit={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()}>
    <button type="button" className="mobile-selection-actions-pill" disabled={disabled} onClick={onExplain}>Explain</button>
    <button type="button" className="mobile-selection-actions-pill" disabled={disabled} onClick={onRewrite}>Rewrite</button>
    <button type="button" className="mobile-selection-actions-pill" disabled={disabled} onClick={onAsk}>Ask…</button>
    <button type="button" className="mobile-selection-actions-icon" aria-label="More selection actions" title="More selection actions" disabled={disabled} onClick={onMore}>
      <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="16" cy="10" r="1.5" /></svg>
    </button>
    <button type="button" className="mobile-selection-actions-icon" aria-label="Dismiss selection actions" title="Dismiss selection actions" onClick={onClose}>
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m5 5 8 8M13 5l-8 8" /></svg>
    </button>
  </form>, document.body);
}
