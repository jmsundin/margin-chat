import type { RoadmapStatus } from "../types";

export const ROADMAP_STATUSES: RoadmapStatus[] = ["not-started", "learning", "done", "skipped"];
/** Tapping a node's status mark steps through the common path; Skipped is in the detail pane. */
export const NEXT_ROADMAP_STATUS: Record<RoadmapStatus, RoadmapStatus> = { "not-started": "learning", learning: "done", done: "not-started", skipped: "not-started" };

export default function RoadmapStatusMark({ status }: { status: RoadmapStatus }) {
  return <svg viewBox="0 0 16 16" aria-hidden="true" className={`roadmap-status-mark is-${status}`}>
    <circle cx="8" cy="8" r="6.5" />
    {status === "learning" ? <path d="M8 1.5a6.5 6.5 0 0 1 0 13Z" className="roadmap-status-fill" /> : null}
    {status === "done" ? <path d="m5 8.2 2 2 4-4.4" /> : null}
    {status === "skipped" ? <path d="M4.5 8h7" /> : null}
  </svg>;
}
