import { memo, useState, type ReactNode } from "react";
import type { MainViewMode } from "../types";
import "./WorkspaceView.css";

interface WorkspaceViewProps {
  mode: MainViewMode;
  active: boolean;
  children: ReactNode;
}

/** Mount on first use, then preserve editors and canvas state between visits. */
export default memo(function WorkspaceView({ mode, active, children }: WorkspaceViewProps) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  if (!active && !visited) return null;

  return <div className="workspace-view" data-workspace-view={mode} hidden={!active} inert={!active}>
    {children}
  </div>;
// Render the first hidden frame so visibility-dependent work can stop. Later
// background updates wait until activation, when the latest children are used.
}, (previous, next) => !previous.active && !next.active);
