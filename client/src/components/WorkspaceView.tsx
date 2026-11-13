import { memo, useState, type CSSProperties, type ReactNode } from "react";
import type { MainViewMode } from "../types";
import "./WorkspaceView.css";

interface WorkspaceViewProps {
  mode: MainViewMode;
  active: boolean;
  children: ReactNode;
  /** Float over the document as a modal instead of filling the workspace. */
  modal?: { label: string; style?: CSSProperties; /** Beside or under the document: a region you work alongside, not a dialog. */ docked?: boolean; /** Too narrow for its toolbars. */ narrow?: boolean };
}

/** Mount on first use, then preserve editors and canvas state between visits. */
export default memo(function WorkspaceView({ mode, active, children, modal }: WorkspaceViewProps) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  if (!active && !visited) return null;

  return <div className={`workspace-view${modal ? " is-modal" : ""}${modal?.docked ? " is-docked" : ""}${modal?.narrow ? " is-narrow" : ""}`} data-workspace-view={mode} hidden={!active} inert={!active}
    role={modal ? modal.docked ? "region" : "dialog" : undefined} aria-modal={modal && !modal.docked ? true : undefined}
    aria-label={modal?.label} style={modal?.style}>
    {children}
  </div>;
// Render the first hidden frame so visibility-dependent work can stop. Later
// background updates wait until activation, when the latest children are used.
}, (previous, next) => !previous.active && !next.active);
