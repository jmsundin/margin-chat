import { useState } from "react";
import "./RoadmapTiles.css";

/** One roadmap as a tile: its name, how far along it is, and what comes next. */
export interface RoadmapTile {
  id: string;
  name: string;
  finished: number;
  total: number;
  stages: number;
  nextUp: string | null;
  /** The roadmap this one was dived into from. */
  parentName?: string;
  drafting?: boolean;
}

/**
 * Tile view's Roadmaps tab: every roadmap as a tile, like a course catalogue's front page.
 * A tile opens its roadmap in Learn beside its document; the first tile starts a new one.
 */
export default function RoadmapTiles({ roadmaps, onOpen, onDraft }: {
  roadmaps: RoadmapTile[];
  onOpen(id: string): void;
  /** AI drafts a roadmap from a goal or a link; returns why it couldn't start, or null. */
  onDraft(goal: string): string | null;
}) {
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const top = roadmaps.filter((roadmap) => !roadmap.parentName);
  const deeper = roadmaps.filter((roadmap) => roadmap.parentName);
  const tile = (roadmap: RoadmapTile) => {
    const percent = roadmap.total ? Math.round((roadmap.finished / roadmap.total) * 100) : 0;
    return <li key={roadmap.id}>
      <button type="button" className="roadmap-tile" onClick={() => onOpen(roadmap.id)}
        aria-label={`${roadmap.name}: ${roadmap.finished} of ${roadmap.total} lessons done. Open the roadmap`}>
        {roadmap.parentName ? <span className="roadmap-tile-parent">In {roadmap.parentName}</span> : null}
        <strong>{roadmap.name}</strong>
        <span className="roadmap-tile-meta">{roadmap.drafting ? "AI is drafting…"
          : `${roadmap.stages} ${roadmap.stages === 1 ? "stage" : "stages"} · ${roadmap.total} ${roadmap.total === 1 ? "lesson" : "lessons"}`}</span>
        <span className="roadmap-tile-meter" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
        <span className="roadmap-tile-next">{roadmap.total && roadmap.finished === roadmap.total ? "All done" : roadmap.nextUp ? `Next: ${roadmap.nextUp}` : roadmap.total ? "" : "No lessons yet"}</span>
      </button>
    </li>;
  };
  return <section className="roadmap-tiles" aria-label="Roadmaps">
    <ul className="roadmap-tile-grid">
      <li>
        <form className="roadmap-tile is-new" onSubmit={(event) => {
          event.preventDefault();
          const reason = onDraft(goal);
          if (reason) { setError(reason); return; }
          setGoal(""); setError(null);
        }}>
          <strong>New roadmap</strong>
          <label htmlFor="roadmap-tile-goal">What do you want to learn? A goal, or a link to a roadmap or article.</label>
          <input id="roadmap-tile-goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Lower my ApoB, or https://roadmap.sh/…" />
          {error ? <p role="alert">{error}</p> : null}
          <button type="submit" disabled={!goal.trim()}>✦ Draft with AI</button>
        </form>
      </li>
      {top.map(tile)}
    </ul>
    {deeper.length ? <>
      <h3 className="roadmap-tiles-heading">Deeper roadmaps <span>{deeper.length}</span></h3>
      <ul className="roadmap-tile-grid">{deeper.map(tile)}</ul>
    </> : null}
    {!roadmaps.length ? <p className="roadmap-tiles-empty">A roadmap is a course through your notes: stages to take in order, and lessons in each. Start one above, or from any document's ⋯ menu.</p> : null}
  </section>;
}
