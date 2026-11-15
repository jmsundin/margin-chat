import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import {
  fetchWiktionary, googleTranslateUrl, languageName, wiktionaryUrl,
  type DocumentLanguageLearning, type LanguagePair, type LookupAnswer, type WiktionarySense,
} from "../lib/languageLearning";
import {
  MAX_PHRASE_WORDS, READER_FONTS, READER_SIZES, READER_THEMES, STATUS_LABELS, findPhrases, isLearning, isMarked, loadReaderLook, paginate,
  readerParagraphs, saveReaderLook, termId, type ReaderLook, type ReaderSentence, type TermStatus,
} from "../lib/languageReader";
import { deviceCanSpeak, speak, stopSpeaking } from "../lib/languageSpeech";
import { formatTimestamp, type MediaEmbed } from "../lib/documentMedia";
import { lessonAudioOf, sentenceAtTime, sentenceTimes } from "../lib/languageLessons";
import { useVaultMedia } from "../lib/vaultMedia";
import "./LanguageReader.css";

/** The word or words a card is open on: a sentence and a run of its words. */
interface OpenTerm { sentence: number; from: number; to: number; key: string; display: string; nonce: number }

interface Props {
  blocks: ReadonlyArray<{ id: string; content: string }>;
  pair: LanguagePair;
  learning: DocumentLanguageLearning;
  /** Opens the app's own menu for a passage (note, Ask AI) on the term or its sentence. */
  onAskInMargin?: (request: { blockId: string; term: string; sentence: string; rect: { left: number; top: number; width: number; height: number } }) => void;
}

const STATUS_CLASS: Record<number, string> = { 0: "is-new", 1: "is-l1", 2: "is-l2", 3: "is-l3", 4: "is-familiar" };
const answers = new Map<string, LookupAnswer>();
const AUDIO_RATES = [1, 0.85, 0.7, 1.25];

/** A lesson's recording as something an audio element can play: a vault file is read into an object URL. */
function useLessonAudio(embed: MediaEmbed | null): { url?: string; status: "none" | "loading" | "ready" | "missing"; message?: string } {
  const media = useVaultMedia();
  const target = embed?.source === "vault" ? embed.target : null;
  const [state, setState] = useState<{ url?: string; status: "loading" | "ready" | "missing"; message?: string }>({ status: "loading" });
  useEffect(() => {
    if (!target) return undefined;
    if (!media) { setState({ status: "missing" }); return undefined; }
    let url: string | undefined;
    let cancelled = false;
    setState({ status: "loading" });
    media.read(target).then((file) => {
      if (cancelled) return;
      if (!file) { setState({ status: "missing" }); return; }
      url = URL.createObjectURL(file.blob);
      setState({ status: "ready", url });
    }, (error: unknown) => { if (!cancelled) setState({ status: "missing", message: error instanceof Error ? error.message : undefined }); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [media, target]);
  if (!embed) return { status: "none" };
  return target ? state : { status: "ready", url: embed.target.split("#")[0] };
}
const isPhone = () => typeof matchMedia !== "undefined" && matchMedia("(max-width: 700px), (pointer: coarse)").matches;

/**
 * Language learning mode's reading surface. Every word shows how well the
 * reader knows it; a tap opens its card, a drag makes a phrase, and the arrow
 * keys walk the words being learned.
 */
export function LanguageReader({ blocks, pair, learning, onAskInMargin }: Props) {
  const language = pair.target;
  const paragraphs = useMemo(() => readerParagraphs(blocks, language), [blocks, language]);
  const pages = useMemo(() => paginate(paragraphs), [paragraphs]);
  const sentences = useMemo(() => paragraphs.flatMap((paragraph) => paragraph.sentences), [paragraphs]);
  const blockOfSentence = useMemo(() => new Map(paragraphs.flatMap((paragraph) => paragraph.sentences.map((sentence) => [sentence.index, paragraph.blockId] as const))), [paragraphs]);
  const pageOfSentence = useMemo(() => new Map(pages.flatMap((page, index) => page.flatMap((paragraph) => paragraph.sentences.map((sentence) => [sentence.index, index] as const)))), [pages]);

  const [pageIndex, setPageIndex] = useState(0);
  const page = Math.min(pageIndex, pages.length - 1);
  const [view, setView] = useState<"page" | "focus">("page");
  const [focusIndex, setFocusIndex] = useState(0);
  const [open, setOpen] = useState<OpenTerm | null>(null);
  const [picking, setPicking] = useState<{ sentence: number; from: number; to: number } | null>(null);
  const [look, setLook] = useState<ReaderLook>(loadReaderLook);
  const [lookOpen, setLookOpen] = useState(false);
  const [speaking, setSpeaking] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // ----- a lesson's own recording -----
  const audioEmbed = useMemo(() => lessonAudioOf(blocks), [blocks]);
  const audioFile = useLessonAudio(audioEmbed);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audio, setAudio] = useState({ playing: false, time: 0, duration: 0 });
  const [audioRate, setAudioRate] = useState(1);
  /** Playing one sentence stops where the next begins. */
  const stopAt = useRef<number | null>(null);
  const times = useMemo(() => sentenceTimes(paragraphs, audio.duration || null), [paragraphs, audio.duration]);
  const timeOfSentence = useMemo(() => new Map(times.map((time) => [time.index, time] as const)), [times]);
  const hasAudio = Boolean(audioEmbed && audioFile.url);

  const statusOf = useCallback((key: string): TermStatus => learning.terms.get(termId(language, key))?.status ?? 0, [learning.terms, language]);
  const phraseKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const term of learning.terms.values()) if (term.language === language && term.key.includes(" ") && term.status !== 0 && term.status !== -1) keys.add(term.key);
    return keys;
  }, [learning.terms, language]);
  const counts = useMemo(() => {
    let known = 0, learningCount = 0;
    for (const term of learning.terms.values()) { if (term.language !== language) continue; if (term.status === 5) known++; else if (isLearning(term.status)) learningCount++; }
    return { known, learning: learningCount };
  }, [learning.terms, language]);

  const visible = useMemo(() => view === "focus" ? (sentences[focusIndex] ? [sentences[focusIndex]] : []) : pages[page].flatMap((paragraph) => paragraph.sentences), [view, sentences, focusIndex, pages, page]);

  useEffect(() => () => stopSpeaking(), []);
  useEffect(() => { setOpen(null); }, [language]);
  useEffect(() => { if (focusIndex >= sentences.length && sentences.length) setFocusIndex(sentences.length - 1); }, [focusIndex, sentences.length]);

  const stopReading = useCallback(() => { stopSpeaking(); audioRef.current?.pause(); stopAt.current = null; setSpeaking(null); }, []);

  function playAudio(from?: number, until?: number) {
    const element = audioRef.current;
    if (!element) return;
    stopSpeaking();
    setOpen(null);
    if (from !== undefined) element.currentTime = from;
    stopAt.current = until ?? null;
    element.playbackRate = audioRate;
    void element.play().catch(() => undefined);
  }
  function onAudioDuration(seconds: number) {
    const duration = Number.isFinite(seconds) ? seconds : 0;
    setAudio((current) => current.duration === duration ? current : { ...current, duration });
  }
  function onAudioTime() {
    const element = audioRef.current;
    if (!element) return;
    if (stopAt.current !== null && element.currentTime >= stopAt.current) { element.pause(); stopAt.current = null; }
    const now = element.currentTime;
    setAudio((current) => ({ ...current, time: now }));
    if (element.paused) return;
    const index = sentenceAtTime(times, element.currentTime);
    setSpeaking(index);
    if (index === null) return;
    // The page turns with the recording; Focus view moves on to the sentence being spoken.
    if (view === "focus") { if (stopAt.current === null && index !== focusIndex) setFocusIndex(index); }
    else { const target = pageOfSentence.get(index); if (target !== undefined && target !== page) setPageIndex(target); }
  }
  function changeRate() {
    const next = AUDIO_RATES[(AUDIO_RATES.indexOf(audioRate) + 1) % AUDIO_RATES.length];
    setAudioRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }
  /** Listen to one sentence: from the recording when it has one, else a voice reads it. */
  function listenTo(sentence: ReaderSentence, slow = false) {
    const time = hasAudio ? timeOfSentence.get(sentence.index) : undefined;
    if (!time) { audioRef.current?.pause(); speak(sentence.text, language, { slow }); return; }
    if (audioRef.current) audioRef.current.playbackRate = slow ? 0.7 : audioRate;
    playAudio(time.start, time.end);
    if (slow && audioRef.current) audioRef.current.playbackRate = 0.7;
  }

  function openRange(sentence: ReaderSentence, from: number, to: number, focusCard = true) {
    const words = sentence.tokens.filter((token) => token.key !== undefined);
    const first = sentence.tokens.findIndex((token) => token.word === from);
    const last = sentence.tokens.findIndex((token) => token.word === to);
    if (first < 0 || last < 0) return;
    stopReading();
    setLookOpen(false);
    setPicking(null);
    setOpen({
      sentence: sentence.index, from, to, key: words.slice(from, to + 1).map((token) => token.key).join(" "),
      display: sentence.tokens.slice(first, last + 1).map((token) => token.text).join("").trim(), nonce: Date.now(),
    });
    if (focusCard) requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(".language-term-card")?.focus({ preventScroll: true }));
  }

  /** The saved phrase a word is part of, if any, as a run of words. */
  function phraseAround(sentence: ReaderSentence, word: number) {
    const keys = sentence.tokens.filter((token) => token.key !== undefined).map((token) => token.key as string);
    return findPhrases(keys, (key) => phraseKeys.has(key)).find((match) => word >= match.from && word < match.from + match.length) ?? null;
  }

  // ----- pointer: a click opens a word, a drag makes a phrase; on touch a press-and-hold starts the drag and a swipe turns the page -----
  const drag = useRef<{ id: number; x: number; y: number; sentence: number; word: number; touch: boolean; active: boolean; held: boolean; moved: boolean; timer: number; to: number } | null>(null);
  const wordFrom = (target: EventTarget | null) => {
    const element = target instanceof Element ? target.closest<HTMLElement>("[data-lr-word]") : null;
    return element ? { sentence: Number(element.dataset.lrSentence), word: Number(element.dataset.lrWord) } : null;
  };
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const at = wordFrom(event.target);
    const touch = event.pointerType !== "mouse";
    const state = { id: event.pointerId, x: event.clientX, y: event.clientY, sentence: at?.sentence ?? -1, word: at?.word ?? -1, touch, active: !touch, held: false, moved: false, timer: 0, to: at?.word ?? -1 };
    if (touch && at) state.timer = window.setTimeout(() => {
      if (drag.current !== state || state.moved) return;
      state.held = true; state.active = true;
      setPicking({ sentence: at.sentence, from: at.word, to: at.word });
    }, 380);
    drag.current = state;
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    if (Math.abs(event.clientX - state.x) > 6 || Math.abs(event.clientY - state.y) > 6) state.moved = true;
    if (!state.active || state.sentence < 0) return;
    const at = wordFrom(document.elementFromPoint(event.clientX, event.clientY));
    if (!at || at.sentence !== state.sentence) return;
    // A phrase is at most a handful of words, counted from where the drag began.
    const to = Math.max(state.word - (MAX_PHRASE_WORDS - 1), Math.min(state.word + MAX_PHRASE_WORDS - 1, at.word));
    if (to === state.to) return;
    state.to = to;
    if (to !== state.word || state.held) setPicking({ sentence: state.sentence, from: Math.min(state.word, to), to: Math.max(state.word, to) });
  }
  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    window.clearTimeout(state.timer);
    drag.current = null;
    const dx = event.clientX - state.x, dy = event.clientY - state.y;
    if (state.touch && !state.held && view === "page" && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { turnPage(dx < 0 ? 1 : -1); return; }
    if (state.sentence < 0 || (state.touch && state.moved && !state.held)) { setPicking(null); return; }
    const sentence = sentences[state.sentence];
    if (!sentence) return;
    if (state.to !== state.word) { openRange(sentence, Math.min(state.word, state.to), Math.max(state.word, state.to)); return; }
    openRange(sentence, state.word, state.word);
  }
  function onPointerCancel() { if (drag.current) window.clearTimeout(drag.current.timer); drag.current = null; setPicking(null); }

  // A press outside the card and the text closes the card.
  useEffect(() => {
    if (!open && !lookOpen) return undefined;
    const outside = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".language-term-card, .language-reader-look, [data-lr-word], .language-reader-bar, .language-reader-top")) return;
      setOpen(null); setLookOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, lookOpen]);

  function turnPage(direction: number) {
    const next = page + direction;
    if (next < 0 || next >= pages.length) return false;
    stopReading(); setOpen(null); setPageIndex(next);
    rootRef.current?.scrollIntoView({ block: "start" });
    return true;
  }

  // ----- keyboard -----
  /** The marked terms on screen in reading order: a saved phrase counts once. */
  function markedTerms(list: ReaderSentence[]) {
    const stops: Array<{ sentence: ReaderSentence; from: number; to: number }> = [];
    for (const sentence of list) {
      const keys = sentence.tokens.filter((token) => token.key !== undefined).map((token) => token.key as string);
      const phrases = findPhrases(keys, (key) => phraseKeys.has(key));
      for (let word = 0; word < keys.length; word++) {
        const phrase = phrases.find((match) => match.from === word);
        if (phrase) { stops.push({ sentence, from: word, to: word + phrase.length - 1 }); word += phrase.length - 1; continue; }
        if (isMarked(statusOf(keys[word]))) stops.push({ sentence, from: word, to: word });
      }
    }
    return stops;
  }
  function step(direction: 1 | -1) {
    if (view === "focus") {
      const next = focusIndex + direction;
      if (next >= 0 && next < sentences.length) { stopReading(); setOpen(null); setFocusIndex(next); }
      return;
    }
    const stops = markedTerms(visible);
    const position = open ? stops.findIndex((stop) => stop.sentence.index === open.sentence && stop.from <= open.from && stop.to >= open.from) : -1;
    let next: number;
    if (position >= 0) next = position + direction;
    else if (open) {
      const before = stops.filter((stop) => stop.sentence.index < open.sentence || (stop.sentence.index === open.sentence && stop.to < open.from)).length;
      next = direction > 0 ? before : before - 1;
    } else next = direction > 0 ? 0 : stops.length - 1;
    if (next >= 0 && next < stops.length) { const stop = stops[next]; openRange(stop.sentence, stop.from, stop.to); return; }
    // Past the last marked term on a page, the arrow goes on to the next page's first one.
    const target = page + direction;
    if (target < 0 || target >= pages.length) return;
    const onNext = markedTerms(pages[target].flatMap((paragraph) => paragraph.sentences));
    turnPage(direction);
    const stop = direction > 0 ? onNext[0] : onNext[onNext.length - 1];
    if (stop) openRange(stop.sentence, stop.from, stop.to);
  }
  function rate(status: TermStatus) {
    if (!open) return;
    learning.setTerm(language, open.key, { status, docId: learning.docId });
  }
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Typing a meaning or a tag is typing, not shortcuts. Escape leaves the field first.
    if (target.closest("textarea, input, select")) { if (event.key === "Escape") { event.preventDefault(); rootRef.current?.querySelector<HTMLElement>(".language-term-card")?.focus(); } return; }
    const onControl = Boolean(target.closest("button, a"));
    if (event.key === "Escape") { if (lookOpen) setLookOpen(false); else if (open) { setOpen(null); rootRef.current?.focus({ preventScroll: true }); } else return; event.preventDefault(); return; }
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); step(event.key === "ArrowRight" ? 1 : -1); return; }
    if (event.key === " " && !onControl) { event.preventDefault(); togglePlay(); return; }
    if (!open) return;
    if (/^[1-4]$/u.test(event.key)) { event.preventDefault(); rate(Number(event.key) as TermStatus); return; }
    if ((event.key === "k" || event.key === "K" || event.key === "Enter") && !onControl) { event.preventDefault(); rate(5); return; }
    if (event.key === "x" || event.key === "X") { event.preventDefault(); rate(-1); return; }
    if (event.key === "Tab") {
      // The card keeps the Tab key while it's open.
      const card = rootRef.current?.querySelector<HTMLElement>(".language-term-card");
      const stops = card ? [...card.querySelectorAll<HTMLElement>('button:not([tabindex="-1"]), textarea, a[href], input')].filter((element) => element.offsetParent) : [];
      if (!card || !stops.length) return;
      const at = stops.indexOf(document.activeElement as HTMLElement);
      if (at === -1 || (event.shiftKey && at === 0) || (!event.shiftKey && at === stops.length - 1)) { event.preventDefault(); stops[event.shiftKey ? stops.length - 1 : 0].focus(); }
    }
  }

  // ----- reading aloud -----
  function readFrom(list: ReaderSentence[], at: number) {
    if (at >= list.length) { setSpeaking(null); return; }
    setSpeaking(list[at].index);
    rootRef.current?.querySelector(`[data-lr-sentence-row="${list[at].index}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    speak(list[at].text, language, { onEnd: () => readFrom(list, at + 1) });
  }
  function togglePlay() {
    if (hasAudio) {
      if (audio.playing) { stopReading(); return; }
      const focused = view === "focus" ? timeOfSentence.get(sentences[focusIndex]?.index ?? -1) : undefined;
      // In Focus view the recording picks up at the sentence on screen.
      if (focused && (audio.time < focused.start - 0.2 || audio.time >= focused.end)) playAudio(focused.start);
      else playAudio();
      return;
    }
    if (speaking !== null) { stopReading(); return; }
    setOpen(null);
    readFrom(visible, 0);
  }

  function changeView(next: "page" | "focus") {
    if (next === view) return;
    stopReading(); setOpen(null);
    if (next === "focus") { const first = pages[page][0]?.sentences[0]?.index ?? 0; if ((pageOfSentence.get(focusIndex) ?? -1) !== page) setFocusIndex(first); }
    else setPageIndex(pageOfSentence.get(focusIndex) ?? page);
    setView(next);
  }
  function changeLook(next: ReaderLook) { setLook(next); saveReaderLook(next); }

  function renderSentence(sentence: ReaderSentence) {
    const keys = sentence.tokens.filter((token) => token.key !== undefined).map((token) => token.key as string);
    const phrases = findPhrases(keys, (key) => phraseKeys.has(key));
    const selected = open?.sentence === sentence.index ? open : null;
    const picked = picking?.sentence === sentence.index ? picking : null;
    const nodes: JSX.Element[] = [];
    let run: { nodes: JSX.Element[]; until: number; key: string } | null = null;
    sentence.tokens.forEach((token, index) => {
      let node: JSX.Element;
      if (token.key === undefined) node = <span key={index}>{token.text}</span>;
      else {
        const word = token.word as number;
        const status = statusOf(token.key);
        const isOpen = selected !== null && word >= selected.from && word <= selected.to;
        const isPicked = picked !== null && word >= picked.from && word <= picked.to;
        const marked = isMarked(status) && !run && !phrases.some((match) => match.from === word);
        node = <span key={index} className={`language-word ${STATUS_CLASS[status] ?? ""}${isOpen ? " is-open" : ""}${isPicked ? " is-picked" : ""}`}
          data-lr-word={word} data-lr-sentence={sentence.index} data-status={status} tabIndex={marked ? -1 : undefined}>{token.text}</span>;
        const phrase = phrases.find((match) => match.from === word);
        if (phrase) run = { nodes: [], until: word + phrase.length - 1, key: phrase.key };
      }
      if (!run) { nodes.push(node); return; }
      run.nodes.push(node);
      if (token.word === run.until) {
        const status = statusOf(run.key);
        const whole = selected !== null && selected.key === run.key;
        nodes.push(<span key={`p${index}`} className={`language-phrase ${STATUS_CLASS[status] ?? ""}${whole ? " is-open" : ""}`} data-lr-phrase={run.key}>{run.nodes}</span>);
        run = null;
      }
    });
    if (run) nodes.push(...(run as { nodes: JSX.Element[] }).nodes);
    return nodes;
  }

  const openSentence = open ? sentences[open.sentence] : undefined;
  const style = { "--lr-size": `${READER_SIZES[look.size - 1]}px`, "--lr-font": READER_FONTS[look.font].stack } as CSSProperties;
  const position = view === "focus" ? (focusIndex + 1) / Math.max(1, sentences.length) : (page + 1) / pages.length;

  return <div ref={rootRef} className="language-reader" data-theme={look.theme === "system" ? undefined : look.theme} data-view={view} style={style} tabIndex={-1}
    onKeyDown={onKeyDown} role="group" aria-label={`Reading in ${languageName(language)}`}>
    <div className="language-reader-top">
      <span className="language-reader-count" title="Words and phrases you've marked known"><b>{counts.known}</b> known</span>
      <span className="language-reader-page">{view === "focus" ? `Sentence ${Math.min(focusIndex + 1, sentences.length)} of ${sentences.length}` : pages.length > 1 ? `Page ${page + 1} of ${pages.length}` : ""}</span>
      <button type="button" className="language-reader-aa" aria-label="Theme and font" aria-expanded={lookOpen} onClick={() => { setOpen(null); setLookOpen((value) => !value); }}>Aa</button>
    </div>
    <div className="language-reader-progress" role="progressbar" aria-label="Place in the document" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(position * 100)}><i style={{ width: `${position * 100}%` }} /></div>
    {lookOpen ? <LookPanel look={look} onChange={changeLook} /> : null}

    <div className="language-reader-text" lang={language} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
      onContextMenu={(event) => { if (event.target instanceof Element && event.target.closest("[data-lr-word]") && isPhone()) event.preventDefault(); }}>
      {!sentences.length ? <p className="language-reader-empty" lang="en">There's no text to read here yet. Switch to Live Preview to write or paste some.</p> : null}
      {view === "page" ? <>
        {page > 0 ? <button type="button" className="language-reader-turn is-prev" aria-label="Previous page" onClick={() => turnPage(-1)}>‹</button> : null}
        {page < pages.length - 1 ? <button type="button" className="language-reader-turn is-next" aria-label="Next page" onClick={() => turnPage(1)}>›</button> : null}
        {pages[page].map((paragraph) => {
          const Tag = paragraph.heading ? (`h${paragraph.heading + 1}` as "h2" | "h3" | "h4") : "p";
          return <Tag key={paragraph.id} className={`language-reader-paragraph${paragraph.time !== undefined && hasAudio ? " has-time" : ""}`}>
            {paragraph.time !== undefined && hasAudio ? <button type="button" className="language-reader-time" lang="en" aria-label={`Play from ${formatTimestamp(paragraph.time)}`}
              onClick={() => playAudio(paragraph.time)}>{formatTimestamp(paragraph.time)}</button> : null}
            {paragraph.sentences.map((sentence) => <span key={sentence.index} data-lr-sentence-row={sentence.index} className={speaking === sentence.index ? "is-speaking" : undefined}>{renderSentence(sentence)}</span>)}
          </Tag>;
        })}
      </> : sentences[focusIndex] ? <FocusSentence key={focusIndex} sentence={sentences[focusIndex]} pair={pair} learning={learning} canBack={focusIndex > 0} canNext={focusIndex < sentences.length - 1}
        onStep={step} onListen={(slow) => listenTo(sentences[focusIndex], slow)}>{renderSentence(sentences[focusIndex])}</FocusSentence> : null}
    </div>

    <div className="language-reader-bar">
      {audioEmbed ? <audio ref={audioRef} src={audioFile.url} preload="metadata" hidden
        onLoadedMetadata={(event) => onAudioDuration(event.currentTarget.duration)} onDurationChange={(event) => onAudioDuration(event.currentTarget.duration)}
        onTimeUpdate={onAudioTime} onPlay={() => setAudio((current) => ({ ...current, playing: true }))}
        onPause={() => { setAudio((current) => ({ ...current, playing: false })); setSpeaking(null); }}
        onEnded={() => { setAudio((current) => ({ ...current, playing: false })); setSpeaking(null); }} /> : null}
      <button type="button" className="language-reader-play" disabled={Boolean(audioEmbed) && !hasAudio && audioFile.status === "loading"}
        aria-label={hasAudio ? (audio.playing ? "Pause the recording" : "Play the recording") : speaking !== null ? "Stop reading aloud" : view === "focus" ? "Read this sentence aloud" : "Read this page aloud"} onClick={togglePlay}>
        {(hasAudio ? audio.playing : speaking !== null) ? "❚❚" : "▶"}</button>
      {hasAudio ? <div className="language-reader-audio">
        <input type="range" min={0} max={Math.max(1, Math.round(audio.duration))} step={1} value={Math.min(Math.round(audio.time), Math.max(1, Math.round(audio.duration)))}
          aria-label="Place in the recording" aria-valuetext={`${formatTimestamp(audio.time)} of ${formatTimestamp(audio.duration)}`}
          onChange={(event) => { const element = audioRef.current; if (!element) return; stopAt.current = null; const to = Number(event.target.value); element.currentTime = to; setAudio((current) => ({ ...current, time: to })); }} />
        <span className="language-reader-audio-time">{formatTimestamp(audio.time)} / {formatTimestamp(audio.duration)}</span>
        <button type="button" className="language-reader-rate" aria-label={`Playing speed ${audioRate}×. Change speed`} onClick={changeRate}>{audioRate}×</button>
      </div> : audioEmbed && audioFile.status !== "loading" ? <span className="language-reader-audio-missing" role="status">{audioFile.message ?? "The recording isn't in your vault on this device."}</span> : null}
      <div className="language-reader-views" role="group" aria-label="View">
        <button type="button" aria-pressed={view === "page"} onClick={() => changeView("page")}>Page</button>
        <button type="button" aria-pressed={view === "focus"} onClick={() => changeView("focus")}>Focus</button>
      </div>
      <span className="language-reader-learning" title="Words and phrases rated 1 to 3. The ones with a meaning are cards in Review."><b>{counts.learning}</b> learning</span>
    </div>

    {open && openSentence ? <TermCard key={`${open.sentence}:${open.from}:${open.to}:${open.nonce}`} open={open} sentence={openSentence} pair={pair} learning={learning}
      status={statusOf(open.key)} exists={learning.terms.has(termId(language, open.key))}
      partOf={open.from === open.to ? phraseAround(openSentence, open.from) : null}
      onPhrase={(match) => openRange(openSentence, match.from, match.from + match.length - 1)}
      onRate={rate} onClose={() => { setOpen(null); rootRef.current?.focus({ preventScroll: true }); }}
      onAsk={onAskInMargin ? () => {
        const element = rootRef.current?.querySelector(`[data-lr-sentence="${open.sentence}"][data-lr-word="${open.from}"]`);
        const box = element?.getBoundingClientRect();
        const blockId = blockOfSentence.get(open.sentence);
        if (!blockId) return;
        setOpen(null);
        onAskInMargin({ blockId, term: open.display, sentence: openSentence.text, rect: { left: box?.left ?? 0, top: box?.top ?? 0, width: box?.width ?? 0, height: box?.height ?? 0 } });
      } : undefined} rootRef={rootRef} /> : null}
  </div>;
}

function LookPanel({ look, onChange }: { look: ReaderLook; onChange: (look: ReaderLook) => void }) {
  return <div className="language-reader-look" role="dialog" aria-label="Theme and font">
    <h4>Background</h4>
    <div className="language-reader-swatches">
      {READER_THEMES.map((theme) => <button key={theme.id} type="button" aria-pressed={look.theme === theme.id} onClick={() => onChange({ ...look, theme: theme.id })}>
        <i data-swatch={theme.id} />{theme.name}</button>)}
    </div>
    <h4>Text size</h4>
    <label className="language-reader-size"><span>A</span>
      <input type="range" min={1} max={READER_SIZES.length} step={1} value={look.size} aria-label="Text size" onChange={(event) => onChange({ ...look, size: Number(event.target.value) })} />
      <span className="is-big">A</span></label>
    <h4>Font</h4>
    <div className="language-reader-fonts">
      {READER_FONTS.map((font, index) => <button key={font.name} type="button" aria-pressed={look.font === index} onClick={() => onChange({ ...look, font: index })}>
        <b style={{ fontFamily: font.stack }}>Aa</b><small>{font.name}</small></button>)}
    </div>
    <p className="language-reader-look-note">Saved on this device.</p>
  </div>;
}

/** Focus view: one sentence at a time, large, with its audio and, on request, what it means. */
function FocusSentence({ sentence, pair, learning, canBack, canNext, onStep, onListen, children }: {
  sentence: ReaderSentence; pair: LanguagePair; learning: DocumentLanguageLearning; canBack: boolean; canNext: boolean; onStep: (direction: 1 | -1) => void;
  onListen: (slow: boolean) => void; children: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [translation, setTranslation] = useState<{ state: "idle" | "loading" | "done" | "failed"; text: string }>({ state: "idle", text: "" });
  useEffect(() => {
    if (!shown) return undefined;
    const cacheKey = `${pair.target}>${pair.base}|sentence|${sentence.text}`;
    const cached = attempt === 0 ? answers.get(cacheKey) : undefined;
    if (cached) { setTranslation({ state: "done", text: cached.meaning }); return undefined; }
    const controller = new AbortController();
    setTranslation({ state: "loading", text: "" });
    learning.lookUp({ text: sentence.text, sentence: "", pair }, controller.signal).then(
      (answer) => { if (controller.signal.aborted) return; answers.set(cacheKey, answer); setTranslation({ state: "done", text: answer.meaning }); },
      (error: unknown) => { if (!controller.signal.aborted) setTranslation({ state: "failed", text: error instanceof Error && error.message ? error.message : "The translation couldn't be made. Try again." }); });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, attempt]);
  return <div className="language-reader-focus">
    <div className="language-reader-focus-tools" lang="en">
      <button type="button" onClick={() => onListen(false)}>Listen</button>
      <button type="button" onClick={() => onListen(true)}>Slowly</button>
      <span />
      {learning.aiAllowed ? <button type="button" aria-pressed={shown} onClick={() => setShown((value) => !value)}>{shown ? "Hide translation" : "Show translation"}</button> : null}
    </div>
    <div className="language-reader-focus-stage">
      <button type="button" className="language-reader-turn" aria-label="Previous sentence" disabled={!canBack} onClick={() => onStep(-1)}>‹</button>
      <p className="language-reader-focus-sentence" data-lr-sentence-row={sentence.index}>{children}</p>
      <button type="button" className="language-reader-turn" aria-label="Next sentence" disabled={!canNext} onClick={() => onStep(1)}>›</button>
    </div>
    {shown ? <p className="language-reader-translation" lang={pair.base}>
      {translation.state === "loading" ? <span role="status">Translating…</span> : translation.state === "failed" ? <span role="alert">{translation.text}</span> : <i>{translation.text}</i>}
      {translation.state !== "loading" ? <button type="button" aria-label="Translate again" title="Translate again" onClick={() => setAttempt((value) => value + 1)}>↻</button> : null}
    </p> : null}
  </div>;
}

type Suggestion = { state: "idle" } | { state: "loading" } | { state: "done"; answer: LookupAnswer } | { state: "failed"; message: string };

/** What the reader knows about one word or phrase, and how well: its meaning, a suggestion in context, and the rating. */
function TermCard({ open, sentence, pair, learning, status, exists, partOf, onPhrase, onRate, onClose, onAsk, rootRef }: {
  open: OpenTerm; sentence: ReaderSentence; pair: LanguagePair; learning: DocumentLanguageLearning; status: TermStatus; exists: boolean;
  partOf: { from: number; length: number; key: string } | null; onPhrase: (match: { from: number; length: number; key: string }) => void;
  onRate: (status: TermStatus) => void; onClose: () => void; onAsk?: () => void; rootRef: RefObject<HTMLDivElement | null>;
}) {
  const language = pair.target;
  const term = learning.terms.get(termId(language, open.key));
  const isPhrase = open.from !== open.to;
  const [meaning, setMeaning] = useState(term?.meaning ?? "");
  const [saved, setSaved] = useState<"" | "saving" | "saved">("");
  const [expanded, setExpanded] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion>({ state: "idle" });
  const [asked, setAsked] = useState(0);
  const [addingTag, setAddingTag] = useState(false);
  const [wiki, setWiki] = useState<{ senses: WiktionarySense[] | null; failed?: boolean } | null>(null);
  const cacheKey = `${pair.target}>${pair.base}|${open.key}|${sentence.text}`;
  const titleId = `language-term-${open.nonce}`;

  // The meaning saves itself half a second after the typing stops, and at once when the card closes.
  const latest = useRef({ meaning, initial: term?.meaning ?? "", learning, timer: 0, dirty: false });
  latest.current.meaning = meaning; latest.current.learning = learning;
  const commit = useCallback(() => {
    const state = latest.current;
    window.clearTimeout(state.timer);
    if (!state.dirty) return;
    state.dirty = false;
    const text = state.meaning.trim();
    // A phrase that was only dragged across, with nothing typed, is not saved.
    if (!text && !state.learning.terms.has(termId(language, open.key))) return;
    state.learning.setTerm(language, open.key, { meaning: text, docId: state.learning.docId });
    setSaved("saved");
  }, [language, open.key]);
  useEffect(() => () => {
    commit();
    // A meaning for something still being learned is also a card in Review.
    const state = latest.current;
    const text = state.meaning.trim();
    const now = state.learning.terms.get(termId(language, open.key));
    if (text && text !== state.initial.trim() && now && now.status >= 1 && now.status <= 4) {
      state.learning.save({ text: open.display, meaning: text, sentence: sentence.text, pair, from: pair.target });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function type(value: string) {
    setMeaning(value); setSaved("saving");
    const state = latest.current;
    state.meaning = value; state.dirty = true;
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(commit, 500);
  }
  function adopt(value: string) { type(value); commit(); }

  // A suggestion in context: asked for on its own when there's no meaning yet, on request otherwise.
  useEffect(() => {
    if (!learning.aiAllowed) return undefined;
    const cached = answers.get(cacheKey);
    if (cached) { setSuggestion({ state: "done", answer: cached }); return undefined; }
    if (asked === 0 && (term?.meaning ?? "")) return undefined;
    const controller = new AbortController();
    setSuggestion({ state: "loading" });
    // A beat first, so walking past terms with the arrow keys doesn't ask about each one.
    const timer = window.setTimeout(() => {
      learning.lookUp({ text: open.display, sentence: sentence.text === open.display ? "" : sentence.text, pair }, controller.signal).then(
        (answer) => { if (controller.signal.aborted) return; answers.set(cacheKey, answer); setSuggestion({ state: "done", answer }); },
        (error: unknown) => { if (!controller.signal.aborted) setSuggestion({ state: "failed", message: error instanceof Error && error.message ? error.message : "The meaning couldn't be looked up. Try again." }); });
    }, asked ? 0 : 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, cacheKey]);

  // Under the text when there's room, above it otherwise, never past the sides. On phones the card is a sheet.
  const cardRef = useRef<HTMLDivElement>(null);
  const [sheet, setSheet] = useState(isPhone);
  const [place, setPlace] = useState<{ top: number; left: number; maxHeight?: number } | null>(null);
  useLayoutEffect(() => {
    const phone = isPhone();
    if (phone !== sheet) setSheet(phone);
    const card = cardRef.current, root = rootRef.current;
    if (phone || !card || !root) return;
    const words = [...root.querySelectorAll<HTMLElement>(`[data-lr-sentence="${open.sentence}"]`)].filter((element) => { const word = Number(element.dataset.lrWord); return word >= open.from && word <= open.to; });
    if (!words.length) return;
    const rootBox = root.getBoundingClientRect();
    const boxes = words.map((element) => element.getBoundingClientRect());
    const top = Math.min(...boxes.map((box) => box.top)), bottom = Math.max(...boxes.map((box) => box.bottom));
    // The card's full height, whatever height it is held to now: its scrolling part in full, plus the pinned rating row.
    const height = (card.querySelector(".language-term-scroll")?.scrollHeight ?? 0) + (card.querySelector<HTMLElement>(".language-term-foot")?.offsetHeight ?? 0) + 2;
    const width = card.offsetWidth;
    const roomBelow = window.innerHeight - bottom - 14, roomAbove = top - 70;
    let next: { top: number; left: number; maxHeight?: number };
    const left = Math.max(8, Math.min(boxes[0].left - rootBox.left - 14, rootBox.width - width - 8));
    if (height <= roomBelow || roomBelow >= roomAbove) next = { top: bottom - rootBox.top + 6, left, ...(height > roomBelow ? { maxHeight: Math.max(240, roomBelow) } : {}) };
    else { const shownHeight = Math.min(height, roomAbove); next = { top: top - rootBox.top - 6 - shownHeight, left, ...(height > roomAbove ? { maxHeight: roomAbove } : {}) }; }
    if (!place || Math.abs(next.top - place.top) > 1 || Math.abs(next.left - place.left) > 1 || Math.abs((next.maxHeight ?? 0) - (place.maxHeight ?? 0)) > 1) setPlace(next);
  });

  const answer = suggestion.state === "done" ? suggestion.answer : null;
  const tags = term?.tags ?? [];
  const lemma = answer?.lemma && answer.lemma.toLowerCase() !== open.display.toLowerCase() ? answer.lemma : "";
  const draft = isPhrase && !exists;
  const mentions = useMemo(() => expanded ? learning.mentions(open.display).filter((document) => document.id !== learning.docId).slice(0, 5) : [], [expanded, learning, open.display]);
  const lookupWord = lemma && !isPhrase ? lemma : open.display;
  function openWiktionary() {
    if (wiki) { setWiki(null); return; }
    setWiki({ senses: null });
    fetchWiktionary(lookupWord, language).then((senses) => setWiki({ senses }), () => setWiki({ senses: [], failed: true }));
  }

  return <div ref={cardRef} className={`language-term-card${sheet ? " is-sheet" : ""}`} role="dialog" aria-labelledby={titleId} tabIndex={-1} lang="en"
    style={sheet ? undefined : { top: place?.top ?? 0, left: place?.left ?? 0, maxHeight: place?.maxHeight, visibility: place ? undefined : "hidden" }}
    onPointerDown={(event) => event.stopPropagation()}>
    <div className="language-term-scroll">
      <div className="language-term-head">
        {deviceCanSpeak() ? <button type="button" className="language-term-speak" aria-label="Say it" title="Say it" onClick={() => speak(open.display, language)}>🔊</button> : null}
        <h3 id={titleId} lang={language}>{open.display.charAt(0).toLocaleUpperCase() + open.display.slice(1)}</h3>
        <button type="button" className="language-term-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="language-term-tags">
        {isPhrase ? <span>Phrase</span> : null}
        {answer?.partOfSpeech ? <span>{answer.partOfSpeech}</span> : null}
        {lemma ? <span lang={language}>{lemma}</span> : null}
        {tags.map((tag) => <button key={tag} type="button" className="is-mine" title="Remove this tag" onClick={() => learning.setTerm(language, open.key, { tags: tags.filter((item) => item !== tag), docId: learning.docId })}>#{tag} ×</button>)}
        {addingTag ? <input autoFocus aria-label="New tag" placeholder="tag" maxLength={40}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.stopPropagation(); setAddingTag(false); }
            if (event.key === "Enter") { event.preventDefault(); const value = event.currentTarget.value.trim(); if (value) learning.setTerm(language, open.key, { tags: [...tags, value], docId: learning.docId }); setAddingTag(false); }
          }} onBlur={() => setAddingTag(false)} />
          : <button type="button" className="language-term-link" onClick={() => setAddingTag(true)}>Tag +</button>}
      </div>
      <div className="language-term-label"><span>Your meaning</span><span className="language-term-saved" role="status">{saved === "saving" ? "Saving…" : saved === "saved" ? "Saved ✓" : ""}</span></div>
      <label className="language-term-meaning"><span className="language-term-flag" aria-hidden="true">{pair.base.slice(0, 2).toUpperCase()}</span>
        <textarea value={meaning} rows={2} lang={pair.base} aria-label="Your meaning" maxLength={2000}
          placeholder={draft ? "Type a meaning to save this phrase" : "Type a meaning here"} onChange={(event) => type(event.target.value)} onBlur={commit} /></label>

      {!learning.aiAllowed ? <p className="language-term-quiet">This document is hidden from AI, so no AI meaning is asked for. Dictionaries are under More.</p>
        : suggestion.state === "loading" ? <p className="language-term-suggestion" role="status"><span className="language-term-spinner" aria-hidden="true" />Reading the sentence…</p>
        : suggestion.state === "failed" ? <p className="language-term-error" role="alert">{suggestion.message} <button type="button" onClick={() => setAsked((value) => value + 1)}>Try again</button></p>
        : answer ? <div className="language-term-suggestion">
          <span className="language-term-spark" aria-hidden="true">✦</span>
          <span className="language-term-suggested"><b lang={answer.to}>{answer.meaning}</b>{answer.note ? <small>{answer.note}</small> : null}</span>
          <button type="button" className="language-term-add" aria-label="Use this meaning" title="Use this meaning" onClick={() => adopt(answer.meaning)}>+</button>
        </div>
        : <button type="button" className="language-term-link is-ask" onClick={() => setAsked((value) => value + 1)}>✦ What does it mean here?</button>}

      {partOf && partOf.length > 1 ? <p className="language-term-quiet">Part of the phrase <button type="button" className="language-term-link" lang={language} onClick={() => onPhrase(partOf)}>{partOf.key}</button></p> : null}

      {expanded ? <div className="language-term-more">
        {answer?.others.length ? <><h4>Other meanings</h4>
          {answer.others.map((other) => <div key={other} className="language-term-other"><span lang={answer.to}>{other}</span>
            <button type="button" className="language-term-add" aria-label={`Use “${other}”`} onClick={() => adopt(other)}>+</button></div>)}</> : null}
        <h4>Also in your documents</h4>
        {mentions.length ? <div className="language-term-chips">{mentions.map((document) => <button key={document.id} type="button" onClick={() => learning.openDocument(document.id)}>{document.title}</button>)}</div>
          : <p className="language-term-quiet">Not in your other documents yet.</p>}
        <h4>Dictionaries</h4>
        <div className="language-term-chips">
          {open.display.length <= 40 ? <button type="button" aria-expanded={Boolean(wiki)} onClick={openWiktionary}>Wiktionary</button> : null}
          <a href={googleTranslateUrl(open.display, pair.target, pair.base)} target="_blank" rel="noreferrer">Google Translate ↗</a>
        </div>
        {wiki ? <div className="language-term-wiki">
          {wiki.senses === null ? <p role="status">Opening Wiktionary…</p>
            : wiki.senses.length ? wiki.senses.map((sense, index) => <div key={index}>{sense.partOfSpeech ? <p><i>{sense.partOfSpeech}</i></p> : null}
              <ol>{sense.definitions.map((definition, at) => <li key={at}>{definition} <button type="button" className="language-term-add" aria-label="Use this definition" onClick={() => adopt(definition)}>+</button></li>)}</ol></div>)
            : <p>{wiki.failed ? "Wiktionary didn't answer." : `No ${languageName(language)} entry on Wiktionary.`}</p>}
          <a href={wiktionaryUrl(lookupWord, language)} target="_blank" rel="noreferrer">Open on Wiktionary ↗</a>
        </div> : null}
      </div> : null}
    </div>

    <div className="language-term-foot">
      <div className="language-term-status" role="radiogroup" aria-label="How well you know it">
        {([-1, 1, 2, 3, 4, 5] as TermStatus[]).map((value) => <button key={value} type="button" role="radio" data-status={value}
          aria-checked={!draft && status === value} aria-label={value === -1 ? "Ignore" : STATUS_LABELS[value]}
          title={value === -1 ? "Ignore (X)" : value === 5 ? "Known (K)" : `${STATUS_LABELS[value]} (${value})`}
          tabIndex={(!draft && status === value) || ((draft || status === 0) && value === 1) ? 0 : -1}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault(); event.stopPropagation();
            const buttons = [...event.currentTarget.parentElement!.querySelectorAll<HTMLElement>("button")];
            buttons[(buttons.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length].focus();
          }}
          onClick={() => { commit(); onRate(value); }}>{value === -1 ? "⦸" : value === 5 ? "✓" : value}</button>)}
      </div>
      <div className="language-term-scale" aria-hidden="true"><span>Ignore</span><span>Learning</span><span>Familiar · Known</span></div>
      <div className="language-term-actions">
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "⌃ Less" : "⌄ More"}</button>
        {onAsk ? <button type="button" className="is-ask" onClick={() => { commit(); onAsk(); }}>Ask in margin</button> : null}
      </div>
      <p className="language-term-keys" aria-hidden="true"><kbd>←</kbd><kbd>→</kbd> next term · <kbd>1</kbd>–<kbd>4</kbd> rate · <kbd>K</kbd> known · <kbd>X</kbd> ignore · <kbd>Esc</kbd></p>
    </div>
  </div>;
}
