import { useEffect, useId, useRef, useState } from "react";
import { describeSummary, type AuthorshipMode, type AuthorshipSummary } from "../lib/documentAuthorship";
import "./DocumentAuthorshipBar.css";

const MODES: Array<{ id: AuthorshipMode; label: string; title: string }> = [
  { id: "off", label: "Off", title: "Show the document without authorship marks" },
  { id: "mine", label: "Mine", title: "Mark the lines you wrote" },
  { id: "blame", label: "Blame", title: "Label who wrote each run of lines, and when" },
];

/** The chip on a phone: just your share of the lines, so it fits beside the view tabs. */
export function describeShortSummary(summary: AuthorshipSummary) {
  return summary.totalLines ? `${Math.round((summary.mineLines / summary.totalLines) * 100)}%` : "";
}

/**
 * One line above a document: how much of it you wrote, and how to see which
 * lines. Always shown where authorship is recorded; the marks are opt-in.
 * On a phone it folds to one short chip that opens the same line and switches.
 */
export default function DocumentAuthorshipBar({ summary, mode, onlyMine, onModeChange, onOnlyMineChange }: {
  summary: AuthorshipSummary;
  mode: AuthorshipMode;
  onlyMine: boolean;
  onModeChange: (mode: AuthorshipMode) => void;
  onOnlyMineChange: (onlyMine: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  const text = describeSummary(summary);
  if (!text) return null;
  // A dot on the chip says a view is on, so marks on the page never look unexplained.
  const view = onlyMine ? "only your lines" : mode === "mine" ? "your lines" : mode === "blame" ? "who wrote each line" : "";
  return <div ref={rootRef} className="document-authorship-bar" data-open={open || undefined}>
    <button type="button" className="document-authorship-chip" aria-expanded={open} aria-controls={panelId}
      aria-label={`Authorship: ${text}${view ? `. Showing ${view}` : ""}`} title={`${text}${view ? `. Showing ${view}` : ""}`}
      data-view={view || undefined} onClick={() => setOpen(!open)}>{describeShortSummary(summary)}</button>
    <div className="document-authorship-panel" id={panelId}>
      <span className="document-authorship-summary" role="note" aria-label={`Authorship: ${text}`} title={text}>{text}</span>
      <span className="document-authorship-controls">
        <span className="document-authorship-modes" role="radiogroup" aria-label="Authorship view">
          {MODES.map((option) => <button key={option.id} type="button" role="radio" aria-checked={mode === option.id} title={option.title}
            onClick={() => onModeChange(option.id)}>{option.label}</button>)}
        </span>
        <button type="button" className="document-authorship-only-mine" aria-pressed={onlyMine}
          title={onlyMine ? "Show every line again" : "Fold lines you didn't write, to read just yours. Editing pauses while this is on."}
          onClick={() => onOnlyMineChange(!onlyMine)}>Only mine</button>
      </span>
    </div>
  </div>;
}
