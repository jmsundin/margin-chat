import { useMemo, useState } from "react";
import { formatInterval } from "../lib/flashcardSchedule";
import { scheduleCards, type FlashcardsController, type ScheduledCard } from "../lib/useFlashcards";
import { FlashcardFace } from "./FlashcardReview";

type Layout = "list" | "tiles";
const LAYOUT_KEY = "margin-chat:flashcard-browse-layout";

function loadLayout(): Layout {
  try { return localStorage.getItem(LAYOUT_KEY) === "tiles" ? "tiles" : "list"; } catch { return "list"; }
}

/** When a card comes up next, in a few words. */
export function cardStatus({ card, schedule }: Pick<ScheduledCard, "card" | "schedule">, now: number): { label: string; tone: "new" | "due" | "later" | "off" } {
  if (card.suspended) return { label: "Suspended", tone: "off" };
  if (schedule.state === "new") return { label: "New", tone: "new" };
  if (schedule.due <= now) return { label: "Due now", tone: "due" };
  return { label: `In ${formatInterval(schedule.due - now)}`, tone: "later" };
}

/** Cards grouped by the document (deck) they're written in, in the order they were written. */
export function groupCardsByDeck(cards: ReadonlyArray<ScheduledCard>, query = "") {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const groups = new Map<string, { docId: string; title: string; cards: ScheduledCard[] }>();
  for (const entry of cards) {
    const text = `${entry.card.front}\n${entry.card.back}\n${entry.card.docTitle}`.toLowerCase();
    if (words.some((word) => !text.includes(word))) continue;
    let group = groups.get(entry.card.docId);
    if (!group) groups.set(entry.card.docId, group = { docId: entry.card.docId, title: entry.card.docTitle || "Untitled", cards: [] });
    group.cards.push(entry);
  }
  for (const group of groups.values()) group.cards.sort((a, b) => a.card.ordinal - b.card.ordinal || a.card.kind.localeCompare(b.card.kind));
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
}

interface Props {
  flashcards: FlashcardsController;
  docIds?: ReadonlySet<string>;
  onOpenDocument: (docId: string) => void;
}

/** Every card at a glance: questions first, each opening to its answer. */
export default function FlashcardBrowser({ flashcards, docIds, onOpenDocument }: Props) {
  const { snapshot, settings, suspend } = flashcards;
  const cards = useMemo(() => scheduleCards(snapshot, settings, docIds, { includeSuspended: true }), [docIds, settings, snapshot]);
  const [query, setQuery] = useState("");
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [allOpen, setAllOpen] = useState(false);
  const groups = useMemo(() => groupCardsByDeck(cards, query), [cards, query]);
  const shown = groups.reduce((sum, group) => sum + group.cards.length, 0);
  const now = Date.now();

  const setLayout = (next: Layout) => {
    setLayoutState(next);
    try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* remembered for this visit only */ }
  };
  const toggle = (id: string) => setOpen((before) => {
    const next = new Set(before);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  if (!cards.length) return <p className="flashcard-review-note">No cards here yet.</p>;

  return (
    <div className="flashcard-browser">
      <div className="flashcard-browser-tools">
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search cards"
          aria-label="Search cards"/>
        <button type="button" className="flashcard-browser-toggle" onClick={() => { setAllOpen(!allOpen); setOpen(new Set()); }}
          aria-pressed={allOpen}>{allOpen ? "Hide answers" : "Show answers"}</button>
        <div className="flashcard-segmented" role="group" aria-label="Layout">
          <button type="button" aria-pressed={layout === "list"} onClick={() => setLayout("list")}>List</button>
          <button type="button" aria-pressed={layout === "tiles"} onClick={() => setLayout("tiles")}>Tiles</button>
        </div>
      </div>
      {!shown ? <p className="flashcard-review-note">No cards match “{query}”.</p> : null}
      {groups.map((group) => (
        <section key={group.docId} className="flashcard-deck">
          <header className="flashcard-deck-head">
            <h3>{group.title}</h3>
            <span>{group.cards.length} card{group.cards.length === 1 ? "" : "s"}</span>
            <button type="button" onClick={() => onOpenDocument(group.docId)} title="Open the document these cards are written in">Open document</button>
          </header>
          <ul className={`flashcard-deck-cards is-${layout}`}>
            {group.cards.map((entry) => {
              const expanded = allOpen !== open.has(entry.card.id);
              const status = cardStatus(entry, now);
              return (
                <li key={entry.card.id} className={`flashcard-browse-card${expanded ? " is-open" : ""}${entry.card.suspended ? " is-suspended" : ""}`}>
                  <button type="button" className="flashcard-browse-front" aria-expanded={expanded} onClick={() => toggle(entry.card.id)}>
                    <FlashcardFace markdown={entry.card.front}/>
                    <span className={`flashcard-status is-${status.tone}`}>{status.label}</span>
                  </button>
                  {expanded ? <div className="flashcard-browse-back">
                    <FlashcardFace markdown={entry.card.back}/>
                    <div className="flashcard-browse-actions">
                      {entry.card.kind === "reverse" ? <span>Reversed card</span> : entry.card.kind === "cloze" ? <span>Fill in the blank</span> : null}
                      <span>{entry.reviews.length ? `Reviewed ${entry.reviews.length}×` : "Not studied yet"}</span>
                      <button type="button" onClick={() => suspend(entry.card.id, !entry.card.suspended)}>
                        {entry.card.suspended ? "Turn back on" : "Suspend"}
                      </button>
                    </div>
                  </div> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
