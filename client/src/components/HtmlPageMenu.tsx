import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { HtmlPageLayout, HtmlPagePrefs, HtmlPageTheme } from "../lib/htmlPagePrefs";
import "./DocumentModeSwitch.css";

/** Play's actions on a page: notes and AI that see what the page shows now. */
export interface HtmlPlayActions {
  /** False when the page is hidden from AI. */
  ai: boolean;
  askOpen: boolean;
  questionCount: number;
  onNote: () => void;
  onAsk: () => void;
  onHint: () => void;
  onQuestions: () => void;
}

export interface HtmlPageMenuProps {
  title: string;
  /** In the document's header the menu is named for what it does; over a full screen page it carries the page's title. */
  place: "header" | "bar";
  play?: HtmlPlayActions;
  /** The page or its notes, when the page fills the panel and the notes are a second view. */
  view?: "page" | "notes";
  onView?: (view: "page" | "notes") => void;
  full: boolean;
  onFull: (full: boolean) => void;
  prefs: HtmlPagePrefs;
  /** Phones always fill, so the layout choice isn't offered there. */
  layoutFixed?: boolean;
  onPrefs: (prefs: HtmlPagePrefs) => void;
  onOpenInTab: () => void;
  onDownload: () => void;
  onCopySource: () => void;
  onReload: () => void;
  onResetData: () => void;
}

const THEMES: Array<[HtmlPageTheme, string]> = [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]];
const LAYOUTS: Array<[HtmlPageLayout, string]> = [["fill", "Fill"], ["inline", "Inline"]];

/** The page's title and, under it, everything that can be done to the page: one menu, so the bar stays small. */
export default function HtmlPageMenu(props: HtmlPageMenuProps) {
  const popupId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const [copied, setCopied] = useState(false);

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const width = popup.current?.offsetWidth || 260;
      const height = popup.current?.offsetHeight || 300;
      const below = bounds.bottom + 6;
      setPosition({
        left: Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8)),
        top: Math.max(8, below + height <= window.innerHeight - 8 ? below : window.innerHeight - height - 8),
      });
    }
    place();
    popup.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    // A click inside the page never reaches this window; the window losing focus to the frame does.
    const blurred = () => setOpen(false);
    window.addEventListener("resize", place);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", blurred);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("pointerdown", outside, true); window.removeEventListener("blur", blurred); };
  }, [open]);

  function onMenuKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") { close(); return; }
    const items = [...(popup.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length
      : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  }

  const item = (label: string, run: () => void, hint?: string) => <button type="button" role="menuitem" onClick={() => { close(true); run(); }}>
    <span aria-hidden="true" />
    <span className="document-mode-name">{label}</span>
    {hint ? <span className="document-mode-hint">{hint}</span> : null}
  </button>;

  const { play, view, onView } = props;
  const label = props.place === "bar" ? props.title : play ? "Play" : "Page";
  return <div className={`html-page-controls is-${props.place}`}>
    {view === "notes" && onView ? <button type="button" className="html-page-back" onClick={() => onView("page")}>Back to page</button> : null}
    <div className="html-page-menu">
    <button ref={trigger} type="button" className="html-page-title" aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? popupId : undefined} aria-label={`${props.title}: ${play ? "Play and page menu" : "page menu"}`}
      onClick={() => open ? close(true) : setOpen(true)}
      onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}>
      <span className="html-page-title-text">{label}</span>
      <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open ? createPortal(<div ref={popup} id={popupId} role="menu" aria-label={`${props.title}: page menu`} tabIndex={-1}
      className="document-mode-menu html-page-menu-popup" style={position} onKeyDown={onMenuKeyDown}>
      {play ? <>
        {item("Note this moment", play.onNote)}
        {play.ai ? item("Hint", play.onHint) : null}
        {item(play.questionCount ? `Questions (${play.questionCount})` : "Questions", play.onQuestions)}
        <div className="document-mode-heading" aria-hidden="true">Page</div>
      </> : null}
      {view && onView ? <div className="html-page-choice" role="group" aria-label="Show">
        {(["page", "notes"] as const).map((value) => <button key={value} type="button" role="menuitemradio" aria-checked={view === value}
          onClick={() => { close(true); onView(value); }}>{value === "page" ? "Page" : "Notes"}</button>)}
      </div> : null}
      {props.full || !props.layoutFixed ? null : item("Full screen", () => props.onFull(true))}
      {item("Open in new tab", props.onOpenInTab)}
      {item("Download .html", props.onDownload)}
      <button type="button" role="menuitem" onClick={() => { props.onCopySource(); setCopied(true); window.setTimeout(() => setCopied(false), 1_500); }}>
        <span aria-hidden="true" />
        <span className="document-mode-name">{copied ? "Copied" : "Copy source"}</span>
      </button>
      {item("Reload page", props.onReload)}
      {item("Reset saved data…", props.onResetData, "Clears what the page saved, such as game progress.")}
      <div className="document-mode-heading" aria-hidden="true">Theme</div>
      <div className="html-page-choice" role="group" aria-label="Theme">
        {THEMES.map(([value, label]) => <button key={value} type="button" role="menuitemradio" aria-checked={props.prefs.theme === value}
          onClick={() => props.onPrefs({ ...props.prefs, theme: value })}>{label}</button>)}
      </div>
      {props.layoutFixed ? null : <>
        <div className="document-mode-heading" aria-hidden="true">Layout</div>
        <div className="html-page-choice" role="group" aria-label="Layout">
          {LAYOUTS.map(([value, label]) => <button key={value} type="button" role="menuitemradio" aria-checked={props.prefs.layout === value}
            onClick={() => props.onPrefs({ ...props.prefs, layout: value })}>{label}</button>)}
        </div>
      </>}
    </div>, document.body) : null}
    </div>
    {play?.ai ? <button type="button" className="html-page-ask" aria-expanded={play.askOpen} aria-label="Ask AI about what's on screen" title="Ask AI about what's on screen" onClick={play.onAsk}>
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="currentColor"><path d="M10 2.5l1.6 4.4a2 2 0 0 0 1.2 1.2l4.4 1.6-4.4 1.6a2 2 0 0 0-1.2 1.2L10 16.9l-1.6-4.4a2 2 0 0 0-1.2-1.2L2.8 9.7l4.4-1.6a2 2 0 0 0 1.2-1.2z" /></svg>
      <span>Ask AI</span>
    </button> : null}
    <button type="button" className="document-full-screen-button html-page-full-screen" aria-keyshortcuts="Escape"
      aria-label={`${props.full ? "Leave full screen" : "Full screen"}: ${props.title}`} title={props.full ? "Leave full screen (Esc)" : "Full screen (Esc to leave)"} onClick={() => props.onFull(!props.full)}>
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d={props.full ? "M8 3v5H3M12 3v5h5M8 17v-5H3M12 17v-5h5" : "M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5"} /></svg>
    </button>
  </div>;
}
