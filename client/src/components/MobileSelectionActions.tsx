import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { copySelection, cutSelection, isIOS, pasteIntoSelection, selectAllAround, selectionEditingHost } from "../lib/selectionMenu";
import { useVisualViewport } from "../lib/useVisualViewport";
import { SelectionIcon, type SelectionIconName } from "./SelectionToolbar";
import "./MobileSelectionActions.css";

type SelectionRect = { top: number; left: number; width: number; height: number };

/** Room below a selection for the iOS edit menu and the selection handle. */
const IOS_MENU_CLEARANCE = 72;

type MobileSelectionActionsProps = {
  rect: SelectionRect;
  formRef: RefObject<HTMLFormElement | null>;
  onExplain: () => void;
  /** Left out where rewriting would break the passage, such as a diagram. */
  onRewrite?: () => void;
  onAsk: () => void;
  /** Create a side document or margin note on the passage directly, without AI. */
  onSideDocument: () => void;
  onMarginNote: () => void;
  onLink: () => void;
  onFindRelated: () => void;
  /** Offered only where the passage is in a document block that can carry the mark. */
  onHighlight?: () => void;
  highlighted?: boolean;
  marginNoteLabel?: string;
  /** The passage, copied when the selection is inside a page's own frame, which the app's selection can't see. */
  quote?: string;
  onClose: () => void;
  disabled?: boolean;
};

/**
 * One row of actions beside the native handles, without opening an input: Copy and the
 * everyday actions first, Ask AI near the end, and More for the rest. More also holds the
 * system's Cut / Paste / Select all, which the workspace hides on phones.
 */
export function MobileSelectionActions({ rect, formRef, onExplain, onRewrite, onAsk, onSideDocument, onMarginNote, onLink, onFindRelated, onHighlight, highlighted = false, marginNoteLabel = "Margin note", quote, onClose, disabled = false }: MobileSelectionActionsProps) {
  const viewport = useVisualViewport(true);
  const [selectionRect, setSelectionRect] = useState(rect);
  const [height, setHeight] = useState(64);
  const [editable, setEditable] = useState(() => Boolean(selectionEditingHost()));
  const [copied, setCopied] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useLayoutEffect(() => {
    setSelectionRect(rect);
    setEditable(Boolean(selectionEditingHost()));
    let frame = 0;
    const measure = () => {
      frame = 0;
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed || formRef.current?.contains(selection.anchorNode)) return;
      setEditable(Boolean(selectionEditingHost()));
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
  // iOS can still draw its own Cut / Copy / Paste menu beside the selection, so there the row
  // docks to the bottom of the screen, or the top when the selection is down there.
  const docked = isIOS();
  const nearBottom = selectionRect.top + selectionRect.height + IOS_MENU_CLEARANCE > maximumTop;
  const placement = docked ? (nearBottom ? "top" : "bottom") : hasRoomBelow ? "below" : hasRoomAbove ? "above" : "edge";
  const preferredTop = docked ? (nearBottom ? minimumTop : maximumTop) : hasRoomBelow ? below : hasRoomAbove ? above
    : (selectionRect.top + selectionRect.height / 2 < viewport.top + viewport.height / 2 ? maximumTop : minimumTop);
  const top = Math.max(minimumTop, Math.min(preferredTop, maximumTop));

  const item = (icon: SelectionIconName, label: string, onClick: () => void, options: { ariaLabel?: string; ai?: boolean; disabled?: boolean; pressed?: boolean } = {}) =>
    <button type="button" key={label} className={options.ai ? "is-ai" : undefined} aria-label={options.ariaLabel} aria-pressed={options.pressed}
      disabled={options.disabled} onClick={onClick}><SelectionIcon name={icon} /><span>{label}</span></button>;

  return createPortal(<form ref={formRef} className="mobile-selection-actions" data-testid="branch-composer" data-placement={placement}
    role="group" aria-label="Selected text actions" style={{ top, left, width }}
    onSubmit={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()}>
    <div className="mobile-selection-actions-row">
      {item("copy", copied ? "Copied" : "Copy", () => { void copySelection(quote).then((done) => setCopied(done)); })}
      {onHighlight ? item("highlight", "Highlight", onHighlight, { ariaLabel: highlighted ? "Remove highlight" : "Highlight selected text", pressed: highlighted }) : null}
      {item("note", "Note", onMarginNote, { ariaLabel: marginNoteLabel === "Margin note" ? "Add a margin note" : "Create a side note" })}
      {item("side", "Side doc", onSideDocument, { ariaLabel: "Create a side document from this passage" })}
      {item("link", "Link", onLink, { ariaLabel: "Link selected text to an existing document or block" })}
      {item("ai", "Ask AI", onAsk, { ariaLabel: "Ask AI about this passage", ai: true, disabled })}
      <button type="button" aria-label="More selection actions" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
        <SelectionIcon name="more" /><span>More</span>
      </button>
    </div>
    {moreOpen ? <div className="mobile-selection-actions-more" role="group" aria-label="More selection actions">
      {editable ? item("cut", "Cut", () => { void cutSelection(); }) : null}
      {editable ? item("paste", "Paste", () => { void pasteIntoSelection(); }) : null}
      {item("select", "Select all", () => selectAllAround())}
      {item("find", "Find related", onFindRelated)}
      {item("explain", "Explain", onExplain, { ai: true, disabled })}
      {onRewrite ? item("rewrite", "Rewrite", onRewrite, { ai: true, disabled }) : null}
      <button type="button" aria-label="Dismiss selection actions" onClick={onClose}>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m5 5 8 8M13 5l-8 8" /></svg><span>Close</span>
      </button>
    </div> : null}
  </form>, document.body);
}
