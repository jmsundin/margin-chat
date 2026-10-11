import type { ReactNode } from "react";
import DismissibleDetails from "./DismissibleDetails";

/**
 * Map tips folded into a small button at the bottom left, so the canvas is
 * clear until someone asks how to move around. The tips stay in the DOM while
 * closed, so the map can still point screen readers at them.
 */
export default function MapHelp({ id, className = "", children }: { id?: string; className?: string; children: ReactNode }) {
  return <DismissibleDetails className={`map-help ${className}`.trim()} data-graph-ui="true">
    <summary aria-label="Map tips" title="Map tips">
      <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><circle cx="12" cy="7.6" r=".6" /></svg>
    </summary>
    <div id={id} className="map-help-panel">{children}</div>
  </DismissibleDetails>;
}
