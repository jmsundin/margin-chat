import { useEffect, useRef, useState, type FormEvent } from "react";
import { LEARNING_LANGUAGES, languageName, type LanguagePair } from "../lib/languageLearning";
import { LESSON_LEVELS } from "../lib/languageLessons";
import "./LanguageLessonDialog.css";

export type LessonRequest = { pair: LanguagePair } & (
  | { kind: "ai"; topic: string; level: string }
  | { kind: "document"; level: string }
  | { kind: "link"; url: string }
  | { kind: "audio"; file: File });

type Kind = LessonRequest["kind"];
const LEVEL_KEY = "margin-chat:language-lesson:level";

function savedLevel() {
  try { const level = localStorage.getItem(LEVEL_KEY); return LESSON_LEVELS.some((item) => item.id === level) ? level as string : "A2"; }
  catch { return "A2"; }
}

/**
 * Makes a new document to read in Language learning mode: written by the AI,
 * retold from the open document, taken from a web page, or written down from a recording.
 */
export function LanguageLessonDialog({ pair: startPair, document: source, onCreate, onClose }: {
  pair: LanguagePair;
  /** The open document, when it can be retold as a lesson. */
  document: { title: string } | null;
  onCreate: (request: LessonRequest, options: { signal: AbortSignal; onProgress: (text: string) => void }) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pair, setPair] = useState(startPair);
  const [kind, setKind] = useState<Kind>("ai");
  const [level, setLevel] = useState(savedLevel);
  const [topic, setTopic] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef<AbortController | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    // Typing the topic is the first thing to do, not picking a language.
    dialog.current?.querySelector<HTMLInputElement>(".language-lesson-field input")?.focus();
    return () => { alive.current = false; running.current?.abort(); dialog.current?.close(); previous?.focus(); };
  }, []);

  const close = () => { running.current?.abort(); onClose(); };
  const ready = kind === "ai" ? topic.trim().length > 1 : kind === "link" ? /^https?:\/\/\S+\.\S+/iu.test(url.trim()) : kind === "audio" ? Boolean(file) : Boolean(source);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;
    const controller = new AbortController();
    running.current = controller;
    setError(null);
    setBusy("Starting…");
    try { localStorage.setItem(LEVEL_KEY, level); } catch { /* The level is asked again next time. */ }
    const request: LessonRequest = kind === "ai" ? { kind, pair, topic: topic.trim(), level } : kind === "document" ? { kind, pair, level }
      : kind === "link" ? { kind, pair, url: url.trim() } : { kind, pair, file: file as File };
    try {
      await onCreate(request, { signal: controller.signal, onProgress: (text) => { if (alive.current) setBusy(text); } });
      if (alive.current) onClose();
    } catch (failure) {
      if (!alive.current || controller.signal.aborted) return;
      setError(failure instanceof Error && failure.message ? failure.message : "The lesson couldn't be made. Try again.");
      setBusy(null);
    }
  }

  const options = (selected: string) => (LEARNING_LANGUAGES.some((language) => language.code === selected) ? LEARNING_LANGUAGES : [...LEARNING_LANGUAGES, { code: selected, name: languageName(selected) }])
    .map((language) => <option key={language.code} value={language.code}>{language.name}</option>);
  const choice = (value: Kind, title: string, hint: string) => <label className={`language-lesson-choice${kind === value ? " is-on" : ""}`}>
    <input type="radio" name="language-lesson-kind" value={value} checked={kind === value} disabled={Boolean(busy)} onChange={() => { setKind(value); setError(null); }} />
    <span><b>{title}</b><small>{hint}</small></span>
  </label>;
  const target = languageName(pair.target);

  return <dialog ref={dialog} className="language-lesson-dialog" aria-labelledby="language-lesson-title"
    onClick={(event) => {
      if (event.target !== event.currentTarget || busy) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <form onSubmit={(event) => void submit(event)}>
      <header><h2 id="language-lesson-title">New lesson</h2></header>
      <div className="language-lesson-body">
        <div className="language-lesson-pair">
          <label>Learning <select value={pair.target} disabled={Boolean(busy)} aria-label="Language you're learning"
            onChange={(event) => { const next = event.target.value; setPair({ target: next, base: next === pair.base ? pair.target : pair.base }); }}>{options(pair.target)}</select></label>
          <label>meanings in <select value={pair.base} disabled={Boolean(busy)} aria-label="Language meanings are shown in"
            onChange={(event) => { const next = event.target.value; setPair({ base: next, target: next === pair.target ? pair.base : pair.target }); }}>{options(pair.base)}</select></label>
        </div>

        <div className="language-lesson-choices" role="radiogroup" aria-label="Where the lesson comes from">
          {choice("ai", "AI writes one", `A short text in ${target} about anything you name.`)}
          {source ? choice("document", "From this document", `“${source.title}” retold in ${target}.`) : null}
          {choice("link", "From a web page", `An article in ${target}, read here.`)}
          {choice("audio", "From a recording", "Written down so you can read along as it plays.")}
        </div>

        {kind === "ai" ? <label className="language-lesson-field">What about?
          <input type="text" value={topic} maxLength={600} disabled={Boolean(busy)} autoFocus placeholder="A morning at the market, how vaccines work, my trip to Lisbon…" onChange={(event) => setTopic(event.target.value)} /></label> : null}
        {kind === "link" ? <label className="language-lesson-field">Address of the page
          <input type="url" inputMode="url" value={url} maxLength={2000} disabled={Boolean(busy)} placeholder="https://…" onChange={(event) => setUrl(event.target.value)} /></label> : null}
        {kind === "audio" ? <div className="language-lesson-field">
          <span>Recording</span>
          <div className="language-lesson-file">
            <button type="button" className="thread-dialog-button" disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}>{file ? "Choose another" : "Choose an audio file"}</button>
            <span>{file ? file.name : "MP3, M4A, WAV or OGG, up to 30 minutes."}</span>
            <input ref={fileInput} type="file" hidden accept="audio/*,.mp3,.m4a,.wav,.ogg,.oga,.flac,.aac,.opus" onChange={(event) => { setFile(event.currentTarget.files?.[0] ?? null); setError(null); event.currentTarget.value = ""; }} />
          </div>
          <small>The recording is saved in your vault and written down with voice typing, which uses your OpenAI key or AI credit.</small>
        </div> : null}
        {kind === "ai" || kind === "document" ? <label className="language-lesson-field">Level
          <select value={level} disabled={Boolean(busy)} onChange={(event) => setLevel(event.target.value)}>
            {LESSON_LEVELS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label> : null}

        {error ? <p className="language-lesson-error" role="alert">{error}</p> : null}
        {busy ? <p className="language-lesson-status" role="status">{busy}</p> : null}
      </div>
      <footer>
        <button type="button" className="thread-dialog-button" onClick={close}>{busy ? "Stop" : "Cancel"}</button>
        <button type="submit" className="thread-dialog-button is-primary" disabled={Boolean(busy) || !ready}>{busy ? "Making the lesson…" : "Make lesson"}</button>
      </footer>
    </form>
  </dialog>;
}
