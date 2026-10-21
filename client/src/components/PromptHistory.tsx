import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";

export interface PromptHistoryProps {
  count: number;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** Phones show the history as a modal; computers show it as a drop-down under the icon. */
  modal: boolean;
  children: ReactNode;
}

/** One icon per document for every AI prompt in it, instead of an icon beside each response. */
export default function PromptHistory({ count, open, onToggle, onClose, modal, children }: PromptHistoryProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const close = useRef(onClose);
  close.current = onClose;
  useOutsideDismiss(open, onClose, panel, trigger);

  useEffect(() => {
    if (!open) return;
    function place() {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds || modal) return;
      // The drop-down ends where the view switch ends, so it stays over the document.
      const right = trigger.current?.parentElement?.getBoundingClientRect().right ?? bounds.right;
      const width = Math.min(400, window.innerWidth - 16);
      setPosition({ top: bounds.bottom + 6, left: Math.max(8, Math.min(right - width, window.innerWidth - width - 8)) });
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // A model picker opened from the history closes first.
      if ([...document.querySelectorAll('[aria-modal="true"]')].some((element) => !panel.current?.contains(element))) return;
      event.preventDefault();
      close.current();
      trigger.current?.focus();
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open, modal]);

  const label = `Prompt history: ${count} AI ${count === 1 ? "prompt" : "prompts"}`;
  return <>
    <button ref={trigger} type="button" className="document-prompt-icon" aria-label={label} title="Prompt history"
      aria-haspopup="dialog" aria-expanded={open} onMouseDown={(event) => event.preventDefault()} onClick={onToggle}>
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="m10 2 2.2 5.8L18 10l-5.8 2.2L10 18l-2.2-5.8L2 10l5.8-2.2Z"/></svg>
      <span aria-hidden="true">{count}</span>
    </button>
    {open ? createPortal(modal
      ? <div className="document-prompt-history-backdrop">
        <section ref={panel} className="document-prompt-history is-modal" role="dialog" aria-modal="true" aria-label="Prompt history">{children}</section>
      </div>
      : <section ref={panel} className="document-prompt-history is-dropdown" role="dialog" aria-label="Prompt history" style={{ top: position.top, left: position.left, maxHeight: `calc(100dvh - ${Math.round(position.top) + 12}px)` }}>{children}</section>,
    document.body) : null}
  </>;
}
