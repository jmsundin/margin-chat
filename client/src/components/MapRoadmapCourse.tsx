import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { MapPath, MapPathStep, MapPathSummary } from "../lib/mapPaths";
import { stageDocumentId } from "../lib/roadmapStageDocument";
import type { Conversation } from "../types";
import "./MapRoadmapCourse.css";

/** Where everything sits in the course: stage boxes on a spine, lessons beside them. */
export interface CourseLayout {
  width: number;
  height: number;
  /** One side, lessons stacked under their stage, when the pane is narrow. */
  narrow: boolean;
  stages: { id: string; number: number; title: string; done: number; total: number; x: number; y: number; width: number; height: number }[];
  lessons: { step: MapPathStep; stageId: string; x: number; y: number; width: number; height: number; side: -1 | 1 }[];
  /** Spine segments between stages, and a line from each stage to each of its lessons. */
  spine: { y1: number; y2: number; x: number }[];
}

const STAGE_H = 44, LESSON_H = 40, ROW_GAP = 10, STAGE_GAP = 36, TOP = 40, SIDE_GAP = 30;

/**
 * The roadmap as a course: stages run down one spine in the order to take them, and each stage's
 * lessons branch off to its left and right (one side, stacked, on a narrow pane).
 */
export function layoutCourse(path: MapPath, width: number): CourseLayout {
  const stages: { id: string; title: string; steps: MapPathStep[] }[] = [];
  for (const step of path.steps) {
    const last = stages.at(-1);
    if (last?.id === step.stageId) last.steps.push(step); else stages.push({ id: step.stageId, title: step.stageTitle, steps: [step] });
  }
  const pad = 16;
  const narrow = width < 560;
  const layout: CourseLayout = { width, height: 0, narrow, stages: [], lessons: [], spine: [] };
  let y = TOP;
  let previousBottom: number | null = null;
  if (narrow) {
    const stageW = width - pad * 2, spineX = pad + 14;
    stages.forEach((stage, index) => {
      if (previousBottom !== null) layout.spine.push({ x: spineX, y1: previousBottom, y2: y });
      layout.stages.push({ id: stage.id, number: index + 1, title: stage.title, done: stage.steps.filter(finished).length, total: stage.steps.length, x: pad, y, width: stageW, height: STAGE_H });
      let ly = y + STAGE_H + ROW_GAP;
      for (const step of stage.steps) {
        layout.lessons.push({ step, stageId: stage.id, x: pad + 34, y: ly, width: stageW - 34, height: LESSON_H, side: 1 });
        ly += LESSON_H + ROW_GAP;
      }
      previousBottom = ly - ROW_GAP;
      y = ly - ROW_GAP + STAGE_GAP;
    });
  } else {
    const stageW = Math.min(250, Math.max(170, width * 0.3));
    const lessonW = Math.min(220, (width - pad * 2 - stageW - SIDE_GAP * 2) / 2);
    const spineX = width / 2;
    stages.forEach((stage, index) => {
      const left = stage.steps.filter((_, at) => at % 2 === 0), right = stage.steps.filter((_, at) => at % 2 === 1);
      const rows = Math.max(left.length, right.length, 1);
      const blockH = Math.max(STAGE_H, rows * LESSON_H + (rows - 1) * ROW_GAP);
      const stageY = y + (blockH - STAGE_H) / 2;
      if (previousBottom !== null) layout.spine.push({ x: spineX, y1: previousBottom, y2: stageY });
      layout.stages.push({ id: stage.id, number: index + 1, title: stage.title, done: stage.steps.filter(finished).length, total: stage.steps.length, x: spineX - stageW / 2, y: stageY, width: stageW, height: STAGE_H });
      const place = (steps: MapPathStep[], side: -1 | 1) => steps.forEach((step, at) => {
        const x = side < 0 ? spineX - stageW / 2 - SIDE_GAP - lessonW : spineX + stageW / 2 + SIDE_GAP;
        layout.lessons.push({ step, stageId: stage.id, x, y: y + at * (LESSON_H + ROW_GAP) + (blockH - (steps.length * LESSON_H + (steps.length - 1) * ROW_GAP)) / 2, width: lessonW, height: LESSON_H, side });
      });
      place(left, -1); place(right, 1);
      previousBottom = stageY + STAGE_H;
      y += blockH + STAGE_GAP;
    });
  }
  layout.height = y + 10;
  return layout;
}

const finished = (step: MapPathStep) => step.status === "done" || step.status === "skipped";

/** Learn: the active roadmap filling the map pane as a course. Any lesson opens; nothing is locked. */
export function MapRoadmapCourse({ path, trail, conversations, currentDocId, stepStrip, drafting, titleMenu, onOpen, onOpenStage, onGoIn, onGoTo, onClose }: {
  path: MapPath;
  trail: MapPathSummary[];
  conversations: Record<string, Conversation>;
  currentDocId: string | null;
  onOpen(docId: string): void;
  /** A stage opens as a document: an index of its lessons, like any other node. */
  onOpenStage(stageId: string): void;
  /** Go into a lesson that has its own roadmap. */
  onGoIn(pathId: string): void;
  onGoTo(pathId: string): void;
  /** The open lesson's details, docked under the header so they never cover a lesson. */
  stepStrip?: ReactNode;
  /** AI is writing this roadmap now: its lessons stream into the course as they arrive. */
  drafting?: { label: string; onStop(): void } | null;
  /** Turn the roadmap off. */
  onClose?(): void;
  /** The roadmap's name as a menu: switch roadmaps, see them all, change this one. */
  titleMenu?: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setWidth(Math.max(280, host.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  // The lesson you are on stays in view.
  useEffect(() => {
    hostRef.current?.querySelector(".is-current")?.scrollIntoView?.({ block: "nearest" });
  }, [currentDocId, path.id]);
  const layout = layoutCourse(path, width);
  // A stage is a document like any other: its index is open when it is the document being read.
  const openStageId = layout.stages.find((stage) => currentDocId === stageDocumentId(path.id, stage.id))?.id ?? null;
  const openLesson = onOpen;
  const stageById = new Map(layout.stages.map((stage) => [stage.id, stage]));
  const percent = path.total ? Math.round(path.finished / path.total * 100) : 0;
  // The open lesson's prerequisites and what it unlocks are marked in the course itself.
  const current = path.steps.find((step) => step.docId === currentDocId);
  const needed = new Set(current?.needs ?? []), unlocked = new Set(current?.unlocks ?? []);
  // A lesson that just streamed in is brought into view, so you watch the roadmap grow.
  const streamed = drafting ? path.steps.filter((step) => step.drafting).length : 0;
  useEffect(() => {
    if (!streamed) return;
    const host = hostRef.current;
    const last = host?.querySelectorAll(".map-course-lesson.is-drafting");
    const element = last?.[last.length - 1] as HTMLElement | undefined;
    // Only follow along while you're already near the bottom; scrolling up to read stays put.
    if (!host || !element || host.scrollHeight - host.scrollTop - host.clientHeight > 220) return;
    element.scrollIntoView?.({ block: "nearest" });
  }, [streamed]);
  return <div className={`map-course${drafting ? " is-drafting" : ""}`} ref={hostRef} data-graph-ui="true" aria-label={`Roadmap: ${path.name}`}>
    <div className="map-course-head">
      <span className="map-course-trail">
        {trail.map((item) => <button key={item.id} type="button" onClick={() => onGoTo(item.id)}>{item.name}<span aria-hidden="true"> ›</span></button>)}
        {titleMenu ?? <strong title={path.name}>{path.name}</strong>}
      </span>
      <span className="map-course-meter" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
      <span className="map-course-count">{path.finished} of {path.total} done</span>
      {onClose ? <button type="button" className="map-course-close" aria-label="Turn the roadmap off" title="Turn the roadmap off" onClick={onClose}>×</button> : null}
      {drafting ? <span className="map-course-drafting" role="status" aria-live="polite">
        <span className="map-course-spinner" aria-hidden="true" /><span>{drafting.label}</span>
        <button type="button" onClick={drafting.onStop}>Stop</button>
      </span> : null}
      {stepStrip ? <div className="map-course-step">{stepStrip}</div> : drafting ? null : <span className="map-course-legend" aria-hidden="true"><i className="is-done" />Done<i className="is-learning" />Learning<i className="is-optional" />Optional<span>↘ Has its own roadmap</span></span>}
    </div>
    {path.steps.length ? <div className="map-course-board" style={{ height: layout.height }}>
      <svg className="map-course-lines" width={layout.width} height={layout.height} aria-hidden="true">
        {layout.spine.map((line, index) => <line key={index} className="is-spine" x1={line.x} x2={line.x} y1={line.y1} y2={line.y2} />)}
        {layout.lessons.map(({ step, stageId, x, y, width: w, height: h, side }) => {
          const stage = stageById.get(stageId)!;
          if (layout.narrow) {
            const sx = stage.x + 14, ey = y + h / 2;
            return <path key={step.docId} className={step.optional ? "is-optional" : undefined} d={`M${sx} ${stage.y + stage.height} V${ey} H${x}`} />;
          }
          const sx = side < 0 ? stage.x : stage.x + stage.width, sy = stage.y + stage.height / 2;
          const ex = side < 0 ? x + w : x, ey = y + h / 2, mx = (sx + ex) / 2;
          return <path key={step.docId} className={step.optional ? "is-optional" : undefined} d={`M${sx} ${sy} C${mx} ${sy} ${mx} ${ey} ${ex} ${ey}`} />;
        })}
      </svg>
      <div className="map-course-start" style={{ top: 12, left: layout.narrow ? 16 : layout.width / 2, transform: layout.narrow ? undefined : "translateX(-50%)" }}>Start</div>
      {layout.stages.map((stage) => <button key={stage.id} type="button" className={`map-course-stage${stage.id === openStageId ? " is-open" : ""}`}
        style={{ left: stage.x, top: stage.y, width: stage.width, height: stage.height }} aria-current={stage.id === openStageId ? "page" : undefined}
        aria-label={`Stage ${stage.number}: ${stage.title}, ${stage.done} of ${stage.total} done. Open its index`}
        title="Open this stage: what each of its lessons covers" onClick={() => onOpenStage(stage.id)}>
        <span className="map-course-stage-number">{stage.number}</span>
        <strong>{stage.title}</strong>
        <em>{stage.done}/{stage.total}</em>
      </button>)}
      {layout.lessons.map(({ step, x, y, width: w, height: h }) => {
        const hasRoadmap = step.docId !== path.id && conversations[step.docId]?.nodeType === "roadmap";
        const next = step.docId === path.nextUpDocId;
        const marks = `${needed.has(step.docId) ? " is-needed" : ""}${unlocked.has(step.docId) ? " is-unlocked" : ""}${step.drafting ? " is-drafting" : ""}`;
        return <div key={step.docId} className={`map-course-lesson is-${step.status}${step.optional ? " is-optional" : ""}${next ? " is-next" : ""}${step.docId === currentDocId ? " is-current" : ""}${marks}`}
          style={{ left: x, top: y, width: w, height: h }}>
          <button type="button" className="map-course-open" disabled={step.drafting} title={step.drafting ? "AI is still writing this roadmap" : undefined} onClick={() => openLesson(step.docId)}
            aria-label={`Lesson ${step.number}: ${step.title}${step.optional ? " (optional)" : ""}, ${STATUS_WORDS[step.status]}${next ? ", next up" : ""}`}>
            <span className="map-course-title">{step.title}</span>
            {next ? <span className="map-course-next" aria-hidden="true">Next</span> : null}
            {step.status === "done" ? <span className="map-course-mark" aria-hidden="true">✓</span> : step.status === "learning" ? <span className="map-course-mark is-learning" aria-hidden="true" /> : null}
          </button>
          {hasRoadmap ? <button type="button" className="map-course-dive" aria-label={`Open the roadmap for ${step.title}`} title="Open its own roadmap" onClick={() => onGoIn(step.docId)}>↘</button> : null}
        </div>;
      })}
      <div className="map-course-start" style={{ top: layout.height - 26, left: layout.narrow ? 16 : layout.width / 2, transform: layout.narrow ? undefined : "translateX(-50%)" }}>{drafting ? "AI is adding lessons…" : path.finished === path.total ? "All done" : "Finish"}</div>
    </div> : drafting ? <p className="map-course-empty is-drafting"><span className="map-course-spinner" aria-hidden="true" />Lessons appear here as AI writes them.</p>
      : <p className="map-course-empty">This roadmap has no lessons yet. Draft it with AI from its name's menu above, or open its note and add steps.</p>}
  </div>;
}

const STATUS_WORDS = { "not-started": "not started", learning: "learning", done: "done", skipped: "skipped" } as const;

export { lessonSummary } from "../lib/roadmapStageDocument";

/** Learn with no roadmap yet: say what Learn is and start one. */
export function MapCourseEmpty({ onDraft, onNew }: { onDraft(goal: string): string | null; onNew(): void }) {
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  return <div className="map-course is-empty" data-graph-ui="true">
    <form className="map-course-start-form" onSubmit={(event) => { event.preventDefault(); const reason = onDraft(goal); if (reason) setError(reason); else setGoal(""); }}>
      <h2>Learn something in order</h2>
      <p>A roadmap is a course through your notes: stages to take one after another, and lessons in each. You can still open any lesson whenever you like.</p>
      <label htmlFor="map-course-goal">What do you want to learn? A goal, or a link to a roadmap or article.</label>
      <input id="map-course-goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Lower my ApoB, or https://roadmap.sh/…" />
      {error ? <p role="alert">{error}</p> : null}
      <div><button type="submit" className="is-primary" disabled={!goal.trim()}>✦ Draft a roadmap with AI</button>
        <button type="button" onClick={onNew}>Pick notes in order</button></div>
    </form>
  </div>;
}

/** The map bar's Learn | Explore switch. */
export function MapModeSwitch({ mode, onChange }: { mode: "learn" | "explore"; onChange(mode: "learn" | "explore"): void }) {
  return <div className="map-mode-switch" role="group" aria-label="Map mode">
    <button type="button" aria-pressed={mode === "learn"} title="Learn: a roadmap laid out as a course, in order" onClick={() => onChange("learn")}>Learn</button>
    <button type="button" aria-pressed={mode === "explore"} title="Explore: your notes and sources on the map" onClick={() => onChange("explore")}>Explore</button>
  </div>;
}
