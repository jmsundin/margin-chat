import { useEffect, useRef, useState } from "react";
import "./SelectionToolbar.css";

export type SelectionIconName = "highlight" | "note" | "side" | "link" | "copy" | "cut" | "paste" | "select" | "find" | "explain" | "rewrite" | "ai" | "more";

const ICON_PATHS: Record<Exclude<SelectionIconName, "ai" | "more">, React.ReactNode> = {
  highlight: <><path d="M9.5 2.5l4 4-6 6H3.5v-4z" /><path d="M2 14.5h12" /></>,
  note: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  side: <><path d="M3 2.5h6l3 3v8H3z" /><path d="M9 2.5v3h3" /><path d="M7.5 8v4M5.5 10h4" /></>,
  link: <><path d="M6.8 9.2a2.6 2.6 0 003.7 0l2.2-2.2a2.6 2.6 0 00-3.7-3.7l-.9.9" /><path d="M9.2 6.8a2.6 2.6 0 00-3.7 0L3.3 9a2.6 2.6 0 003.7 3.7l.9-.9" /></>,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" /></>,
  cut: <><circle cx="4.5" cy="11.5" r="2" /><circle cx="11.5" cy="11.5" r="2" /><path d="M6 10L12 2.5M10 10L4 2.5" /></>,
  paste: <><rect x="3" y="3" width="10" height="11" rx="1.5" /><path d="M6 3V2h4v1" /><path d="M6 7.5h4M6 10h3" /></>,
  select: <><path d="M3 4.5h10M3 8h10M3 11.5h6" /><path d="M1.5 3v10" strokeDasharray="1.5 1.5" /></>,
  find: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5l3.5 3.5" /></>,
  explain: <><circle cx="8" cy="8" r="6" /><path d="M6.3 6.3a1.8 1.8 0 113 1.4c-.8.5-1.3.9-1.3 1.8" /><circle cx="8" cy="11.6" r=".5" fill="currentColor" /></>,
  rewrite: <><path d="M2.5 13.5l1-3.5 7-7 2.5 2.5-7 7z" /><path d="M9 4.5l2.5 2.5" /></>,
};

export function SelectionIcon({ name }: { name: SelectionIconName }) {
  return <svg className="selection-toolbar-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {name === "ai" ? <path d="M8 1.8l1.5 4.2 4.2 1.5-4.2 1.5L8 13.2 6.5 9 2.3 7.5 6.5 6z" fill="currentColor" stroke="none" />
      : name === "more" ? <g fill="currentColor" stroke="none"><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></g>
      : ICON_PATHS[name]}
  </svg>;
}

export type SelectionMenuItem = { icon: SelectionIconName; label: string; onSelect: () => void; disabled?: boolean; hint?: string; ai?: boolean };
export type SelectionToolbarAction = SelectionMenuItem & { ariaLabel?: string; pressed?: boolean };

/**
 * The one-row toolbar over selected text: everyday actions first, then a More menu, then Ask AI.
 * Buttons keep the editor's selection and focus, so Copy and Highlight act on what is still selected.
 */
export function SelectionToolbarRow({ actions, more, ask }: {
  actions: SelectionToolbarAction[];
  more: SelectionMenuItem[];
  ask?: SelectionToolbarAction;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: PointerEvent) => { if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setMoreOpen(false); } };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", escape, true); };
  }, [moreOpen]);
  const keep = (event: React.MouseEvent) => event.preventDefault();
  return <div className="selection-toolbar-row" role="toolbar" aria-label="Selected text actions" onMouseDown={keep}>
    {actions.map((action) => <button key={action.label} type="button" className="selection-toolbar-button"
      aria-label={action.ariaLabel ?? action.label} aria-pressed={action.pressed} disabled={action.disabled} title={action.hint}
      onClick={() => { setMoreOpen(false); action.onSelect(); }}>
      <SelectionIcon name={action.icon} /><span>{action.label}</span>
    </button>)}
    {more.length ? <div className="selection-toolbar-more" ref={moreRef}>
      <button type="button" className="selection-toolbar-button is-icon" aria-label="More selection actions" title="More"
        aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}>
        <SelectionIcon name="more" />
      </button>
      {moreOpen ? <div className="selection-toolbar-menu" role="menu">
        {more.map((item) => <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
          className={item.ai ? "is-ai" : undefined} onClick={() => { setMoreOpen(false); item.onSelect(); }}>
          <SelectionIcon name={item.icon} /><span>{item.label}</span>{item.hint ? <kbd>{item.hint}</kbd> : null}
        </button>)}
      </div> : null}
    </div> : null}
    {ask ? <>
      <span className="selection-toolbar-divider" aria-hidden="true" />
      <button type="button" className="selection-toolbar-button is-ai" aria-label={ask.ariaLabel ?? ask.label}
        aria-pressed={ask.pressed} disabled={ask.disabled} onClick={() => { setMoreOpen(false); ask.onSelect(); }}>
        <SelectionIcon name="ai" /><span>{ask.label}</span>
      </button>
    </> : null}
  </div>;
}
