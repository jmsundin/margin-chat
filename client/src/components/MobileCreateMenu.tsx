import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SelectionIcon } from "./SelectionToolbar";
import "./MobileCreateMenu.css";

/** What a new side document or margin note will point at. */
export type MobileCreateTarget = "selection" | "paragraph" | "document";

type MobileCreateMenuProps = {
  /** The bottom row's slot the + button sits in. */
  slot: HTMLElement;
  /** Called as the menu opens, so the items can say what they will attach to. */
  prepare: () => MobileCreateTarget;
  onNewDocument: () => void;
  onSideDocument: () => void;
  onMarginNote: () => void;
};

const SIDE_HINT: Record<MobileCreateTarget, string> = { selection: "From the selected text", paragraph: "From this paragraph", document: "Beside this document" };
const NOTE_HINT: Record<MobileCreateTarget, string> = { selection: "On the selected text", paragraph: "On this paragraph", document: "On this document" };

/** The phone's + button: a new document in a new tab, a side document or a margin note. */
export function MobileCreateMenu({ slot, prepare, onNewDocument, onSideDocument, onMarginNote }: MobileCreateMenuProps) {
  const [target, setTarget] = useState<MobileCreateTarget | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = target !== null;

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!menuRef.current?.contains(node) && !buttonRef.current?.contains(node)) setTarget(null);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setTarget(null); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);

  const run = (action: () => void) => () => { setTarget(null); action(); };
  const row = slot.parentElement?.getBoundingClientRect();

  return <>
    {createPortal(<button ref={buttonRef} type="button" className="mobile-create-button" aria-label="Create" title="Create"
      aria-haspopup="menu" aria-expanded={open}
      // Keeps the editor's caret and selection, which the side document and margin note use.
      onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()}
      onClick={() => setTarget(open ? null : prepare())}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>, slot)}
    {open && row ? createPortal(<div ref={menuRef} className="mobile-create-menu" role="menu" aria-label="Create"
      style={{ bottom: window.innerHeight - row.top + 10, right: Math.max(8, window.innerWidth - row.right + 20) }}
      onMouseDown={(event) => event.preventDefault()}>
      <button type="button" role="menuitem" onClick={run(onNewDocument)}>
        <svg className="selection-toolbar-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 2.5h6l3 3v8H3z" /><path d="M9 2.5v3h3" />
        </svg><span><strong>New document</strong><small>Opens in a new tab</small></span>
      </button>
      <button type="button" role="menuitem" onClick={run(onSideDocument)}>
        <SelectionIcon name="side" /><span><strong>Side document</strong><small>{SIDE_HINT[target]}</small></span>
      </button>
      <button type="button" role="menuitem" onClick={run(onMarginNote)}>
        <SelectionIcon name="note" /><span><strong>Margin note</strong><small>{NOTE_HINT[target]}</small></span>
      </button>
    </div>, document.body) : null}
  </>;
}
