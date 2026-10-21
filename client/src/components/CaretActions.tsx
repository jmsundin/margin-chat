import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getSelectionTooltipLayout } from "../lib/selectionTooltip";
import { useVisualViewport } from "../lib/useVisualViewport";
import type { DocumentCaretMenu } from "./DocumentPanel";
import { SelectionIcon, SelectionToolbarRow, type SelectionIconName } from "./SelectionToolbar";
import "./MobileSelectionActions.css";

type CaretActionsProps = {
  menu: DocumentCaretMenu;
  mobile: boolean;
  /** Note, side document and link act on the paragraph around the caret. */
  onNote: () => void;
  onSideDocument: () => void;
  onLink: () => void;
  onFindRelated: () => void;
  onClose: () => void;
  marginNoteLabel?: string;
};

const VIEWPORT_MARGIN = 12;

/**
 * The selection toolbar's twin for when nothing is selected: the same row at the caret, with
 * Paste and Select in place of Copy and Highlight. Note, Side doc and Link use the paragraph.
 */
export function CaretActions({ menu, mobile, onNote, onSideDocument, onLink, onFindRelated, onClose, marginNoteLabel = "Margin note" }: CaretActionsProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [moreOpen, setMoreOpen] = useState(false);
  const viewport = useVisualViewport(true);
  const paragraph = Boolean(menu.paragraph);
  const run = (action: () => void) => () => { onClose(); action(); };

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSize((current) => current.width === element.offsetWidth && current.height === element.offsetHeight
      ? current : { width: element.offsetWidth, height: element.offsetHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mobile]);

  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    // Typing goes on writing at the caret; the menu steps aside.
    const key = (event: KeyboardEvent) => {
      if (ref.current?.contains(event.target as Node)) { if (event.key === "Escape") onClose(); return; }
      onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  if (!mobile) {
    const layout = getSelectionTooltipLayout({ rect: menu.rect, tooltipWidth: size.width, tooltipHeight: size.height,
      viewportHeight: viewport.height, viewportTop: viewport.top, viewportMargin: VIEWPORT_MARGIN, viewportWidth: window.innerWidth });
    return createPortal(<div ref={ref} className="selection-tooltip is-toolbar caret-actions" data-testid="caret-actions"
      style={{ left: layout.left, top: layout.top, maxHeight: layout.maxHeight }}>
      <SelectionToolbarRow
        label="Actions at the cursor"
        actions={[
          { icon: "paste", label: "Paste", ariaLabel: "Paste at the cursor", onSelect: run(menu.paste) },
          ...(paragraph ? [
            { icon: "note" as const, label: "Note", ariaLabel: marginNoteLabel === "Margin note" ? "Add a margin note to this paragraph" : "Create a side note on this paragraph", onSelect: run(onNote) },
            { icon: "side" as const, label: "Side doc", ariaLabel: "Create a side document from this paragraph", onSelect: run(onSideDocument) },
            { icon: "link" as const, label: "Link", ariaLabel: "Link this paragraph to an existing document or block", onSelect: run(onLink) },
          ] : []),
        ]}
        more={[
          { icon: "select", label: "Select paragraph", onSelect: run(menu.selectParagraph) },
          ...(paragraph ? [{ icon: "find" as const, label: "Find related", onSelect: run(onFindRelated) }] : []),
        ]}
        ask={{ icon: "ai", label: "Ask AI", ariaLabel: "Ask AI here", onSelect: run(menu.askAI) }}
      />
    </div>, document.body);
  }

  const width = Math.min(380, Math.max(0, viewport.width - VIEWPORT_MARGIN * 2));
  const height = size.height || 64;
  const below = menu.rect.top + menu.rect.height + 16;
  const maximumTop = viewport.top + viewport.height - VIEWPORT_MARGIN - height;
  const top = Math.max(viewport.top + VIEWPORT_MARGIN, below <= maximumTop ? below : menu.rect.top - 16 - height);
  const left = viewport.left + Math.max(VIEWPORT_MARGIN, Math.min(menu.rect.left - width / 2, viewport.width - VIEWPORT_MARGIN - width));
  const item = (icon: SelectionIconName, label: string, onClick: () => void, options: { ariaLabel?: string; ai?: boolean } = {}) =>
    <button type="button" key={label} className={options.ai ? "is-ai" : undefined} aria-label={options.ariaLabel} onClick={onClick}>
      <SelectionIcon name={icon} /><span>{label}</span>
    </button>;
  return createPortal(<div ref={ref} className="mobile-selection-actions caret-actions" data-testid="caret-actions" role="group" aria-label="Actions at the cursor"
    style={{ top, left, width }} onMouseDown={(event) => event.preventDefault()}>
    <div className="mobile-selection-actions-row">
      {item("paste", "Paste", run(menu.paste), { ariaLabel: "Paste at the cursor" })}
      {item("select", "Select", run(menu.selectParagraph), { ariaLabel: "Select paragraph" })}
      {paragraph ? item("note", "Note", run(onNote), { ariaLabel: marginNoteLabel === "Margin note" ? "Add a margin note to this paragraph" : "Create a side note on this paragraph" }) : null}
      {paragraph ? item("side", "Side doc", run(onSideDocument), { ariaLabel: "Create a side document from this paragraph" }) : null}
      {paragraph ? item("link", "Link", run(onLink), { ariaLabel: "Link this paragraph to an existing document or block" }) : null}
      {item("ai", "Ask AI", run(menu.askAI), { ariaLabel: "Ask AI here", ai: true })}
      <button type="button" aria-label="More actions at the cursor" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
        <SelectionIcon name="more" /><span>More</span>
      </button>
    </div>
    {moreOpen ? <div className="mobile-selection-actions-more" role="group" aria-label="More actions at the cursor">
      {paragraph ? item("find", "Find related", run(onFindRelated)) : null}
      <button type="button" aria-label="Dismiss actions" onClick={onClose}>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m5 5 8 8M13 5l-8 8" /></svg><span>Close</span>
      </button>
    </div> : null}
  </div>, document.body);
}
