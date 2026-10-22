import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import "./GuidedTour.css";

export interface TourStep {
  /** Selectors tried in order; the first visible match is lit up. With none, the card sits in the middle. */
  targets: string[];
  title: string;
  body: string;
}

export const DESKTOP_TOUR: TourStep[] = [
  { targets: [".live-document-editor"], title: "This is your document",
    body: "Write anything here, or press Space on an empty line to ask AI. The “Try it” list on this page ticks itself off as you go." },
  { targets: [".live-document-editor .message-anchor", ".document-margin"], title: "Select text to work with it",
    body: "Select any words for Highlight, Note, Side doc, Link and ✦ Ask AI. A note stays beside the passage. A side doc opens a new idea in its own pane." },
  { targets: [".thread-sidebar"], title: "Your vault",
    body: "Every document is listed here, newest first. Search finds words or meaning, and files you drop here join your vault." },
  { targets: [".workspace-mode-control"], title: "Three ways to look",
    body: "Document, Tiles and Map View. The Map (⌘G) shows each document as a dot, with lines for side docs, notes and links." },
  { targets: [".session-switcher", ".document-tabs-list"], title: "Sessions and tabs",
    body: "Tabs are the documents you have open. A session keeps its own tabs, so each project picks up where you left off." },
  { targets: ['[aria-label="Open settings"]'], title: "Bring your other AI apps",
    body: "Connect Claude, ChatGPT or Gemini so they can search and save to your vault. Settings → Agents has the steps, and so does marginchat.com/connect." },
];

export const PHONE_TOUR: TourStep[] = [
  DESKTOP_TOUR[0],
  { targets: [".live-document-editor .message-anchor"], title: "Select text to work with it",
    body: "Hold a word and drag to select. A row appears with Highlight, Note, Side doc, Link and ✦ Ask AI." },
  { targets: [".mobile-dock"], title: "Your buttons",
    body: "+ makes a new document, side document or margin note. The mic types what you say. The keyboard button brings the keyboard up." },
  { targets: [".workspace-menu-button"], title: "Your vault and the Map",
    body: "Tap here, or swipe in from the left edge, for every document, search, and Map View." },
  { targets: [".document-header-title"], title: "Tabs and sessions",
    body: "Tap the title to switch between your open documents and your sessions." },
  { targets: [".workspace-menu-button"], title: "Bring your other AI apps",
    body: "Connect Claude, ChatGPT or Gemini so they can search and save to your vault. In the sidebar, Settings → Agents has the steps." },
];

const PAD = 6;
const GAP = 12;

function findTarget(step: TourStep): DOMRect | null {
  for (const selector of step.targets) {
    for (const element of document.querySelectorAll(selector)) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight) return rect;
    }
  }
  return null;
}

/** Dims the app and lights up one control at a time, with a card that explains it. */
export default function GuidedTour({ steps, step, onStep, onPause, onFinish }: {
  steps: TourStep[];
  step: number;
  onStep: (step: number) => void;
  /** "Skip tour" or Escape: the Tour pill can pick it up again. */
  onPause: () => void;
  onFinish: () => void;
}) {
  const index = Math.min(Math.max(step, 0), steps.length - 1);
  const current = steps[index];
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [cardSize, setCardSize] = useState({ width: 320, height: 180 });
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const last = index === steps.length - 1;

  // Layout keeps moving while the app settles, so the light follows its control.
  useEffect(() => {
    const measure = () => setRect((previous) => {
      const found = findTarget(current);
      if (!found || !previous) return found;
      return Math.abs(found.x - previous.x) + Math.abs(found.y - previous.y) + Math.abs(found.width - previous.width) + Math.abs(found.height - previous.height) < 1 ? previous : found;
    });
    measure();
    const timer = window.setInterval(measure, 250);
    window.addEventListener("resize", measure);
    return () => { window.clearInterval(timer); window.removeEventListener("resize", measure); };
  }, [current]);
  useLayoutEffect(() => {
    const box = card.current?.getBoundingClientRect();
    if (box && (Math.abs(box.width - cardSize.width) > 1 || Math.abs(box.height - cardSize.height) > 1)) setCardSize({ width: box.width, height: box.height });
  });
  useEffect(() => { next.current?.focus({ preventScroll: true }); }, [index]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onPause(); }
      else if (event.key === "ArrowRight") { event.preventDefault(); if (last) onFinish(); else onStep(index + 1); }
      else if (event.key === "ArrowLeft" && index > 0) { event.preventDefault(); onStep(index - 1); }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [index, last, onFinish, onPause, onStep]);

  const width = window.innerWidth;
  const height = window.innerHeight;
  const hole = rect ? {
    left: Math.max(4, rect.left - PAD), top: Math.max(4, rect.top - PAD),
    width: Math.min(width - 8, rect.width + PAD * 2), height: Math.min(height - 8, rect.height + PAD * 2),
  } : null;
  let cardStyle: CSSProperties;
  if (!hole) cardStyle = { left: (width - cardSize.width) / 2, top: (height - cardSize.height) / 2 };
  else {
    const below = hole.top + hole.height + GAP;
    const above = hole.top - GAP - cardSize.height;
    const right = hole.left + hole.width + GAP;
    const clampLeft = (value: number) => Math.min(Math.max(12, value), width - cardSize.width - 12);
    const clampTop = (value: number) => Math.min(Math.max(12, value), height - cardSize.height - 12);
    if (below + cardSize.height <= height - 12) cardStyle = { left: clampLeft(hole.left), top: below };
    else if (above >= 12) cardStyle = { left: clampLeft(hole.left), top: above };
    else if (right + cardSize.width <= width - 12) cardStyle = { left: right, top: clampTop(hole.top) };
    // A tall target such as the document: the card sits inside it, near the bottom.
    else cardStyle = { left: clampLeft(hole.left + (hole.width - cardSize.width) / 2), top: clampTop(hole.top + hole.height - cardSize.height - 24) };
  }

  return createPortal(<div className="guided-tour" role="presentation">
    {hole ? <div className="guided-tour-hole" style={hole} aria-hidden="true" /> : <div className="guided-tour-dim" aria-hidden="true" />}
    <div ref={card} className="guided-tour-card" style={cardStyle} role="dialog" aria-modal="true"
      aria-labelledby="guided-tour-title" aria-describedby="guided-tour-body">
      <span className="guided-tour-count">{index + 1} of {steps.length}</span>
      <strong id="guided-tour-title">{current.title}</strong>
      <p id="guided-tour-body">{current.body}</p>
      <div className="guided-tour-actions">
        {last ? null : <button type="button" className="guided-tour-skip" onClick={onPause}>Skip tour</button>}
        <span className="guided-tour-dots" aria-hidden="true">
          {steps.map((_, dot) => <i key={dot} className={dot === index ? "is-current" : undefined} />)}
        </span>
        {index > 0 ? <button type="button" className="guided-tour-button" onClick={() => onStep(index - 1)}>Back</button> : null}
        <button ref={next} type="button" className="guided-tour-button is-primary" onClick={() => last ? onFinish() : onStep(index + 1)}>
          {last ? "Done" : "Next"}
        </button>
      </div>
    </div>
  </div>, document.body);
}

/** The way back into a tour that was left early, until it is finished or hidden. */
export function TourPill({ step, total, askToHide, onResume, onHide, onKeep }: {
  step: number;
  total: number;
  /** The person has already found most of what the tour shows, so the pill offers to go. */
  askToHide: boolean;
  onResume: () => void;
  onHide: () => void;
  onKeep: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const question = asking || askToHide;
  return <div className={`tour-pill${question ? " is-asking" : ""}`} role={question ? "dialog" : undefined}
    aria-label={question ? "Hide the tour?" : undefined}>
    {question ? <>
      <span className="tour-pill-question">{askToHide && !asking ? "Looks like you’ve found your way around. Hide the tour?" : "Hide the tour? “Take the tour” in the ⋯ menu brings it back."}</span>
      <span className="tour-pill-answers">
        <button type="button" className="is-primary" onClick={onHide}>Hide</button>
        <button type="button" onClick={() => { setAsking(false); onKeep(); }}>Keep for now</button>
      </span>
    </> : <>
      <button type="button" className="tour-pill-resume" onClick={onResume} aria-label={`Resume the tour, step ${Math.min(step + 1, total)} of ${total}`}>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
        </svg>
        Tour {Math.min(step + 1, total)}/{total}
      </button>
      <button type="button" className="tour-pill-close" aria-label="Hide the tour" onClick={() => setAsking(true)}>×</button>
    </>}
  </div>;
}
