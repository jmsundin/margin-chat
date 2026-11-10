import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseMediaEmbed } from "../lib/documentMedia";
import { renderObsidianMarkdownToHtml } from "../lib/markdown";
import { buildStudyQueue, FLASHCARD_RATINGS, formatInterval, previewRatings, type FlashcardRating } from "../lib/flashcardSchedule";
import { useVaultMedia } from "../lib/vaultMedia";
import { newStudiedToday, type FlashcardsController, type ScheduledCard } from "../lib/useFlashcards";
import "./FlashcardReview.css";

/** Cards answered within this long come back in the same session (learning steps). */
const LEARN_AHEAD_MS = 20 * 60_000;

function VaultImage({ target, alt }: { target: string; alt: string }) {
  const media = useVaultMedia();
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null, cancelled = false;
    setMissing(false);
    if (!media) { setMissing(true); return; }
    media.read(target).then((file) => {
      if (cancelled) return;
      if (!file) { setMissing(true); return; }
      objectUrl = URL.createObjectURL(file.blob);
      setUrl(objectUrl);
    }, () => { if (!cancelled) setMissing(true); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [media, target]);
  if (missing) return <p className="flashcard-image-missing">Image not found: {target}</p>;
  return url ? <img alt={alt} className="flashcard-image" src={url}/> : <div className="flashcard-image is-loading" aria-label="Loading image"/>;
}

/** A card side: Markdown, with image embeds drawn from the vault. */
export function FlashcardFace({ markdown }: { markdown: string }) {
  const parts = useMemo(() => {
    const result: Array<{ kind: "text"; html: string } | { kind: "image"; target: string; alt: string; vault: boolean }> = [];
    let text: string[] = [];
    const flush = () => { if (text.join("").trim()) result.push({ kind: "text", html: renderObsidianMarkdownToHtml(text.join("\n")) }); text = []; };
    // An embed in the middle of a line goes on its own line so it is drawn as an image.
    for (const line of markdown.replace(/(!\[\[[^\]\n]+\]\]|!\[[^\]\n]*\]\([^)\n]+\))/gu, "\n$1\n").split("\n")) {
      const embed = parseMediaEmbed(line);
      if (embed?.kind === "image") { flush(); result.push({ kind: "image", target: embed.target, alt: embed.alt ?? "", vault: embed.source === "vault" }); }
      else text.push(line);
    }
    flush();
    return result;
  }, [markdown]);
  return (
    <div className="flashcard-face">
      {parts.map((part, index) => part.kind === "text"
        ? <div className="flashcard-text" key={index} dangerouslySetInnerHTML={{ __html: part.html }}/>
        : part.vault ? <VaultImage key={index} target={part.target} alt={part.alt}/>
          : <img key={index} className="flashcard-image" src={part.target} alt={part.alt} referrerPolicy="no-referrer"/>)}
    </div>
  );
}

interface Props {
  flashcards: FlashcardsController;
  /** Study only these documents' cards; all cards when absent. */
  docIds?: ReadonlySet<string>;
  title: string;
  onClose: () => void;
  onOpenDocument: (docId: string) => void;
  /** Bring in an Anki deck; resolves to a sentence saying what came in. */
  onImportAnki?: (file: File, onProgress: (message: string) => void) => Promise<string>;
  /** Save these cards as an Anki deck; resolves to a sentence saying what was saved. */
  onExportAnki?: () => Promise<string>;
}

function syntaxHelp() {
  return (
    <div className="flashcard-help">
      <p>Write cards anywhere in a document:</p>
      <dl>
        <dt><code>Question :: Answer</code></dt><dd>one card</dd>
        <dt><code>Question ::: Answer</code></dt><dd>two cards, one each way</dd>
        <dt><code>Front</code><br/><code>?</code><br/><code>Back</code></dt><dd>a longer card; the back runs to the next blank line (<code>??</code> for both ways)</dd>
        <dt><code>{"The {{c1::heart}} pumps blood"}</code></dt><dd>fill in the blank</dd>
        <dt><code>![[diagram.png]]</code></dt><dd>an image on either side</dd>
      </dl>
    </div>
  );
}

export default function FlashcardReview({ flashcards, docIds, title, onClose, onOpenDocument, onImportAnki, onExportAnki }: Props) {
  const [transfer, setTransfer] = useState<{ busy: boolean; message: string; error?: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const runTransfer = useCallback(async (work: (progress: (message: string) => void) => Promise<string>) => {
    setTransfer({ busy: true, message: "Working…" });
    try {
      const message = await work((progress) => setTransfer({ busy: true, message: progress }));
      setTransfer({ busy: false, message });
    } catch (error) {
      setTransfer({ busy: false, message: error instanceof Error ? error.message : "That didn't work. Try again.", error: true });
    }
  }, []);
  const chooseAnkiFile = useCallback(() => fileInput.current?.click(), []);
  const { scheduled, settings, answer, undo, suspend, loaded } = flashcards;
  const pool = useMemo(() => (docIds ? scheduled.filter((entry) => docIds.has(entry.card.docId)) : scheduled), [docIds, scheduled]);
  // The session's order is fixed when it starts, so a card doesn't jump while it is shown.
  const [session, setSession] = useState<{ order: string[]; later: Array<{ id: string; due: number }> } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [lastAnswer, setLastAnswer] = useState<{ reviewId: string; cardId: string; session: NonNullable<typeof session> } | null>(null);
  const [doneCount, setDoneCount] = useState(0);
  const shownAt = useRef(Date.now());
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Cards written a moment ago are read shortly after; an empty session that hasn't started picks them up.
    if (!loaded || (session && (doneCount || session.order.length || session.later.length))) return;
    const now = Date.now();
    // One document's session takes its own due cards and draws on the same daily allowance of new cards.
    const { learning, review, fresh } = docIds
      ? buildStudyQueue(pool, now, { newPerDay: settings.newPerDay, newStudiedToday: newStudiedToday(scheduled, now) })
      : flashcards.queue;
    const order = [...learning, ...review, ...fresh].map((entry) => entry.card.id);
    if (!session || order.length) setSession({ order, later: [] });
  }, [docIds, doneCount, flashcards.queue, loaded, pool, scheduled, session, settings.newPerDay]);

  const byId = useMemo(() => new Map(pool.map((entry) => [entry.card.id, entry])), [pool]);
  // While only cards still being learned are left, look again as they come due.
  const [tick, setTick] = useState(0);
  const waitingForLater = Boolean(session && session.later.length);
  useEffect(() => {
    if (!waitingForLater) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 15_000);
    return () => window.clearInterval(timer);
  }, [waitingForLater]);
  const current: ScheduledCard | null = useMemo(() => {
    if (!session) return null;
    const now = Date.now();
    const dueLater = session.later.filter((entry) => entry.due <= now).sort((a, b) => a.due - b.due)[0];
    const id = dueLater?.id ?? session.order.find((cardId) => byId.has(cardId)) ??
      [...session.later].sort((a, b) => a.due - b.due).find((entry) => entry.due <= now + LEARN_AHEAD_MS)?.id;
    return id ? byId.get(id) ?? null : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byId, session, tick]);

  useEffect(() => { shownAt.current = Date.now(); setRevealed(false); }, [current?.card.id]);
  useEffect(() => { dialog.current?.focus(); }, []);

  const preview = useMemo(() => (current ? previewRatings(current.reviews, Date.now(), settings) : null), [current, settings]);

  const grade = useCallback(async (rating: FlashcardRating) => {
    if (!current || !session || !revealed) return;
    const before = session;
    const review = await answer(current.card.id, rating, Date.now() - shownAt.current);
    const due = preview?.[rating] ?? Date.now();
    const order = session.order.filter((id) => id !== current.card.id);
    const later = session.later.filter((entry) => entry.id !== current.card.id);
    // Short steps come back in this session; longer ones wait for their day.
    if (due - Date.now() <= 60 * 60_000) later.push({ id: current.card.id, due });
    setSession({ order, later });
    setLastAnswer({ reviewId: review.id, cardId: current.card.id, session: before });
    setDoneCount((count) => count + 1);
  }, [answer, current, preview, revealed, session]);

  const takeBack = useCallback(() => {
    if (!lastAnswer || !undo(lastAnswer.reviewId)) return;
    setSession(lastAnswer.session);
    setLastAnswer(null);
    setDoneCount((count) => Math.max(0, count - 1));
  }, [lastAnswer, undo]);

  const skipSuspend = useCallback(() => {
    if (!current || !session) return;
    suspend(current.card.id, true);
    setSession({ order: session.order.filter((id) => id !== current.card.id), later: session.later.filter((entry) => entry.id !== current.card.id) });
  }, [current, session, suspend]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if ((event.key === "z" || event.key === "Z") && !event.shiftKey) {
        if (lastAnswer) { event.preventDefault(); takeBack(); }
        return;
      }
      if (event.metaKey || event.ctrlKey) return;
      if (!revealed && (event.key === " " || event.key === "Enter")) { event.preventDefault(); setRevealed(true); return; }
      if (revealed) {
        const choice = FLASHCARD_RATINGS.find((item) => item.key === event.key);
        if (choice) { event.preventDefault(); void grade(choice.rating); }
        else if (event.key === " " || event.key === "Enter") { event.preventDefault(); void grade(3); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [grade, lastAnswer, onClose, revealed, takeBack]);

  const remaining = session ? new Set([...session.order.filter((id) => byId.has(id)), ...session.later.map((entry) => entry.id)]).size : 0;
  const nextDue = useMemo(() => {
    const future = pool.filter((entry) => entry.schedule.state !== "new").map((entry) => entry.schedule.due).filter((due) => due > Date.now());
    return future.length ? Math.min(...future) : null;
  }, [pool]);
  const waiting = !current && session?.later.length ? Math.min(...session.later.map((entry) => entry.due)) : null;

  return (
    <div className="flashcard-review" role="dialog" aria-modal="true" aria-label={`Review: ${title}`} tabIndex={-1} ref={dialog}>
      <header className="flashcard-review-head">
        <div className="flashcard-review-title">
          <span>Review</span>
          <strong>{title}</strong>
        </div>
        {session && (current || remaining) ? <span className="flashcard-review-count" aria-live="polite">{doneCount} done · {remaining} left</span> : null}
        {onImportAnki || onExportAnki ? <div className="flashcard-transfer">
          {onImportAnki ? <>
            <input ref={fileInput} type="file" accept=".apkg,.colpkg" hidden onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void runTransfer((progress) => onImportAnki(file, progress));
            }}/>
            <button type="button" disabled={transfer?.busy} onClick={chooseAnkiFile} title="Bring in an Anki deck (.apkg) with its review history">Import from Anki</button>
          </> : null}
          {onExportAnki && pool.length ? <button type="button" disabled={transfer?.busy} onClick={() => void runTransfer(() => onExportAnki())}
            title="Save these cards and their review history as an Anki deck (.apkg)">Export to Anki</button> : null}
        </div> : null}
        <button type="button" className="flashcard-review-close" onClick={onClose} aria-label="Close review" title="Close (Esc)">×</button>
      </header>

      {transfer ? <p className={`flashcard-transfer-status${transfer.error ? " is-error" : ""}`} role="status">
        {transfer.message}
        {!transfer.busy ? <button type="button" onClick={() => setTransfer(null)} aria-label="Dismiss">×</button> : null}
      </p> : null}
      <main className="flashcard-review-body">
        {!loaded || !session ? <p className="flashcard-review-note">Loading cards…</p>
          : current ? (
            <article className={`flashcard-card${revealed ? " is-revealed" : ""}`} aria-live="polite">
              <FlashcardFace markdown={current.card.front}/>
              {revealed ? <>
                <hr className="flashcard-divider"/>
                <FlashcardFace markdown={current.card.back}/>
              </> : null}
              <footer className="flashcard-card-source">
                <button type="button" onClick={() => onOpenDocument(current.card.docId)} title="Open the document this card is written in">{current.card.docTitle || "Untitled"}</button>
                {current.schedule.state === "new" ? <span className="flashcard-badge">New</span> : null}
              </footer>
            </article>
          ) : (
            <div className="flashcard-done">
              {pool.length ? <>
                <h2>{doneCount ? "That's everything for now." : "Nothing due right now."}</h2>
                {waiting ? <p>{remaining} card{remaining === 1 ? "" : "s"} you're learning come back in {formatInterval(waiting - Date.now())}.</p>
                  : nextDue ? <p>Next card is due in {formatInterval(nextDue - Date.now())}.</p> : null}
                {waiting ? <button type="button" className="flashcard-primary" onClick={() => setSession({ order: session.later.map((entry) => entry.id), later: [] })}>Study them now</button> : null}
              </> : <>
                <h2>No cards yet</h2>
                {syntaxHelp()}
                {onImportAnki ? <p className="flashcard-import-hint">Have Anki decks? <button type="button" onClick={chooseAnkiFile} disabled={transfer?.busy}>Import an .apkg file</button> with its review history.</p> : null}
              </>}
            </div>
          )}
      </main>

      {current ? (
        <div className="flashcard-review-actions">
          {!revealed ? (
            <button type="button" className="flashcard-primary flashcard-show" onClick={() => setRevealed(true)} autoFocus>
              Show answer <kbd>Space</kbd>
            </button>
          ) : (
            <div className="flashcard-ratings" role="group" aria-label="How well did you remember?">
              {FLASHCARD_RATINGS.map((item) => (
                <button key={item.rating} type="button" className={`flashcard-rating is-${item.label.toLowerCase()}`} onClick={() => void grade(item.rating)}>
                  <span className="flashcard-rating-label">{item.label}</span>
                  <span className="flashcard-rating-interval">{preview ? formatInterval(preview[item.rating] - Date.now()) : ""}</span>
                  <kbd>{item.key}</kbd>
                </button>
              ))}
            </div>
          )}
          <div className="flashcard-minor">
            <button type="button" onClick={takeBack} disabled={!lastAnswer} title="Take back your last answer (Z)">Undo</button>
            <button type="button" onClick={skipSuspend} title="Stop showing this card until you turn it back on">Suspend card</button>
          </div>
        </div>
      ) : null}
      {flashcards.store.saveError ? <p className="flashcard-review-warning" role="alert">This device couldn't store your last answer ({flashcards.store.saveError}). It is still sent to your account while this window stays open.</p> : null}
    </div>
  );
}
