import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import {
  googleTranslateUrl, languageName, wiktionaryFrameUrl, wiktionaryUrl,
  type DictionaryLookup, type DictionarySense, type DocumentLanguageLearning, type LanguagePair, type LookupAnswer, type PartialLookup,
} from "../lib/languageLearning";
import {
  MAX_PHRASE_WORDS, READER_FONTS, READER_SIZES, READER_THEMES, STATUS_LABELS, findPhrases, isLearning, isMarked, loadReaderLook, paginate,
  readerParagraphs, saveReaderLook, termId, type MeaningSource, type ReaderLook, type ReaderSentence, type TermStatus,
} from "../lib/languageReader";
import { deviceCanSpeak, speak, stopSpeaking } from "../lib/languageSpeech";
import { formatTimestamp, type MediaEmbed } from "../lib/documentMedia";
import { lessonAudioOf, sentenceAtTime, sentenceTimes } from "../lib/languageLessons";
import { useVaultMedia } from "../lib/vaultMedia";
import { wordsToMarkKnown } from "@margin-chat/workspace-contracts/languageCourses";
import { AUTO_KNOWN_EXPLAINED_KEY, AUTO_KNOWN_KEY, autoKnownExplained, autoMarkKnown } from "../lib/languageCourses";
import { writeSyncedSetting } from "../lib/interfaceSettings";
import "./LanguageReader.css";

/** The word or words a card is open on: a sentence and a run of its words. */
interface OpenTerm { sentence: number; from: number; to: number; key: string; display: string; nonce: number }

interface Props {
  blocks: ReadonlyArray<{ id: string; content: string }>;
  pair: LanguagePair;
  learning: DocumentLanguageLearning;
  /** Opens the app's own menu for a passage (note, Ask AI) on the term or its sentence. */
  onAskInMargin?: (request: { blockId: string; term: string; sentence: string; rect: { left: number; top: number; width: number; height: number } }) => void;
  /** Set when the text is a course lesson: shorter pages, a place kept, a translation per sentence and a Complete lesson button. */
  lesson?: ReaderLesson;
}

/** What one sitting with a lesson came to, shown when it's completed. */
export interface LessonSummary { wordsKnown: number; meaningsSaved: number; seconds: number }

export interface ReaderLesson {
  id: string;
  /** One line per sentence, when the lesson has its own translation; Focus view shows it without asking the AI. */
  translations: ReadonlyArray<string> | null;
  /** The sentence the learner stopped at last time. */
  resumeSentence?: number;
  /** Where the learner is now: the first sentence on screen and how far through the lesson that is. */
  onPlace: (place: { sentence: number; percent: number; seconds: number }) => void;
  onComplete: (summary: LessonSummary) => void;
  next?: { title: string; open: () => void } | null;
  onReadAgain?: () => void;
  onClose?: () => void;
}

/** About 150–200 words to a lesson page, as the spec asks; a document's pages are longer. */
export const LESSON_PAGE_WORDS = 175;

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
const PANE_MIN = 320;
const PANE_GAP = 14;
const PANE_WIDTH_KEY = "margin-chat:language-lookup:width";
function loadPaneWidth(): number | null {
  try { const saved = Number(localStorage.getItem(PANE_WIDTH_KEY)); return Number.isFinite(saved) && saved >= PANE_MIN ? saved : null; } catch { return null; }
}

/** Where the lookup pane goes: a column in the free space beside the document, or a sheet under it when there isn't 320px to spare. */
type PanePlace = { mode: "side"; left: number; top: number; width: number; height: number; shift: number; max: number } | { mode: "sheet"; left?: number; width?: number };

/** The nearest ancestor that scrolls, which the pane stands beside. */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

function placePane(root: HTMLElement, wanted: number | null): PanePlace {
  const slot = root.closest<HTMLElement>(".panel-slot") ?? root;
  const box = slot.getBoundingClientRect();
  // Where the document stands when it isn't moved aside, even while that move is still animating.
  const moved = new DOMMatrixReadOnly(getComputedStyle(slot).transform).m41;
  const left = box.left - moved, right = box.right - moved;
  if (window.innerWidth < 768) return { mode: "sheet" };
  const stageBox = (root.closest(".document-workspace-scrolling, .workspace-view") ?? document.documentElement).getBoundingClientRect();
  // Other documents open beside this one keep their place: the pane only takes space nothing else is using.
  let leftLimit = Math.max(0, stageBox.left), rightLimit = Math.min(window.innerWidth, stageBox.right);
  for (const other of document.querySelectorAll<HTMLElement>(".panel-slot, .document-map-pane, .ask-panel")) {
    if (other === slot || other.contains(slot) || slot.contains(other)) continue;
    const rect = other.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if (rect.left >= right - 2) rightLimit = Math.min(rightLimit, rect.left);
    else if (rect.right <= left + 2) leftLimit = Math.max(leftLimit, rect.right);
  }
  const freeRight = Math.max(0, rightLimit - right), freeLeft = Math.max(0, left - leftLimit);
  const max = Math.floor(freeRight + freeLeft - PANE_GAP - 8);
  const sheet: PanePlace = { mode: "sheet", left: Math.round(left), width: Math.round(box.width) };
  if (max < PANE_MIN) return sheet;
  const width = Math.round(Math.max(PANE_MIN, Math.min(wanted ?? Math.min(480, (rightLimit - leftLimit) * 0.4), max)));
  const shift = Math.round(Math.max(0, Math.min(freeLeft, width + PANE_GAP + 8 - freeRight)));
  const scroller = scrollParent(root)?.getBoundingClientRect();
  const top = Math.max(8, Math.round(scroller?.top ?? 0)), bottom = Math.min(window.innerHeight, Math.round(scroller?.bottom ?? window.innerHeight)) - 8;
  return { mode: "side", left: Math.round(right - shift + PANE_GAP), top, width, height: Math.max(280, bottom - top), shift, max };
}
const isPhone = () => typeof matchMedia !== "undefined" && matchMedia("(max-width: 700px), (pointer: coarse)").matches;

/**
 * Language learning mode's reading surface. Every word shows how well the
 * reader knows it; a tap opens its card, a drag makes a phrase, and the arrow
 * keys walk the words being learned.
 */
export function LanguageReader({ blocks, pair, learning, onAskInMargin, lesson }: Props) {
  const language = pair.target;
  const paragraphs = useMemo(() => readerParagraphs(blocks, language), [blocks, language]);
  const pages = useMemo(() => paginate(paragraphs, lesson ? LESSON_PAGE_WORDS : undefined), [paragraphs, lesson ? 1 : 0]);
  const sentences = useMemo(() => paragraphs.flatMap((paragraph) => paragraph.sentences), [paragraphs]);
  const blockOfSentence = useMemo(() => new Map(paragraphs.flatMap((paragraph) => paragraph.sentences.map((sentence) => [sentence.index, paragraph.blockId] as const))), [paragraphs]);
  const pageOfSentence = useMemo(() => new Map(pages.flatMap((page, index) => page.flatMap((paragraph) => paragraph.sentences.map((sentence) => [sentence.index, index] as const)))), [pages]);

  // A lesson opens where it was left.
  const [pageIndex, setPageIndex] = useState(() => (lesson?.resumeSentence ? pageOfSentence.get(lesson.resumeSentence) ?? 0 : 0));
  const page = Math.min(pageIndex, pages.length - 1);
  const [view, setView] = useState<"page" | "focus">("page");
  const [focusIndex, setFocusIndex] = useState(0);
  const [open, setOpen] = useState<OpenTerm | null>(null);
  const [picking, setPicking] = useState<{ sentence: number; from: number; to: number } | null>(null);
  const [look, setLook] = useState<ReaderLook>(loadReaderLook);
  const [lookOpen, setLookOpen] = useState(false);
  const [speaking, setSpeaking] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // ----- this sitting: words newly known, meanings saved and time spent reading -----
  const session = useRef({ known: new Set<string>(), saved: 0, seconds: 0, reported: 0, active: Date.now() });
  const [summary, setSummary] = useState<LessonSummary | null>(null);
  const [knownNotice, setKnownNotice] = useState<{ keys: string[]; explain: boolean } | null>(null);
  useEffect(() => {
    const touch = () => { session.current.active = Date.now(); };
    const root = rootRef.current;
    root?.addEventListener("pointerdown", touch);
    root?.addEventListener("keydown", touch);
    // Time counts while the page is on screen and the reader has been used in the last two minutes.
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - session.current.active < 120_000) session.current.seconds += 15;
    }, 15_000);
    return () => {
      root?.removeEventListener("pointerdown", touch);
      root?.removeEventListener("keydown", touch);
      window.clearInterval(tick);
      const unreported = session.current.seconds - session.current.reported;
      if (unreported > 0) learning.recordStudy?.({ type: "reader_seconds", count: unreported, lessonId: lesson?.id });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (!knownNotice || knownNotice.explain) return undefined; const timer = window.setTimeout(() => setKnownNotice(null), 5000); return () => window.clearTimeout(timer); }, [knownNotice]);

  /** The words of some sentences, each once. */
  const wordsOf = (list: ReadonlyArray<ReaderSentence>) => list.flatMap((sentence) => sentence.tokens.flatMap((token) => token.key ? [token.key] : []));
  function rateMany(keys: string[], status: TermStatus) {
    if (!keys.length) return;
    if (learning.setTerms) learning.setTerms(language, keys, { status, docId: learning.docId });
    else for (const key of keys) learning.setTerm(language, key, { status, docId: learning.docId });
  }
  /** LingQ's rule: words still new when the page is left are words the reader knew. Off in the reader's settings. */
  function finishPage(list: ReadonlyArray<ReaderSentence>, quiet = false) {
    const words = wordsOf(list);
    learning.recordStudy?.({ type: "words_read", count: words.length, lessonId: lesson?.id });
    if (!autoMarkKnown()) return [];
    const keys = wordsToMarkKnown(words, statusOf);
    // A notice is about the page just turned; an earlier one goes.
    if (!keys.length) { setKnownNotice(null); return keys; }
    rateMany(keys, 5);
    keys.forEach((key) => session.current.known.add(key));
    learning.recordStudy?.({ type: "words_known", count: keys.length, lessonId: lesson?.id });
    const explain = !autoKnownExplained();
    if (explain) writeSyncedSetting(AUTO_KNOWN_EXPLAINED_KEY, "1");
    if (explain || !quiet) setKnownNotice({ keys, explain });
    return keys;
  }
  function undoKnown() {
    if (!knownNotice) return;
    rateMany(knownNotice.keys, 0);
    knownNotice.keys.forEach((key) => session.current.known.delete(key));
    learning.recordStudy?.({ type: "words_known", count: -knownNotice.keys.length, lessonId: lesson?.id });
    setKnownNotice(null);
  }
  function stopAutoKnown() { writeSyncedSetting(AUTO_KNOWN_KEY, "off"); undoKnown(); }

  // ----- the lookup pane: beside the text when there's room, a sheet from the bottom otherwise -----
  const [tab, setTab] = useState<LookupTab>("meanings");
  const [paneWidth, setPaneWidth] = useState<number | null>(loadPaneWidth);
  const [place, setPlace] = useState<PanePlace>({ mode: "sheet" });
  const paneRef = useRef<HTMLElement | null>(null);
  const paneOpen = open !== null;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!paneOpen || !root) return undefined;
    const measure = () => {
      const next = placePane(root, paneWidth);
      setPlace((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(root);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [paneOpen, paneWidth]);
  // The document slides left only as far as the pane needs, and back when the pane closes.
  const shift = paneOpen && place.mode === "side" ? place.shift : 0;
  useLayoutEffect(() => {
    const slot = rootRef.current?.closest<HTMLElement>(".panel-slot") ?? rootRef.current;
    if (!slot) return undefined;
    slot.style.transform = shift ? `translateX(${-shift}px)` : "";
    return () => { slot.style.transform = ""; };
  }, [shift]);
  function resizePane(next: number, keep = false) {
    const clamped = Math.round(Math.max(PANE_MIN, Math.min(next, place.mode === "side" ? place.max : next)));
    setPaneWidth(clamped);
    if (keep) { try { localStorage.setItem(PANE_WIDTH_KEY, String(clamped)); } catch { /* Private windows keep the default. */ } }
  }
  const dividing = useRef<{ x: number; width: number } | null>(null);

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
    if (focusCard) requestAnimationFrame(() => paneRef.current?.focus({ preventScroll: true }));
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
      if (target?.closest(".language-term-card, .language-lookup-divider, .language-reader-look, [data-lr-word], .language-reader-bar, .language-reader-top")) return;
      // The pane is part of the page, so only a press on the text beside it closes it; the rest of the app leaves it open.
      if (target && rootRef.current?.contains(target)) setOpen(null);
      setLookOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, lookOpen]);

  function turnPage(direction: number) {
    const next = page + direction;
    if (next < 0 || next >= pages.length) return false;
    if (direction > 0) finishPage(pages[page].flatMap((paragraph) => paragraph.sentences));
    stopReading(); setOpen(null); setPageIndex(next);
    rootRef.current?.scrollIntoView({ block: "start" });
    return true;
  }

  // ----- a lesson's place, and finishing it -----
  const placeSentence = view === "focus" ? sentences[focusIndex]?.index ?? 0 : pages[page][0]?.sentences[0]?.index ?? 0;
  useEffect(() => {
    if (!lesson || !sentences.length) return undefined;
    // Reported a moment after the reader settles, so flicking through pages doesn't send each one.
    const timer = window.setTimeout(() => {
      const lastOnScreen = view === "focus" ? placeSentence : pages[page].at(-1)?.sentences.at(-1)?.index ?? placeSentence;
      const seconds = session.current.seconds - session.current.reported;
      session.current.reported = session.current.seconds;
      lesson.onPlace({ sentence: placeSentence, percent: Math.round(((lastOnScreen + 1) / sentences.length) * 100), seconds });
    }, 800);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeSentence, lesson?.id]);
  const atEnd = view === "focus" ? focusIndex >= sentences.length - 1 : page >= pages.length - 1;
  function completeLesson() {
    if (!lesson) return;
    stopReading(); setOpen(null);
    // Every word left new in the lesson is known now, the rest of this page with it.
    finishPage(sentences, true);
    const seconds = session.current.seconds - session.current.reported;
    session.current.reported = session.current.seconds;
    const result = { wordsKnown: session.current.known.size, meaningsSaved: session.current.saved, seconds: session.current.seconds };
    lesson.onComplete({ ...result, seconds });
    setSummary(result);
    setKnownNotice(null);
  }
  function onMeaningSaved() {
    session.current.saved++;
    learning.recordStudy?.({ type: "meanings_saved", count: 1, lessonId: lesson?.id });
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
    if (target.closest("textarea, input, select")) { if (event.key === "Escape") { event.preventDefault(); paneRef.current?.focus(); } return; }
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
      const card = paneRef.current;
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

  const sheet = place.mode === "sheet";
  return <div ref={rootRef} className="language-reader" data-theme={look.theme === "system" ? undefined : look.theme} data-view={view} data-pane={paneOpen ? place.mode : undefined} style={style} tabIndex={-1}
    onKeyDown={onKeyDown} role="group" aria-label={`Reading in ${languageName(language)}`}>
    <div className="language-reader-top">
      <span className="language-reader-count" title="Words and phrases you've marked known"><b>{counts.known}</b> known</span>
      <span className="language-reader-page">{view === "focus" ? `Sentence ${Math.min(focusIndex + 1, sentences.length)} of ${sentences.length}` : pages.length > 1 ? `Page ${page + 1} of ${pages.length}` : ""}</span>
      <button type="button" className="language-reader-aa" aria-label="Theme and font" aria-expanded={lookOpen} onClick={() => { setOpen(null); setLookOpen((value) => !value); }}>Aa</button>
    </div>
    <div className="language-reader-progress" role="progressbar" aria-label="Place in the document" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(position * 100)}><i style={{ width: `${position * 100}%` }} /></div>
    {lookOpen ? <LookPanel look={look} onChange={changeLook} /> : null}
    {knownNotice ? <div className={`language-reader-known${knownNotice.explain ? " is-explain" : ""}`} role="status" lang="en">
      <span>{knownNotice.explain
        ? <>Turning the page marked the <b>{knownNotice.keys.length}</b> word{knownNotice.keys.length === 1 ? "" : "s"} you didn't tap as known. Words you read without looking up are words you know, so your known count keeps up with your reading.</>
        : <><b>{knownNotice.keys.length}</b> new word{knownNotice.keys.length === 1 ? "" : "s"} marked known.</>}</span>
      <button type="button" onClick={undoKnown}>Undo</button>
      {knownNotice.explain ? <>
        <button type="button" onClick={() => setKnownNotice(null)}>Keep doing this</button>
        <button type="button" onClick={stopAutoKnown}>Don't auto-mark known</button>
      </> : <button type="button" aria-label="Dismiss" onClick={() => setKnownNotice(null)}>×</button>}
    </div> : null}

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
        fixedTranslation={lesson?.translations?.[sentences[focusIndex].index] || undefined}
        onStep={step} onListen={(slow) => listenTo(sentences[focusIndex], slow)}>{renderSentence(sentences[focusIndex])}</FocusSentence> : null}
      {lesson && atEnd && sentences.length && !summary ? <div className="language-reader-finish" lang="en">
        <button type="button" className="is-primary" onClick={completeLesson}>Complete lesson</button>
        <p>{autoMarkKnown() ? "Words you haven't tapped become known." : "Your words keep the statuses you gave them."}</p>
      </div> : null}
      {summary ? <LessonDone summary={summary} next={lesson?.next ?? null} onReadAgain={() => { setSummary(null); setPageIndex(0); setFocusIndex(0); lesson?.onReadAgain?.(); }} onClose={lesson?.onClose} /> : null}
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


    {/* On the page itself, outside the document's clipped column, so it can stand in the free space beside it. */}
    {open && openSentence ? createPortal(<div className="language-reader language-lookup-dock" data-theme={look.theme === "system" ? undefined : look.theme} style={style}>
      {place.mode === "side" ? <div className="language-lookup-divider" role="separator" aria-orientation="vertical" aria-label="Resize the lookup pane" tabIndex={0}
        aria-valuemin={PANE_MIN} aria-valuemax={Math.max(PANE_MIN, place.max)} aria-valuenow={place.width}
        style={{ left: place.left - PANE_GAP, top: place.top, height: place.height }}
        onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); dividing.current = { x: event.clientX, width: place.width }; }}
        onPointerMove={(event) => { if (dividing.current) resizePane(dividing.current.width + dividing.current.x - event.clientX); }}
        onPointerUp={(event) => { if (!dividing.current) return; resizePane(dividing.current.width + dividing.current.x - event.clientX, true); dividing.current = null; }}
        onPointerCancel={() => { dividing.current = null; }}
        onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); event.stopPropagation(); resizePane(place.width + (event.key === "ArrowLeft" ? 24 : -24), true); }} /> : null}
      <LookupPane key={`${open.sentence}:${open.from}:${open.to}:${open.nonce}`} open={open} sentence={openSentence} pair={pair} learning={learning}
        sheet={sheet} tab={tab} onTab={setTab}
        style={place.mode === "side" ? { left: place.left, top: place.top, width: place.width, height: place.height } : place.left !== undefined ? { left: place.left, width: place.width, right: "auto" } : undefined}
      status={statusOf(open.key)} exists={learning.terms.has(termId(language, open.key))}
      partOf={open.from === open.to ? phraseAround(openSentence, open.from) : null}
      onPhrase={(match) => openRange(openSentence, match.from, match.from + match.length - 1)}
      onRate={rate} onMeaningSaved={onMeaningSaved} onClose={() => { setOpen(null); rootRef.current?.focus({ preventScroll: true }); }}
      onAsk={onAskInMargin ? () => {
        const element = rootRef.current?.querySelector(`[data-lr-sentence="${open.sentence}"][data-lr-word="${open.from}"]`);
        const box = element?.getBoundingClientRect();
        const blockId = blockOfSentence.get(open.sentence);
        if (!blockId) return;
        setOpen(null);
        onAskInMargin({ blockId, term: open.display, sentence: openSentence.text, rect: { left: box?.left ?? 0, top: box?.top ?? 0, width: box?.width ?? 0, height: box?.height ?? 0 } });
      } : undefined} rootRef={rootRef} paneRef={paneRef} />
    </div>, document.body) : null}
  </div>;
}

/** The end of a lesson: what this sitting added up to, and the next lesson. */
function LessonDone({ summary, next, onReadAgain, onClose }: { summary: LessonSummary; next: ReaderLesson["next"]; onReadAgain: () => void; onClose?: () => void }) {
  const minutes = Math.max(1, Math.round(summary.seconds / 60));
  const nextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { nextRef.current?.focus({ preventScroll: true }); }, []);
  return <section className="language-reader-done" lang="en" aria-labelledby="language-reader-done-title">
    <h3 id="language-reader-done-title">Lesson complete</h3>
    <dl>
      <div><dt>Words learned</dt><dd>{summary.wordsKnown}</dd></div>
      <div><dt>Meanings saved</dt><dd>{summary.meaningsSaved}</dd></div>
      <div><dt>Time</dt><dd>{summary.seconds < 30 ? "under a minute" : `${minutes} min`}</dd></div>
    </dl>
    <div className="language-reader-done-actions">
      {next ? <button ref={nextRef} type="button" className="is-primary" onClick={next.open}>Next lesson → <small>{next.title}</small></button> : <p>That was the last lesson in this course.</p>}
      <button type="button" onClick={onReadAgain}>Read again</button>
      {onClose ? <button type="button" onClick={onClose}>Back to the library</button> : null}
    </div>
  </section>;
}

/** Whether turning a page marks the words left new on it as known. */
function AutoKnownToggle() {
  const [on, setOn] = useState(autoMarkKnown);
  return <label className="language-reader-toggle">
    <input type="checkbox" checked={on} onChange={(event) => { setOn(event.target.checked); writeSyncedSetting(AUTO_KNOWN_KEY, event.target.checked ? "on" : "off"); }} />
    <span>Mark untapped words known when I turn the page</span>
  </label>;
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
    <h4>Reading</h4>
    <AutoKnownToggle />
    <p className="language-reader-look-note">Saved to your account.</p>
  </div>;
}

/** Focus view: one sentence at a time, large, with its audio and, on request, what it means. */
function FocusSentence({ sentence, pair, learning, canBack, canNext, fixedTranslation, onStep, onListen, children }: {
  sentence: ReaderSentence; pair: LanguagePair; learning: DocumentLanguageLearning; canBack: boolean; canNext: boolean; onStep: (direction: 1 | -1) => void;
  /** The lesson's own translation of this sentence: shown at once, with no AI asked. */
  fixedTranslation?: string;
  onListen: (slow: boolean) => void; children: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [translation, setTranslation] = useState<{ state: "idle" | "loading" | "done" | "failed"; text: string }>({ state: "idle", text: "" });
  useEffect(() => {
    if (!shown) return undefined;
    if (fixedTranslation && attempt === 0) { setTranslation({ state: "done", text: fixedTranslation }); return undefined; }
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
      {learning.aiAllowed || fixedTranslation ? <button type="button" aria-pressed={shown} onClick={() => setShown((value) => !value)}>{shown ? "Hide translation" : "Show translation"}</button> : null}
    </div>
    <div className="language-reader-focus-stage">
      <button type="button" className="language-reader-turn" aria-label="Previous sentence" disabled={!canBack} onClick={() => onStep(-1)}>‹</button>
      <p className="language-reader-focus-sentence" data-lr-sentence-row={sentence.index}>{children}</p>
      <button type="button" className="language-reader-turn" aria-label="Next sentence" disabled={!canNext} onClick={() => onStep(1)}>›</button>
    </div>
    {shown ? <p className="language-reader-translation" lang={pair.base}>
      {translation.state === "loading" ? <span role="status">Translating…</span> : translation.state === "failed" ? <span role="alert">{translation.text}</span> : <i>{translation.text}</i>}
      {translation.state !== "loading" && learning.aiAllowed ? <button type="button" aria-label="Translate again" title="Translate again" onClick={() => setAttempt((value) => value + 1)}>↻</button> : null}
    </p> : null}
  </div>;
}

type Suggestion = { state: "idle" } | { state: "loading"; partial?: PartialLookup } | { state: "done"; answer: LookupAnswer } | { state: "failed"; message: string };
type Dictionary = { state: "loading" } | { state: "done"; result: DictionaryLookup } | { state: "failed" };
export type LookupTab = "meanings" | "wiktionary" | "translate";

const dictionaries = new Map<string, DictionaryLookup>();
const SOURCE_NAMES: Record<string, string> = { user: "typed by you", wiktionary: "from Wiktionary", google: "from Google Translate", deepl: "from DeepL", ai: "from the AI" };
const PROVIDER_NAMES = { google: "Google Translate", deepl: "DeepL" } as const;

/**
 * The lookup pane: what one word or phrase means, beside the text instead of over it. The reader's own
 * meaning on top; then meanings to pick from by source (Wiktionary, a machine translation, the AI reading
 * the sentence); the live Wiktionary page and the translator in tabs; and how well the reader knows it.
 */
function LookupPane({ open, sentence, pair, learning, status, exists, partOf, sheet, tab, onTab, style, onPhrase, onRate, onMeaningSaved, onClose, onAsk, rootRef, paneRef }: {
  open: OpenTerm; sentence: ReaderSentence; pair: LanguagePair; learning: DocumentLanguageLearning; status: TermStatus; exists: boolean;
  partOf: { from: number; length: number; key: string } | null; sheet: boolean; tab: LookupTab; onTab: (tab: LookupTab) => void; style?: CSSProperties;
  onPhrase: (match: { from: number; length: number; key: string }) => void;
  onRate: (status: TermStatus) => void; onMeaningSaved?: () => void; onClose: () => void; onAsk?: () => void; rootRef: RefObject<HTMLDivElement | null>; paneRef: RefObject<HTMLElement | null>;
}) {
  const language = pair.target;
  const term = learning.terms.get(termId(language, open.key));
  const isPhrase = open.from !== open.to;
  const [meaning, setMeaning] = useState(term?.meaning ?? "");
  const [saved, setSaved] = useState<"" | "saving" | "saved">("");
  const [suggestion, setSuggestion] = useState<Suggestion>({ state: "idle" });
  const [asked, setAsked] = useState(0);
  const [addingTag, setAddingTag] = useState(false);
  const context = sentence.text === open.display ? "" : sentence.text;
  const cacheKey = `${pair.target}>${pair.base}|${open.key}|${sentence.text}`;
  const dictionaryKey = `${pair.target}>${pair.base}|${open.display}|${context}`;
  const [dictionary, setDictionary] = useState<Dictionary>(() => { const cached = dictionaries.get(dictionaryKey); return cached ? { state: "done", result: cached } : { state: "loading" }; });
  const titleId = `language-term-${open.nonce}`;
  const cardRef = useRef<HTMLElement | null>(null);

  // The meaning saves itself half a second after the typing stops, and at once on Enter or when the pane closes.
  const latest = useRef({ meaning, initial: term?.meaning ?? "", source: (term?.source ?? "user") as MeaningSource, learning, timer: 0, dirty: false });
  latest.current.meaning = meaning; latest.current.learning = learning;
  const commit = useCallback(() => {
    const state = latest.current;
    window.clearTimeout(state.timer);
    if (!state.dirty) return;
    state.dirty = false;
    const text = state.meaning.trim();
    // A phrase that was only dragged across, with nothing typed, is not saved.
    if (!text && !state.learning.terms.has(termId(language, open.key))) return;
    const before = state.learning.terms.get(termId(language, open.key))?.meaning ?? "";
    // The sentence it was saved from comes with it, so Review can show the word where it was met.
    state.learning.setTerm(language, open.key, { meaning: text, source: state.source, docId: state.learning.docId, ...(text ? { fragment: sentence.text } : {}) });
    if (text && !before.trim()) onMeaningSaved?.();
    setSaved("saved");
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  function type(value: string, source: MeaningSource = "user") {
    setMeaning(value); setSaved("saving");
    const state = latest.current;
    state.meaning = value; state.source = source; state.dirty = true;
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(commit, 500);
  }
  /** A meaning picked from the list goes into the reader's own meaning, with where it came from. */
  function adopt(value: string, source: MeaningSource) { type(value, source); commit(); }

  // The quick sources: dictionary senses and a machine translation. A beat first, so walking past terms with the arrow keys doesn't look each one up.
  useEffect(() => {
    if (dictionary.state === "done") return undefined;
    if (!learning.dictionary) { setDictionary({ state: "failed" }); return undefined; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      learning.dictionary!({ term: open.display, sentence: context, pair }, controller.signal).then(
        (result) => { if (controller.signal.aborted) return; dictionaries.set(dictionaryKey, result); setDictionary({ state: "done", result }); },
        () => { if (!controller.signal.aborted) setDictionary({ state: "failed" }); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictionaryKey]);

  // The AI reads the sentence last, with the dictionary's senses to choose from, and its answer streams in.
  // It is asked on its own only when there's no meaning yet; on request otherwise.
  useEffect(() => {
    if (!learning.aiAllowed) return undefined;
    const cached = asked === 0 ? answers.get(cacheKey) : undefined;
    if (cached) { setSuggestion({ state: "done", answer: cached }); return undefined; }
    if (asked === 0 && (term?.meaning ?? "")) return undefined;
    if (dictionary.state === "loading") { setSuggestion({ state: "loading" }); return undefined; }
    const controller = new AbortController();
    setSuggestion({ state: "loading" });
    const found = dictionary.state === "done" ? dictionary.result.wiktionary : null;
    const senses = found ? [...found.senses, ...(found.lemma?.senses ?? [])].map((sense) => `${sense.pos ? `(${sense.pos}) ` : ""}${sense.glosses.join("; ")}`) : [];
    const timer = window.setTimeout(() => {
      learning.lookUp({ text: open.display, sentence: context, pair, senses }, controller.signal,
        (partial) => { if (!controller.signal.aborted && partial.meaning) setSuggestion({ state: "loading", partial }); }).then(
        (answer) => { if (controller.signal.aborted) return; answers.set(cacheKey, answer); setSuggestion({ state: "done", answer }); },
        (error: unknown) => { if (!controller.signal.aborted) setSuggestion({ state: "failed", message: error instanceof Error && error.message ? error.message : "The meaning couldn't be looked up. Try again." }); });
    }, asked ? 0 : 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, cacheKey, dictionary.state]);

  // As a sheet, the word it is about stays in view above it.
  useEffect(() => {
    if (!sheet) return;
    const word = rootRef.current?.querySelector(`[data-lr-sentence="${open.sentence}"][data-lr-word="${open.from}"]`);
    const card = cardRef.current;
    if (!word || !card) return;
    const hidden = word.getBoundingClientRect().bottom + 12 - card.getBoundingClientRect().top;
    if (hidden > 0) (scrollParent(rootRef.current) ?? document.scrollingElement)?.scrollBy({ top: hidden, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);

  const answer = suggestion.state === "done" ? suggestion.answer : null;
  const partial = suggestion.state === "loading" ? suggestion.partial : undefined;
  const found = dictionary.state === "done" ? dictionary.result : null;
  const entry = found?.wiktionary ?? null;
  const machine = found?.machine ?? null;
  const tags = term?.tags ?? [];
  const lemma = (entry?.lemma?.term ?? (answer?.lemma && answer.lemma.toLowerCase() !== open.display.toLowerCase() ? answer.lemma : "")) || "";
  const draft = isPhrase && !exists;
  const mentions = useMemo(() => tab === "meanings" ? learning.mentions(open.display).filter((document) => document.id !== learning.docId).slice(0, 5) : [], [tab, learning, open.display]);
  const resolved = found?.resolvedTerm ?? (isPhrase ? open.display : open.display.toLocaleLowerCase(language));
  const source = meaning.trim() ? (saved ? latest.current.source : term?.source ?? "") : "";
  const tabs: Array<[LookupTab, string]> = [["meanings", "Meanings"], ["wiktionary", "Wiktionary"], ["translate", "Google Translate"]];

  function senseRows(senses: DictionarySense[]) {
    return senses.map((sense, index) => <li key={index}>
      <button type="button" className="language-lookup-pick" title="Use this meaning" onClick={() => adopt(sense.glosses.join("; "), "wiktionary")}>
        {sense.pos ? <i>{sense.pos}</i> : null}<span>{sense.glosses.join("; ")}</span></button>
      {sense.examples[0] ? <p className="language-lookup-example"><span lang={language}>{sense.examples[0].text}</span>{sense.examples[0].translation ? <em>{sense.examples[0].translation}</em> : null}</p> : null}
    </li>);
  }

  return <aside ref={(element) => { cardRef.current = element; paneRef.current = element; }} className={`language-term-card language-lookup-pane${sheet ? " is-sheet" : ""}`} role="dialog" aria-labelledby={titleId} tabIndex={-1} lang="en"
    style={style} onPointerDown={(event) => event.stopPropagation()}>
    <div className="language-term-scroll">
      <div className="language-term-head">
        {deviceCanSpeak() ? <button type="button" className="language-term-speak" aria-label="Say it" title="Say it" onClick={() => speak(open.display, language)}>🔊</button> : null}
        <h3 id={titleId} lang={language}>{open.display}</h3>
        <span className="language-lookup-badge">{languageName(language)}</span>
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
      <div className="language-term-label"><span>Your meaning</span><span className="language-term-saved" role="status">
        {saved === "saving" ? "Saving…" : saved === "saved" ? "Saved ✓" : ""}{source && SOURCE_NAMES[source] && saved !== "saving" ? <small> {SOURCE_NAMES[source]}</small> : null}</span></div>
      <label className="language-term-meaning"><span className="language-term-flag" aria-hidden="true">{pair.base.slice(0, 2).toUpperCase()}</span>
        <textarea value={meaning} rows={sheet ? 1 : 2} lang={pair.base} aria-label="Your meaning" maxLength={2000} enterKeyHint="done"
          placeholder={draft ? "Type a meaning to save this phrase" : "Type a meaning, or pick one below"} onChange={(event) => type(event.target.value)} onBlur={commit}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); commit(); cardRef.current?.focus({ preventScroll: true }); } }} /></label>

      <div className="language-lookup-tabs" role="tablist" aria-label="Where to look it up">
        {tabs.map(([id, name]) => <button key={id} type="button" role="tab" id={`${titleId}-tab-${id}`} aria-selected={tab === id} aria-controls={`${titleId}-panel`}
          onClick={() => onTab(id)}>{id === "translate" && machine ? PROVIDER_NAMES[machine.provider] : name}</button>)}
      </div>

      <div className="language-lookup-panel" role="tabpanel" id={`${titleId}-panel`} aria-labelledby={`${titleId}-tab-${tab}`} data-tab={tab}>
        {tab === "meanings" ? <>
          <section className="language-lookup-source" aria-label="Wiktionary">
            <h4><span className="language-lookup-chip is-wiktionary">Wiktionary</span></h4>
            {dictionary.state === "loading" ? <p className="language-lookup-skeleton" role="status" aria-label="Looking it up"><i /><i /></p>
              : entry ? <>
                {found && found.resolvedTerm !== open.display ? <p className="language-term-quiet">Entry for <b lang={language}>{found.resolvedTerm}</b></p> : null}
                <ol className="language-lookup-senses">{senseRows(entry.senses)}</ol>
                {entry.lemma ? <>
                  <p className="language-term-quiet">A form of <b lang={language}>{entry.lemma.term}</b>:</p>
                  <ol className="language-lookup-senses">{senseRows(entry.lemma.senses)}</ol>
                </> : null}
                <p className="language-lookup-credit">Source: <a href={entry.url} target="_blank" rel="noreferrer">Wiktionary</a> (<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA</a>)</p>
              </>
              : <p className="language-term-quiet">{dictionary.state === "failed" || found?.failed.includes("wiktionary") ? "Wiktionary didn't answer. Its page may still open in the Wiktionary tab." : "No Wiktionary entry."}</p>}
          </section>

          {machine?.term ? <section className="language-lookup-source" aria-label="Machine translation">
            <h4><span className="language-lookup-chip is-machine">{PROVIDER_NAMES[machine.provider]}</span></h4>
            <button type="button" className="language-lookup-pick" title="Use this meaning" lang={pair.base} onClick={() => adopt(machine.term, machine.provider)}><span>{machine.term}</span></button>
          </section> : null}

          <section className="language-lookup-source" aria-label="AI, in context">
            <h4><span className="language-lookup-chip is-ai">✦ AI · in this sentence</span></h4>
            {!learning.aiAllowed ? <p className="language-term-quiet">This document is hidden from AI, so the AI isn't asked.</p>
              : suggestion.state === "failed" ? <p className="language-term-error" role="alert">{suggestion.message} <button type="button" onClick={() => setAsked((value) => value + 1)}>Try again</button></p>
              : answer || partial?.meaning ? <>
                <button type="button" className="language-lookup-pick" title="Use this meaning" lang={pair.base} disabled={!answer} onClick={() => answer && adopt(answer.meaning, "ai")}>
                  <span>{answer?.meaning ?? partial?.meaning}</span></button>
                {answer?.note ? <p className="language-term-quiet">{answer.note}</p> : null}
                {answer?.others.map((other) => <button key={other} type="button" className="language-lookup-pick is-other" title="Use this meaning" lang={pair.base} onClick={() => adopt(other, "ai")}><span>{other}</span></button>)}
                {(answer?.sentenceTranslation ?? partial?.sentenceTranslation) ? <p className="language-lookup-sentence" lang={pair.base}>{answer?.sentenceTranslation ?? partial?.sentenceTranslation}</p> : null}
              </>
              : suggestion.state === "loading" ? <p className="language-term-quiet" role="status"><span className="language-term-spinner" aria-hidden="true" />Reading the sentence…</p>
              : <button type="button" className="language-term-link is-ask" onClick={() => setAsked((value) => value + 1)}>✦ What does it mean here?</button>}
          </section>

          {partOf && partOf.length > 1 ? <p className="language-term-quiet">Part of the phrase <button type="button" className="language-term-link" lang={language} onClick={() => onPhrase(partOf)}>{partOf.key}</button></p> : null}
          {mentions.length ? <section className="language-lookup-source" aria-label="Also in your documents">
            <h4>Also in your documents</h4>
            <div className="language-term-chips">{mentions.map((document) => <button key={document.id} type="button" onClick={() => learning.openDocument(document.id)}>{document.title}</button>)}</div>
          </section> : null}
        </> : tab === "wiktionary" ? <WiktionaryFrame key={resolved} term={resolved} language={language} waiting={dictionary.state === "loading"} />
          : <div className="language-lookup-translate">
            <h4>{isPhrase ? "Phrase" : "Word"}</h4>
            <p lang={language}>{open.display}</p>
            {dictionary.state === "loading" ? <p className="language-lookup-skeleton" role="status" aria-label="Translating"><i /></p>
              : machine ? <p className="is-translation" lang={pair.base}><button type="button" className="language-lookup-pick" title="Use this meaning" onClick={() => adopt(machine.term, machine.provider)}><span>{machine.term}</span></button></p> : null}
            {context ? <>
              <h4>Sentence</h4>
              <p lang={language}>{context}</p>
              {machine?.sentence ? <p className="is-translation" lang={pair.base}>{machine.sentence}</p> : null}
            </> : null}
            {dictionary.state !== "loading" && !machine ? <p className="language-term-quiet">{found && !found.machineAvailable ? "Machine translation isn't set up on this server yet."
              : "The translation couldn't be made just now."} The link below opens it in Google Translate.</p> : null}
            <p className="language-lookup-credit">{machine ? `Translated by ${PROVIDER_NAMES[machine.provider]}. ` : ""}
              <a href={googleTranslateUrl(context || open.display, pair.target, pair.base)} target="_blank" rel="noreferrer">Open in Google Translate ↗</a></p>
          </div>}
      </div>
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
        <p className="language-term-keys" aria-hidden="true"><kbd>←</kbd><kbd>→</kbd> next · <kbd>1</kbd>–<kbd>4</kbd> rate · <kbd>K</kbd> known · <kbd>X</kbd> ignore · <kbd>Esc</kbd></p>
        {onAsk ? <button type="button" className="is-ask" onClick={() => { commit(); onAsk(); }}>Ask in margin</button> : null}
      </div>
    </div>
  </aside>;
}

/** The live Wiktionary page for a term, at its language's section. Loaded only when its tab is opened. */
function WiktionaryFrame({ term, language, waiting }: { term: string; language: string; waiting: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (waiting || loaded) return undefined;
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, [waiting, loaded]);
  return <div className="language-lookup-frame">
    {!loaded ? <p className="language-lookup-skeleton is-page" role="status" aria-label="Opening Wiktionary"><i /><i /><i /></p> : null}
    {/* The spelling the dictionary resolved comes with the quick lookup, so the page waits for it. */}
    {waiting ? null : <iframe title={`Wiktionary: ${term}`} src={wiktionaryFrameUrl(term, language)} sandbox="allow-scripts allow-same-origin allow-popups" referrerPolicy="no-referrer"
      loading="lazy" data-loaded={loaded || undefined} onLoad={() => setLoaded(true)} />}
    <p className="language-lookup-credit">{slow && !loaded ? "The page is slow to open. " : ""}<a href={wiktionaryUrl(term, language)} target="_blank" rel="noreferrer">Open on Wiktionary ↗</a> · Text from Wiktionary (CC BY-SA)</p>
  </div>;
}
