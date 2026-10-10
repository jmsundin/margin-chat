import type { KeyboardEvent } from "react";
import type { MainViewMode } from "../types";
import { ariaShortcut, shortcutLabel, workspaceViews } from "../lib/workspaceViewShortcuts";
import "./WorkspaceModeToggle.css";

export interface WorkspaceModeToggleProps {
  mainViewMode: MainViewMode;
  onSetMainViewMode: (mode: MainViewMode) => void;
}

function ModeIcon({ mode }: { mode: MainViewMode }) {
  return <svg className="workspace-mode-icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {mode === "chat" ? <><path d="M11.5 2.5H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z"/><path d="M11 2.5V7h5M7 10h6M7 13h6"/></>
      : mode === "tiles" ? <><rect x="3" y="3" width="5.5" height="5.5" rx=".7"/><rect x="11.5" y="3" width="5.5" height="5.5" rx=".7"/><rect x="3" y="11.5" width="5.5" height="5.5" rx=".7"/><rect x="11.5" y="11.5" width="5.5" height="5.5" rx=".7"/></>
        : <><path d="m5.5 6 8.5-1M5.5 7l3.5 7m5-8-4 8"/><circle cx="4" cy="5" r="2"/><circle cx="16" cy="4" r="2"/><circle cx="10" cy="16" r="2"/></>}
  </svg>;
}

/** Three icon buttons for Document, Tile and Map, as one radio group. */
export default function WorkspaceModeToggle({ mainViewMode, onSetMainViewMode }: WorkspaceModeToggleProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = workspaceViews.findIndex(({ mode }) => mode === mainViewMode);
    const last = workspaceViews.length - 1;
    const next = event.key === "Home" ? 0 : event.key === "End" ? last
      : event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % workspaceViews.length
        : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index - 1 + workspaceViews.length) % workspaceViews.length : -1;
    if (next < 0) return;
    event.preventDefault();
    onSetMainViewMode(workspaceViews[next].mode);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  return <div className="workspace-mode-control" role="radiogroup" aria-label="Workspace view" onKeyDown={handleKeyDown}>
    {workspaceViews.map((view) => {
      const active = view.mode === mainViewMode;
      return <button key={view.mode} type="button" role="radio" aria-checked={active} tabIndex={active ? 0 : -1}
        className="workspace-mode-option" aria-label={view.label} aria-keyshortcuts={ariaShortcut(view)}
        title={`${view.label} (${shortcutLabel(view)})`} onClick={() => onSetMainViewMode(view.mode)}>
        <ModeIcon mode={view.mode} />
      </button>;
    })}
  </div>;
}
