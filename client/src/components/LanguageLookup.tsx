import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  LEARNING_LANGUAGES, fetchWiktionary, googleTranslateUrl, languageName, wiktionaryUrl,
  type DocumentLanguageLearning, type LanguagePair, type LookupAnswer, type WiktionarySense,
} from "../lib/languageLearning";
import "./LanguageLookup.css";

/** Where the pop-up points: the looked-up text, its sentence, and its place in the editor (px from the editor's top left). */
export interface LookupTarget {
  key: number;
  text: string;
  sentence: string;
  top: number;
  /** The line's top, for showing the pop-up above the text when there's no room below. */
  lineTop: number;
  left: number;
}

/** The bar under the view menu in Language learning mode: which language is learned, and which one meanings come in. */
export function LanguageLearningBar({ pair, onChange }: { pair: LanguagePair; onChange: (pair: LanguagePair) => void }) {
  const options = (selected: string) => {
    const list = LEARNING_LANGUAGES.some((language) => language.code === selected) ? LEARNING_LANGUAGES : [...LEARNING_LANGUAGES, { code: selected, name: languageName(selected) }];
    return list.map((language) => <option key={language.code} value={language.code}>{language.name}</option>);
  };
  return <div className="language-learning-bar" role="group" aria-label="Language learning">
    <label>Learning <select value={pair.target} aria-label="Language you're learning"
      onChange={(event) => { const target = event.target.value; onChange({ target, base: target === pair.base ? pair.target : pair.base }); }}>{options(pair.target)}</select></label>
    <span aria-hidden="true" className="language-learning-arrow">→</span>
    <label>meanings in <select value={pair.base} aria-label="Language meanings are shown in"
      onChange={(event) => { const base = event.target.value; onChange({ base, target: base === pair.target ? pair.base : pair.target }); }}>{options(pair.base)}</select></label>
    <span className="language-learning-hint">Tap, click, drag across or select text to see what it means.</span>
  </div>;
}

type Status = { state: "loading" } | { state: "done"; answer: LookupAnswer } | { state: "failed"; message: string };

/** What the looked-up text means: the AI's meaning first, then Wiktionary and Google Translate. */
export function LanguageLookupPopup({ target, pair, learning, onClose, containerWidth }: {
  target: LookupTarget; pair: LanguagePair; learning: DocumentLanguageLearning; onClose: () => void; containerWidth: number;
}) {
  const [status, setStatus] = useState<Status>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [wiki, setWiki] = useState<{ open: boolean; senses: WiktionarySense[] | null; failed?: boolean }>({ open: false, senses: null });
  const saved = learning.savedMeaning(target.text, pair);
  const words = target.text.split(/\s+/u).filter(Boolean).length;
  const shortText = words <= 3 && target.text.length <= 40;

  useEffect(() => {
    const controller = new AbortController();
    setStatus({ state: "loading" }); setChosen(null); setSavedTo(null); setWiki({ open: false, senses: null });
    learning.lookUp({ text: target.text, sentence: target.sentence, pair }, controller.signal).then(
      (answer) => { if (!controller.signal.aborted) setStatus({ state: "done", answer }); },
      (error: unknown) => { if (!controller.signal.aborted) setStatus({ state: "failed", message: error instanceof Error && error.message ? error.message : "The meaning couldn't be looked up. Try again." }); });
    return () => controller.abort();
    // A new target (or Try again) asks again; the pair is part of the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.key, attempt, pair.target, pair.base]);

  const answer = status.state === "done" ? status.answer : null;
  const from = answer?.from ?? pair.target;
  const to = answer?.to ?? pair.base;
  const meaning = chosen ?? answer?.meaning ?? "";

  function openWiktionary() {
    if (wiki.open) { setWiki({ ...wiki, open: false }); return; }
    setWiki({ open: true, senses: wiki.senses });
    if (wiki.senses) return;
    const word = answer?.lemma && words === 1 ? answer.lemma : target.text;
    fetchWiktionary(word, from).then((senses) => setWiki({ open: true, senses }), () => setWiki({ open: true, senses: [], failed: true }));
  }

  function listen() {
    try {
      if (typeof speechSynthesis === "undefined") return;
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(target.text);
      utterance.lang = from;
      speechSynthesis.speak(utterance);
    } catch { /* No voice on this device. */ }
  }

  // Under the text when there's room, above it otherwise; never past the editor's sides.
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ top: number; left: number; maxHeight?: number }>({ top: target.top + 6, left: target.left });
  useLayoutEffect(() => {
    const popup = ref.current;
    const parent = popup?.offsetParent;
    if (!popup || !(parent instanceof HTMLElement)) return;
    const parentTop = parent.getBoundingClientRect().top;
    const height = popup.scrollHeight;
    const below = target.top + 6;
    const roomBelow = window.innerHeight - (parentTop + below) - 8;
    // Leave room for the app's header above the text.
    const roomAbove = parentTop + target.lineTop - 6 - 64;
    let next: { top: number; left: number; maxHeight?: number };
    const left = Math.max(8, Math.min(target.left - 12, containerWidth - popup.offsetWidth - 8));
    if (height <= roomBelow || roomBelow >= roomAbove) next = { top: below, left, ...(height > roomBelow ? { maxHeight: Math.max(220, roomBelow) } : {}) };
    else next = { top: target.lineTop - 6 - Math.min(height, roomAbove), left, ...(height > roomAbove ? { maxHeight: roomAbove } : {}) };
    if (next.top !== placement.top || next.left !== placement.left || next.maxHeight !== placement.maxHeight) setPlacement(next);
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    // Capture: the editor keeps its keys from reaching the window.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const speakable = typeof speechSynthesis !== "undefined";
  return <div ref={ref} className="language-lookup" role="dialog" aria-label={`Meaning of ${target.text}`} style={{ top: placement.top, left: placement.left, maxHeight: placement.maxHeight }}
    onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
    <div className="language-lookup-head">
      <span>{languageName(from)} → {languageName(to)}</span>
      <button type="button" className="language-lookup-close" aria-label="Close" onClick={onClose}>×</button>
    </div>
    <p className="language-lookup-text" lang={from}>{target.text.length > 160 ? `${target.text.slice(0, 160)}…` : target.text}
      {answer && (answer.lemma || answer.partOfSpeech) ? <small> {[answer.lemma && answer.lemma.toLowerCase() !== target.text.toLowerCase() ? `from ${answer.lemma}` : "", answer.partOfSpeech].filter(Boolean).join(" · ")}</small> : null}
    </p>
    {status.state === "loading" ? <p className="language-lookup-loading" role="status">Looking it up…</p> : null}
    {status.state === "failed" ? <p className="language-lookup-error" role="alert">{status.message} <button type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button></p> : null}
    {answer ? <>
      <p className={`language-lookup-meaning${meaning.length > 60 ? " is-long" : ""}`} lang={to}>{meaning}</p>
      {answer.note ? <p className="language-lookup-note">{answer.note}</p> : null}
      {answer.others.length ? <div className="language-lookup-others" aria-label="Other meanings">
        {[answer.meaning, ...answer.others].map((other) => <button key={other} type="button" aria-pressed={meaning === other}
          onClick={() => setChosen(other === answer.meaning ? null : other)}>{other}</button>)}
      </div> : null}
    </> : null}
    {saved && !savedTo ? <p className="language-lookup-saved">You saved: <b>{saved}</b></p> : null}
    <div className="language-lookup-actions">
      {savedTo ? <span className="language-lookup-done" role="status">Saved to {savedTo}, and in Review</span>
        : <button type="button" className="language-lookup-save" disabled={!answer}
          onClick={() => { if (answer) setSavedTo(learning.save({ text: target.text, meaning, sentence: target.sentence, pair, from })); }}>Save meaning</button>}
      {speakable ? <button type="button" onClick={listen} aria-label="Listen" title="Listen">Listen</button> : null}
    </div>
    <div className="language-lookup-sources">
      {shortText && from === pair.target ? <button type="button" aria-expanded={wiki.open} onClick={openWiktionary}>Wiktionary</button> : null}
      <a href={googleTranslateUrl(target.text, from, to)} target="_blank" rel="noreferrer">Google Translate ↗</a>
    </div>
    {wiki.open ? <div className="language-lookup-wiki">
      {wiki.senses === null ? <p role="status">Opening Wiktionary…</p>
        : wiki.senses.length ? wiki.senses.map((sense, index) => <div key={index}>
          {sense.partOfSpeech ? <p className="language-lookup-pos">{sense.partOfSpeech}</p> : null}
          <ol>{sense.definitions.map((definition, at) => <li key={at}>{definition}</li>)}</ol>
        </div>)
        : <p>{wiki.failed ? "Wiktionary didn't answer." : `No ${languageName(from)} entry on Wiktionary.`}</p>}
      <a href={wiktionaryUrl(answer?.lemma && words === 1 ? answer.lemma : target.text, from)} target="_blank" rel="noreferrer">Open on Wiktionary ↗</a>
    </div> : null}
  </div>;
}
