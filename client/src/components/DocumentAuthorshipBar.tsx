import { describeSummary, type AuthorshipMode, type AuthorshipSummary } from "../lib/documentAuthorship";
import "./DocumentAuthorshipBar.css";

const MODES: Array<{ id: AuthorshipMode; label: string; title: string }> = [
  { id: "off", label: "Off", title: "Show the document without authorship marks" },
  { id: "mine", label: "Mine", title: "Mark the lines you wrote" },
  { id: "blame", label: "Blame", title: "Label who wrote each run of lines, and when" },
];

/**
 * One line above a document: how much of it you wrote, and how to see which
 * lines. Always shown where authorship is recorded; the marks are opt-in.
 */
export default function DocumentAuthorshipBar({ summary, mode, onlyMine, onModeChange, onOnlyMineChange }: {
  summary: AuthorshipSummary;
  mode: AuthorshipMode;
  onlyMine: boolean;
  onModeChange: (mode: AuthorshipMode) => void;
  onOnlyMineChange: (onlyMine: boolean) => void;
}) {
  const text = describeSummary(summary);
  if (!text) return null;
  return <div className="document-authorship-bar">
    <span className="document-authorship-summary" role="note" aria-label={`Authorship: ${text}`}>{text}</span>
    <span className="document-authorship-controls">
      <span className="document-authorship-modes" role="radiogroup" aria-label="Authorship view">
        {MODES.map((option) => <button key={option.id} type="button" role="radio" aria-checked={mode === option.id} title={option.title}
          onClick={() => onModeChange(option.id)}>{option.label}</button>)}
      </span>
      <button type="button" className="document-authorship-only-mine" aria-pressed={onlyMine}
        title={onlyMine ? "Show every line again" : "Fold lines you didn't write, to read just yours. Editing pauses while this is on."}
        onClick={() => onOnlyMineChange(!onlyMine)}>Only mine</button>
    </span>
  </div>;
}
