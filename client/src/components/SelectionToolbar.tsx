import { useEffect, useRef, useState } from "react";
import "./SelectionToolbar.css";

export type SelectionIconName = "highlight" | "note" | "side" | "link" | "copy" | "cut" | "paste" | "select" | "find" | "explain" | "rewrite" | "question" | "visualize" | "ai" | "more";

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
  question: <><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /><path d="M6.6 5.6a1.5 1.5 0 112.3 1.2c-.6.4-.9.7-.9 1.3" /><circle cx="8" cy="9.4" r=".45" fill="currentColor" /></>,
  visualize: <><rect x="2" y="2.5" width="4.5" height="3.5" rx="1" /><rect x="9.5" y="10" width="4.5" height="3.5" rx="1" /><path d="M4.25 6v2.5a1.5 1.5 0 001.5 1.5H9.5" /><circle cx="11.75" cy="4.25" r="1.75" /></>,
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
 * The one-row toolbar over selected text, or at the caret: everyday actions first, then a More menu, then Ask AI.
 * Buttons keep the editor's selection and focus, so Copy and Highlight act on what is still selected.
 */
export function SelectionToolbarRow({ actions, more, ask, aiActions = [], label = "Selected text actions" }: {
  label?: string;
  actions: SelectionToolbarAction[];
  more: SelectionMenuItem[];
  ask?: SelectionToolbarAction;
  /** AI actions that act at once (Question this), shown beside Ask AI. */
  aiActions?: SelectionToolbarAction[];
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
  return <div className="selection-toolbar-row" role="toolbar" aria-label={label} onMouseDown={keep}>
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
    {ask || aiActions.length ? <span className="selection-toolbar-divider" aria-hidden="true" /> : null}
    {aiActions.map((action) => <button key={action.label} type="button" className="selection-toolbar-button is-ai"
      aria-label={action.ariaLabel ?? action.label} disabled={action.disabled} title={action.hint}
      onClick={() => { setMoreOpen(false); action.onSelect(); }}>
      <SelectionIcon name={action.icon} /><span>{action.label}</span>
    </button>)}
    {ask ? <>
      <button type="button" className="selection-toolbar-button is-ai" aria-label={ask.ariaLabel ?? ask.label}
        aria-pressed={ask.pressed} disabled={ask.disabled} onClick={() => { setMoreOpen(false); ask.onSelect(); }}>
        <SelectionIcon name="ai" /><span>{ask.label}</span>
      </button>
    </> : null}
  </div>;
}

export type SelectionFormatButton = { format: string; label: string; glyph: React.ReactNode; pressed?: boolean };

const FORMAT_GROUPS: { format: string; label: string; glyph: React.ReactNode }[][] = [
  [
    { format: "text", label: "Text", glyph: "T" },
    { format: "h1", label: "Heading 1", glyph: <>H<sub>1</sub></> },
    { format: "h2", label: "Heading 2", glyph: <>H<sub>2</sub></> },
    { format: "h3", label: "Heading 3", glyph: <>H<sub>3</sub></> },
    { format: "quote", label: "Quote", glyph: <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 3v10M6.5 4.5h7M6.5 8h7M6.5 11.5h5" /></svg> },
    { format: "bullets", label: "Bulleted list", glyph: <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="3" cy="4.5" r=".9" fill="currentColor" stroke="none" /><circle cx="3" cy="8" r=".9" fill="currentColor" stroke="none" /><circle cx="3" cy="11.5" r=".9" fill="currentColor" stroke="none" /><path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5" /></svg> },
    { format: "numbers", label: "Numbered list", glyph: <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2.3 3.2l1-.6v3.2M2.2 9.4a1 1 0 011.7.6c0 .7-1.8 1.6-1.8 1.9h1.9" /><path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7" /></svg> },
  ],
  [
    { format: "bold", label: "Bold", glyph: <b>B</b> },
    { format: "italic", label: "Italic", glyph: <i>I</i> },
    { format: "strike", label: "Strikethrough", glyph: <s>S</s> },
    { format: "code", label: "Code", glyph: <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" /></svg> },
  ],
];

/**
 * The row of text formats over the selection toolbar: paragraph styles, lists and quote, then bold,
 * italic, strikethrough and code. Each writes Markdown into the text and toggles off when pressed again.
 */
export function SelectionFormatRow({ pressed, onFormat }: { pressed: (format: string) => boolean; onFormat: (format: string) => void }) {
  return <div className="selection-format-row" role="toolbar" aria-label="Format selected text" onMouseDown={(event) => event.preventDefault()}>
    {FORMAT_GROUPS.map((group, index) => <div key={index} className="selection-format-group">
      {group.map((item) => {
        const on = pressed(item.format);
        return <button key={item.format} type="button" className="selection-format-button" aria-label={item.label} title={item.label}
          aria-pressed={on} onClick={() => onFormat(item.format)}>{item.glyph}</button>;
      })}
    </div>)}
  </div>;
}
