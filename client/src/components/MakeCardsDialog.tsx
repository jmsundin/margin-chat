import { useEffect, useRef, useState } from "react";
import { FLASHCARD_STYLES, type FlashcardDraft, type FlashcardStyle } from "../lib/flashcardAI";
import { quizParts } from "../lib/flashcardQuiz";
import { FlashcardFace, QuizPreview } from "./FlashcardReview";
import "./MakeCardsDialog.css";

/** Where the cards go: an existing document, or (deckId null) a new document on a topic. */
export interface MakeCardsRequest { focus: string; style: FlashcardStyle; deckId: string | null }

interface Props {
  /** The document the cards come from and go to. Absent when the person picks a deck below. */
  title?: string;
  /** Documents to choose from when no document is given, or a new one on a topic. */
  decks?: ReadonlyArray<{ id: string; title: string }>;
  /** Selected text the cards are about. */
  passage?: string;
  initialStyle?: FlashcardStyle;
  /** Ask the AI straight away (from the selection menu, where the person already said what they want). */
  autoStart?: boolean;
  onGenerate: (request: MakeCardsRequest, signal: AbortSignal) => Promise<FlashcardDraft[]>;
  /** Add the chosen cards to the document. */
  onAdd: (drafts: FlashcardDraft[], request: MakeCardsRequest) => void;
  onClose: () => void;
}

const NEW_DECK = "";

/** The AI drafts cards or quiz questions; nothing is added until the person picks which to keep. */
export default function MakeCardsDialog({ title, decks, passage, initialStyle = "cards", autoStart, onGenerate, onAdd, onClose }: Props) {
  const [focus, setFocus] = useState("");
  const [style, setStyle] = useState<FlashcardStyle>(initialStyle);
  const [deckId, setDeckId] = useState<string>(NEW_DECK);
  const [drafts, setDrafts] = useState<FlashcardDraft[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const asked = useRef<MakeCardsRequest | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const picking = Boolean(decks);
  const newTopic = picking && deckId === NEW_DECK;

  useEffect(() => {
    input.current?.focus();
    if (autoStart) void generate();
    return () => abort.current?.abort();
    // Runs once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  async function generate() {
    if (newTopic && !focus.trim()) { setError("Say what the new questions are about."); input.current?.focus(); return; }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const request: MakeCardsRequest = { focus, style, deckId: picking ? deckId || null : null };
    setBusy(true); setError(null);
    try {
      const result = await onGenerate(request, controller.signal);
      if (controller.signal.aborted) return;
      asked.current = request;
      if (!result.length) setError(`The AI didn't suggest any ${style === "quiz" ? "questions" : "cards"}. Try saying what they should cover.`);
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
  const noun = style === "quiz" ? "question" : "card";
  const heading = style === "quiz" ? "Make quiz questions" : style === "mix" ? "Make cards and questions" : "Make flashcards";
  const destination = newTopic ? "a new document" : passage ? "the document under the passage" : "the end of the document";

  return (
    <div className="make-cards-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="make-cards" role="dialog" aria-modal="true" aria-label={heading}>
        <header className="make-cards-head">
          <h2>{heading}</h2>
          {title ? <span className="make-cards-source">from {title || "Untitled"}</span> : <span className="make-cards-source"/>}
          <button type="button" className="make-cards-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        {passage ? <blockquote className="make-cards-passage">{passage.length > 280 ? `${passage.slice(0, 280)}…` : passage}</blockquote> : null}
        <div className="make-cards-options">
          <div className="make-cards-style" role="radiogroup" aria-label="What to make">
            {FLASHCARD_STYLES.map((option) => (
              <button key={option.style} type="button" role="radio" aria-checked={style === option.style} disabled={busy}
                onClick={() => setStyle(option.style)}>{option.label}</button>
            ))}
          </div>
          {decks ? <label className="make-cards-deck">
            <span>Deck</span>
            <select value={deckId} onChange={(event) => setDeckId(event.target.value)} disabled={busy}>
              <option value={NEW_DECK}>New document on a topic</option>
              {decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.title || "Untitled"}</option>)}
            </select>
          </label> : null}
        </div>
        <form className="make-cards-ask" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
          <input ref={input} value={focus} onChange={(event) => setFocus(event.target.value)} disabled={busy}
            placeholder={newTopic ? "Topic, such as Java concurrency or the Krebs cycle" : passage ? "Anything to focus on? (optional)" : "What should they cover? (optional, the whole document by default)"}
            aria-label={newTopic ? "Topic" : "What the cards should cover"}/>
          <button type="submit" className="make-cards-primary" disabled={busy}>{busy ? "Writing…" : drafts ? "Try again" : style === "quiz" ? "Suggest questions" : "Suggest cards"}</button>
        </form>
        {error ? <p className="make-cards-error" role="alert">{error}</p> : null}
        {drafts?.length ? <>
          <p className="make-cards-hint">Untick any you don't want. Chosen {noun}s are added to {destination}, where you can edit them.</p>
          <ul className="make-cards-list">
            {drafts.map((draft, index) => {
              const card = draft.cards[0];
              const quiz = quizParts(card.front);
              return (
                <li key={`${index}:${draft.markdown}`} className={chosen.has(index) ? "is-chosen" : ""}>
                  <label>
                    <input type="checkbox" checked={chosen.has(index)} onChange={() => toggle(index)}/>
                    <span className="make-cards-card">
                      {quiz ? <QuizPreview quiz={quiz}/> : <FlashcardFace markdown={card.front}/>}
                      {card.back.trim() ? <span className="make-cards-back"><FlashcardFace markdown={card.back}/></span> : null}
                      {quiz ? <span className="make-cards-more">Quiz</span>
                        : draft.cards.length > 1 ? <span className="make-cards-more">{card.kind === "cloze" ? `${draft.cards.length} blanks` : "Both ways"}</span> : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <footer className="make-cards-foot">
            <button type="button" onClick={() => setChosen(chosen.size === drafts.length ? new Set() : new Set(drafts.map((_, index) => index)))}>
              {chosen.size === drafts.length ? "Untick all" : "Tick all"}
            </button>
            <button type="button" className="make-cards-primary" disabled={!chosen.size}
              onClick={() => { onAdd(drafts.filter((_, index) => chosen.has(index)), asked.current ?? { focus, style, deckId: picking ? deckId || null : null }); onClose(); }}>
              Add {cardCount} {noun}{cardCount === 1 ? "" : "s"}
            </button>
          </footer>
        </> : null}
      </div>
    </div>
  );
}
