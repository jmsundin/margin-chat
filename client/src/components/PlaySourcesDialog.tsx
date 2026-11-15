import { useEffect, useState } from "react";
import "./MakeCardsDialog.css";

interface Props {
  /** The game. */
  title: string;
  /** Documents that hold questions, with how many. */
  decks: ReadonlyArray<{ id: string; title: string; count: number }>;
  /** Documents this game asks from now. */
  chosen: readonly string[];
  /** Questions written in the game's own notes, which it always asks. */
  ownCount: number;
  onSave: (documentIds: string[]) => void;
  /** AI writes questions about what the game shows now; absent when AI can't read this page. */
  onMake?: () => void;
  onClose: () => void;
}

/** Which documents a game asks its questions from. The questions stay in those documents, and in Review. */
export default function PlaySourcesDialog({ title, decks, chosen, ownCount, onSave, onMake, onClose }: Props) {
  const [picked, setPicked] = useState(() => new Set(chosen));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const total = ownCount + decks.reduce((sum, deck) => sum + (picked.has(deck.id) ? deck.count : 0), 0);
  return <div className="make-cards-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="make-cards" role="dialog" aria-modal="true" aria-label="Questions for this game">
      <header className="make-cards-head">
        <h2>Questions</h2>
        <span className="make-cards-source">for {title || "this game"}</span>
        <button type="button" className="make-cards-close" onClick={onClose} aria-label="Close">×</button>
      </header>
      <p className="make-cards-hint">Pick the documents this game asks from. Their flashcards and quiz questions are loaded into the game, and stay in Review too.
        {ownCount ? ` ${ownCount} written in this game's own notes ${ownCount === 1 ? "is" : "are"} always asked.` : ""}</p>
      {decks.length ? <ul className="make-cards-list">
        {decks.map((deck) => <li key={deck.id} className={picked.has(deck.id) ? "is-chosen" : ""}>
          <label>
            <input type="checkbox" checked={picked.has(deck.id)} onChange={(event) => setPicked((current) => {
              const next = new Set(current);
              if (event.target.checked) next.add(deck.id); else next.delete(deck.id);
              return next;
            })}/>
            <span className="make-cards-card">
              <span>{deck.title || "Untitled"}</span>
              <span className="make-cards-more">{deck.count} {deck.count === 1 ? "question" : "questions"}</span>
            </span>
          </label>
        </li>)}
      </ul> : <p className="make-cards-hint">No document has questions yet. Write a line like <code>Question :: Answer</code> in any note, or have AI make some.</p>}
      <footer className="make-cards-foot">
        {onMake ? <button type="button" onClick={onMake} title="AI writes questions about what the game shows now, for you to choose from">Make questions with AI…</button> : null}
        <span className="make-cards-source">{total} {total === 1 ? "question" : "questions"}</span>
        <button type="button" className="make-cards-primary" onClick={() => { onSave(decks.filter((deck) => picked.has(deck.id)).map((deck) => deck.id)); onClose(); }}>Done</button>
      </footer>
    </div>
  </div>;
}
