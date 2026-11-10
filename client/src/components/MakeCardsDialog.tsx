import { useEffect, useRef, useState } from "react";
import type { FlashcardDraft } from "../lib/flashcardAI";
import { FlashcardFace } from "./FlashcardReview";
import "./MakeCardsDialog.css";

interface Props {
  title: string;
  onGenerate: (focus: string, signal: AbortSignal) => Promise<FlashcardDraft[]>;
  /** Add the chosen cards to the end of the document. */
  onAdd: (drafts: FlashcardDraft[]) => void;
  onClose: () => void;
}

/** The AI drafts cards from a document; nothing is added until the person picks which to keep. */
export default function MakeCardsDialog({ title, onGenerate, onAdd, onClose }: Props) {
  const [focus, setFocus] = useState("");
  const [drafts, setDrafts] = useState<FlashcardDraft[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); return () => abort.current?.abort(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function generate() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); setError(null);
    try {
      const result = await onGenerate(focus, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.length) setError("The AI didn't suggest any cards. Try saying what they should cover.");
      setDrafts(result);
      setChosen(new Set(result.map((_, index) => index)));
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "The AI couldn't make cards just now. Try again.");
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  }

  const toggle = (index: number) => setChosen((current) => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });
  const cardCount = drafts ? [...chosen].reduce((total, index) => total + drafts[index].cards.length, 0) : 0;

  return (
    <div className="make-cards-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="make-cards" role="dialog" aria-modal="true" aria-label={`Make flashcards from ${title}`}>
        <header className="make-cards-head">
          <h2>Make flashcards</h2>
          <span className="make-cards-source">from {title || "Untitled"}</span>
          <button type="button" className="make-cards-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <form className="make-cards-ask" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
          <input ref={input} value={focus} onChange={(event) => setFocus(event.target.value)} disabled={busy}
            placeholder="What should they cover? (optional, the whole document by default)" aria-label="What the cards should cover"/>
          <button type="submit" className="make-cards-primary" disabled={busy}>{busy ? "Writing…" : drafts ? "Try again" : "Suggest cards"}</button>
        </form>
        {error ? <p className="make-cards-error" role="alert">{error}</p> : null}
        {drafts?.length ? <>
          <p className="make-cards-hint">Untick any you don't want. Chosen cards are added to the end of the document, where you can edit them.</p>
          <ul className="make-cards-list">
            {drafts.map((draft, index) => (
              <li key={`${index}:${draft.markdown}`} className={chosen.has(index) ? "is-chosen" : ""}>
                <label>
                  <input type="checkbox" checked={chosen.has(index)} onChange={() => toggle(index)}/>
                  <span className="make-cards-card">
                    <FlashcardFace markdown={draft.cards[0].front}/>
                    <span className="make-cards-back"><FlashcardFace markdown={draft.cards[0].back}/></span>
                    {draft.cards.length > 1 ? <span className="make-cards-more">{draft.cards[0].kind === "cloze" ? `${draft.cards.length} blanks` : "Both ways"}</span> : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <footer className="make-cards-foot">
            <button type="button" onClick={() => setChosen(chosen.size === drafts.length ? new Set() : new Set(drafts.map((_, index) => index)))}>
              {chosen.size === drafts.length ? "Untick all" : "Tick all"}
            </button>
            <button type="button" className="make-cards-primary" disabled={!chosen.size}
              onClick={() => { onAdd(drafts.filter((_, index) => chosen.has(index))); onClose(); }}>
              Add {cardCount} card{cardCount === 1 ? "" : "s"}
            </button>
          </footer>
        </> : null}
      </div>
    </div>
  );
}
