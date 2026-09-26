import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { MainViewMode } from "../types";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import "./WorkspaceModeMenu.css";

export interface WorkspaceModeMenuProps {
  mainViewMode: MainViewMode;
  onSetMainViewMode: (mode: MainViewMode) => void;
}

const modes: Array<{ mode: MainViewMode; label: string }> = [
  { mode: "chat", label: "Document" },
  { mode: "tiles", label: "Tiles" },
  { mode: "graph", label: "Map" },
];

function ModeIcon({ mode }: { mode: MainViewMode }) {
  return <svg className="workspace-mode-icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {mode === "chat" ? <><path d="M11.5 2.5H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z"/><path d="M11 2.5V7h5M7 10h6M7 13h6"/></>
      : mode === "tiles" ? <><rect x="3" y="3" width="5.5" height="5.5" rx=".7"/><rect x="11.5" y="3" width="5.5" height="5.5" rx=".7"/><rect x="3" y="11.5" width="5.5" height="5.5" rx=".7"/><rect x="11.5" y="11.5" width="5.5" height="5.5" rx=".7"/></>
        : <><path d="m5.5 6 8.5-1M5.5 7l3.5 7m5-8-4 8"/><circle cx="4" cy="5" r="2"/><circle cx="16" cy="4" r="2"/><circle cx="10" cy="16" r="2"/></>}
  </svg>;
}

export default function WorkspaceModeMenu({ mainViewMode, onSetMainViewMode }: WorkspaceModeMenuProps) {
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<"active" | "first" | "last">("active");
  const previousMode = useRef(mainViewMode);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const currentMode = modes.find(({ mode }) => mode === mainViewMode)!;

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }

  useOutsideDismiss(open, () => close(), popup, trigger);

  useEffect(() => {
    if (previousMode.current === mainViewMode) return;
    previousMode.current = mainViewMode;
    close(Boolean(popup.current?.contains(document.activeElement)));
  }, [mainViewMode]);

  useLayoutEffect(() => {
    if (!open) return;
    function placePopup() {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const width = popup.current?.offsetWidth || 184;
      const height = popup.current?.offsetHeight || 126;
      const below = bounds.bottom + 6;
      setPosition({
        left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(below + height <= window.innerHeight - 8 ? below : bounds.top - height - 6, window.innerHeight - height - 8)),
      });
    }
    placePopup();
    const items = popup.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    const selected = popup.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (initialFocus.current === "active" ? selected : items?.[initialFocus.current === "last" ? items.length - 1 : 0])?.focus();
    initialFocus.current = "active";
    window.addEventListener("resize", placePopup);
    window.addEventListener("scroll", placePopup, true);
    return () => {
      window.removeEventListener("resize", placePopup);
      window.removeEventListener("scroll", placePopup, true);
    };
  }, [open]);

  function handleMenuKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") { close(true); return; }
    const items = [...(popup.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (index + 1) % items.length
        : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  }

  return <div className="workspace-mode-control" onBlur={(event) => {
    const next = event.relatedTarget as Node | null;
    if (next && !popup.current?.contains(next) && !trigger.current?.contains(next)) close();
  }}>
    <button ref={trigger} type="button" className="workspace-mode-trigger"
      aria-label={`Workspace mode: ${currentMode.label}`} title={`Workspace mode: ${currentMode.label}`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => open ? close(true) : setOpen(true)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        initialFocus.current = event.key === "ArrowUp" ? "last" : "first";
        setOpen(true);
      }}>
      <ModeIcon mode={mainViewMode} />
      <span className="workspace-mode-label">{currentMode.label}</span>
      <svg className="workspace-mode-chevron" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="m3 4.5 3 3 3-3"/></svg>
    </button>
    {open ? createPortal(<div ref={popup} id={menuId} role="menu" tabIndex={-1} aria-label="Workspace mode"
      className="workspace-mode-menu" style={position} onKeyDown={handleMenuKeyDown}>
      {modes.map(({ mode, label }) => <button key={mode} type="button" role="menuitemradio"
        aria-checked={mainViewMode === mode} onClick={() => { close(true); onSetMainViewMode(mode); }}>
        <ModeIcon mode={mode} /><span>{label}</span>
        <svg className="workspace-mode-check" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{mainViewMode === mode ? <path d="m3 8 3 3 7-7"/> : null}</svg>
      </button>)}
    </div>, document.body) : null}
  </div>;
}
