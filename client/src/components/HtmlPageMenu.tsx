import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { HtmlPageLayout, HtmlPagePrefs, HtmlPageTheme } from "../lib/htmlPagePrefs";
import "./DocumentModeSwitch.css";

export interface HtmlPageMenuProps {
  title: string;
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

  return <div className="html-page-menu">
    <button ref={trigger} type="button" className="html-page-title" aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? popupId : undefined} aria-label={`${props.title}: page menu`}
      onClick={() => open ? close(true) : setOpen(true)}
      onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}>
      <span className="html-page-title-text">{props.title}</span>
      <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open ? createPortal(<div ref={popup} id={popupId} role="menu" aria-label={`${props.title}: page menu`} tabIndex={-1}
      className="document-mode-menu html-page-menu-popup" style={position} onKeyDown={onMenuKeyDown}>
      {item("Open in new tab", props.onOpenInTab)}
      {item("Download .html", props.onDownload)}
      <button type="button" role="menuitem" onClick={() => { props.onCopySource(); setCopied(true); window.setTimeout(() => setCopied(false), 1_500); }}>
        <span aria-hidden="true" />
        <span className="document-mode-name">{copied ? "Copied" : "Copy source"}</span>
      </button>
      {item("Reload page", props.onReload, "Starts the page again. What it saved is kept.")}
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
  </div>;
}
