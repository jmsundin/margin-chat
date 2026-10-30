import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { PublicMapAccount } from "./PublicTopicInsights";
import { askAboutNote, type PrivateAnswer } from "../lib/publicMapApi";
import { ApiError } from "../lib/apiError";
import { fetchWikipediaArticle, findQuote, passageMarkdown, passageTitle, type PassageNote, type WikipediaArticle } from "../lib/wikipediaReader";
import { SelectionToolbarRow } from "./SelectionToolbar";

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const HIGHLIGHT_NOTES = "explore-passage-notes";
const HIGHLIGHT_MARKS = "explore-passage-highlights";

type Selected = { text: string; context: string; top: number; left: number; bottom: number };
type Answer = { question: string; passage: string; context: string; top: number; status: "asking" | "done" | "error"; progress: string; answer?: PrivateAnswer; error?: string; controller: AbortController };

/** Every text node under `root`, with where each starts in the joined text. */
function textIndex(root: Node) {
  const nodes: Array<{ node: Text; start: number }> = [];
  let text = "";
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) { nodes.push({ node, start: text.length }); text += node.data; }
  return { nodes, text };
}

function rangeFor(root: HTMLElement, quote: string): Range | null {
  const { nodes, text } = textIndex(root);
  const found = findQuote(text, quote);
  if (!found) return null;
  const at = (offset: number) => {
    let entry = nodes[0];
    for (const candidate of nodes) { if (candidate.start > offset) break; entry = candidate; }
    return { node: entry.node, offset: Math.min(entry.node.data.length, offset - entry.start) };
  };
  const start = at(found.start), end = at(found.end);
  const range = root.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

/**
 * A Wikipedia article read inside Margin Chat. Selecting text offers the
 * same toolbar as documents: margin notes and highlights stay with the
 * exploration until saved; a side document goes straight into the vault.
 */
export default function WikipediaPane({ title, account, notes, onNotesChange, onNavigate, onClose, onCreateDocument, onExplore, onAddTopics }: {
  title: string;
  account?: PublicMapAccount;
  notes: PassageNote[];
  onNotesChange(change: (notes: PassageNote[]) => PassageNote[]): void;
  onNavigate(title: string): void;
  onClose(): void;
  /** Saves a document from a passage and opens it beside; false when it could not be made. */
  onCreateDocument(title: string, content: string, article: string): boolean;
  onExplore(text: string, article: string): void;
  onAddTopics(answer: PrivateAnswer, article: string): void;
}) {
  const [article, setArticle] = useState<WikipediaArticle | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Selected | null>(null);
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [asking, setAsking] = useState<Selected | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [marks, setMarks] = useState<Array<{ id: string; top: number; kind: PassageNote["kind"] }>>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<Answer | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarWidth, setToolbarWidth] = useState(360);
  answerRef.current = answer;

  useEffect(() => {
    const controller = new AbortController();
    answerRef.current?.controller.abort();
    setArticle(null); setError(""); setSelected(null); setAnswer(null); setOpenNote(null); setAsking(null);
    fetchWikipediaArticle(title, controller.signal).then((found) => { if (!controller.signal.aborted) { setArticle(found); scrollRef.current?.scrollTo({ top: 0 }); } })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason, "This article could not be read.")); });
    return () => controller.abort();
  }, [title]);
  useEffect(() => () => answerRef.current?.controller.abort(), []);

  const articleNotes = useMemo(() => article ? notes.filter((note) => note.article === article.title) : [], [notes, article]);
  const html = useMemo(() => ({ __html: article?.html ?? "" }), [article]);

  // Dotted underlines for notes, a wash for highlights, and a marker in the margin for each.
  useLayoutEffect(() => {
    const body = bodyRef.current, scroll = scrollRef.current;
    if (!body || !scroll || !article) { setMarks([]); return; }
    const place = () => {
      const ranges = articleNotes.map((note) => ({ note, range: rangeFor(body, note.quote) }));
      const registry = typeof CSS !== "undefined" && "highlights" in CSS ? (CSS as unknown as { highlights: Map<string, unknown> }).highlights : null;
      const HighlightClass = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
      if (registry && HighlightClass) {
        registry.set(HIGHLIGHT_NOTES, new HighlightClass(...ranges.flatMap(({ note, range }) => range && note.kind === "note" ? [range] : [])));
        registry.set(HIGHLIGHT_MARKS, new HighlightClass(...ranges.flatMap(({ note, range }) => range && note.kind === "highlight" ? [range] : [])));
      }
      const origin = scroll.getBoundingClientRect().top - scroll.scrollTop;
      setMarks(ranges.flatMap(({ note, range }) => range ? [{ id: note.id, kind: note.kind, top: range.getBoundingClientRect().top - origin }] : []));
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(body);
    return () => {
      observer?.disconnect();
      const registry = typeof CSS !== "undefined" && "highlights" in CSS ? (CSS as unknown as { highlights: Map<string, unknown> }).highlights : null;
      registry?.delete(HIGHLIGHT_NOTES); registry?.delete(HIGHLIGHT_MARKS);
    };
  }, [article, articleNotes]);

  // The toolbar follows a selection inside the article.
  useEffect(() => {
    let timer = 0;
    const read = () => {
      const selection = document.getSelection();
      const body = bodyRef.current, scroll = scrollRef.current;
      if (!selection || selection.isCollapsed || !selection.rangeCount || !body || !scroll) { setSelected(null); return; }
      const range = selection.getRangeAt(0);
      if (!body.contains(range.commonAncestorContainer)) return;
      const text = selection.toString().replace(/\s+/g, " ").trim();
      if (text.length < 2) { setSelected(null); return; }
      const rect = range.getBoundingClientRect(), box = scroll.getBoundingClientRect();
      const block = (range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement)?.closest("p, li, td, dd, blockquote, figcaption");
      setSelected({ text: text.slice(0, 4000), context: (block?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 3000),
        top: rect.top - box.top + scroll.scrollTop, bottom: rect.bottom - box.top + scroll.scrollTop, left: rect.left - box.left + rect.width / 2 });
    };
    const onChange = () => { window.clearTimeout(timer); timer = window.setTimeout(read, 120); };
    document.addEventListener("selectionchange", onChange);
    return () => { document.removeEventListener("selectionchange", onChange); window.clearTimeout(timer); };
  }, []);

  useLayoutEffect(() => { if (toolbarRef.current && toolbarRef.current.offsetWidth !== toolbarWidth) setToolbarWidth(toolbarRef.current.offsetWidth); });

  function clearSelection() { document.getSelection()?.removeAllRanges(); setSelected(null); }

  function addNote(kind: PassageNote["kind"]) {
    if (!selected || !article) return;
    const note: PassageNote = { id: `passage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, article: article.title, url: article.url,
      quote: selected.text, text: "", kind, createdAt: new Date().toISOString() };
    onNotesChange((current) => [...current, note]);
    if (kind === "note") setOpenNote(note.id);
    clearSelection();
  }

  function ask(passage: Selected, text: string) {
    if (!account?.canAsk || !article) return;
    answer?.controller.abort();
    const controller = new AbortController();
    const entry: Answer = { question: text, passage: passage.text, context: passage.context, top: passage.bottom + 8, status: "asking", progress: "", controller };
    setAnswer(entry); setAsking(null); setQuestion(""); clearSelection();
    askAboutNote({ userId: account.userId, topic: { label: article.title.slice(0, 200), description: "Wikipedia article" },
      noteContent: `Selected passage from the Wikipedia article “${article.title}”:\n“${passage.text}”\n\nThe paragraph around it:\n${passage.context}`.slice(0, 6000),
      question: text.slice(0, 500), options: account.aiOptions, signal: controller.signal,
      onProgress: (progress) => setAnswer((current) => current?.controller === controller ? { ...current, progress } : current) })
      .then((result) => setAnswer((current) => current?.controller === controller ? { ...current, status: "done", answer: result } : current))
      .catch((reason) => {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiError && reason.statusCode === 401) account.onAuthExpired?.();
        setAnswer((current) => current?.controller === controller ? { ...current, status: "error", error: errorMessage(reason, "AI could not answer. Try again.") } : current);
      })
      .finally(() => account.onBillingRefresh?.());
  }

  function onBodyClick(event: React.MouseEvent) {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[data-wiki-title]");
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onNavigate(link.dataset.wikiTitle!);
  }

  const scrollWidth = scrollRef.current?.clientWidth ?? 360;
  const toolbarLeft = selected ? Math.min(Math.max(8, selected.left - toolbarWidth / 2), Math.max(8, scrollWidth - toolbarWidth - 8)) : 0;
  const note = openNote ? articleNotes.find((candidate) => candidate.id === openNote) : undefined;
  const noteTop = note ? marks.find((mark) => mark.id === note.id)?.top ?? 0 : 0;
  const canAsk = Boolean(account?.canAsk);

  return <aside className="topic-explorer-pane is-wikipedia" aria-label={`Wikipedia: ${article?.title ?? title}`}>
    <header className="topic-explorer-pane-header">
      <span className="topic-explorer-pane-kind" aria-hidden="true">W</span>
      <strong title={article?.title ?? title}>{article?.title ?? title}</strong>
      <a href={article?.url ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`} target="_blank" rel="noreferrer noopener" aria-label="Open on wikipedia.org" title="Open on wikipedia.org">↗</a>
      <button type="button" aria-label="Close the article" title="Close" onClick={onClose}>×</button>
    </header>
    <div className="topic-explorer-pane-scroll" ref={scrollRef}>
      {error ? <p className="topic-explorer-pane-message" role="alert">{error}</p> : !article ? <p className="topic-explorer-pane-message" role="status">Reading {title} on Wikipedia…</p> : null}
      <div ref={bodyRef} className="wikipedia-article" onClick={onBodyClick} dangerouslySetInnerHTML={html} />
      {marks.map((mark) => <button key={mark.id} type="button" className={`wikipedia-passage-mark is-${mark.kind}${openNote === mark.id ? " is-open" : ""}`} style={{ top: mark.top }}
        aria-label={mark.kind === "note" ? "Open margin note" : "Open highlight"} title={mark.kind === "note" ? "Margin note" : "Highlight"}
        onClick={() => setOpenNote(openNote === mark.id ? null : mark.id)}>{mark.kind === "note" ? "m" : ""}</button>)}
      {selected && !asking ? <div ref={toolbarRef} className="selection-tooltip is-toolbar wikipedia-selection-toolbar" style={{ top: Math.max(4, selected.top - 46), left: toolbarLeft }}>
        <SelectionToolbarRow label="Selected article text"
          actions={[
            { icon: "note", label: "Margin note", onSelect: () => addNote("note"), hint: "A note beside this passage. It stays in Explore until you save it." },
            { icon: "side", label: "Side document", onSelect: () => { if (article && onCreateDocument(passageTitle(selected.text), passageMarkdown({ article: article.title, url: article.url, quote: selected.text, text: "" }), article.title)) clearSelection(); },
              hint: "A new document in your map with this passage and its source" },
            { icon: "find", label: "Explore", onSelect: () => { if (article) onExplore(selected.text, article.title); clearSelection(); }, hint: "Add this as a topic on the explore map" },
          ]}
          more={[
            { icon: "highlight", label: "Highlight", onSelect: () => addNote("highlight") },
            { icon: "explain", label: "Explain", onSelect: () => ask(selected, "Explain this passage in plain words, with any background needed to understand it."), disabled: !canAsk, ai: true },
            { icon: "copy", label: "Copy", onSelect: () => { void navigator.clipboard?.writeText(selected.text).catch(() => undefined); clearSelection(); } },
          ]}
          ask={{ icon: "ai", label: "Ask AI", onSelect: () => setAsking(selected), disabled: !canAsk, ariaLabel: canAsk ? "Ask AI about the selection" : "Ask AI needs a membership with AI turned on" }} />
      </div> : null}
      {asking ? <form className="wikipedia-ask" style={{ top: asking.bottom + 8 }} onSubmit={(event: FormEvent) => { event.preventDefault(); if (question.trim()) ask(asking, question.trim()); }}>
        <blockquote>{asking.text}</blockquote>
        <input autoFocus value={question} maxLength={500} placeholder="Ask about this passage…" aria-label="Question about the selected passage" onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setAsking(null); } }} />
        <div>
          <button type="button" onClick={() => ask(asking, "Explain this passage in plain words, with any background needed to understand it.")}>Explain</button>
          <button type="submit" className="is-primary" disabled={!question.trim()}>Ask</button>
          <button type="button" onClick={() => setAsking(null)}>Cancel</button>
        </div>
      </form> : null}
      {answer ? <section className="wikipedia-answer" style={{ top: answer.top }} aria-live="polite" aria-label="AI answer">
        <header><strong>{answer.question}</strong><button type="button" aria-label="Close the answer" onClick={() => { answer.controller.abort(); setAnswer(null); }}>×</button></header>
        {answer.status === "asking" ? <p className="is-muted"><span className="map-explore-spinner" aria-hidden="true" /> {answer.progress || "Asking AI…"}</p>
          : answer.status === "error" ? <p role="alert">{answer.error}</p>
          : <>
            {answer.answer!.answer.split(/\n{2,}/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
            <div className="wikipedia-answer-actions">
              <button type="button" onClick={() => {
                if (!article || !answer.answer) return;
                const content = `${passageMarkdown({ article: article.title, url: article.url, quote: answer.passage, text: "" })}\n**${answer.question}**\n\n${answer.answer.answer}\n\n> AI answer. Review before relying on it.\n`;
                if (onCreateDocument(answer.question.slice(0, 100), content, article.title)) setAnswer(null);
              }}>Save as document</button>
              {answer.answer!.related.length ? <button type="button" onClick={() => { if (article) onAddTopics(answer.answer!, article.title); }}>Add its {answer.answer!.related.length} topics to the map</button> : null}
            </div>
          </>}
      </section> : null}
      {note ? <section className="wikipedia-note" style={{ top: noteTop }} aria-label="Margin note">
        <blockquote>{note.quote}</blockquote>
        {note.kind === "note" ? <textarea autoFocus value={note.text} maxLength={10000} placeholder="Your note…" aria-label="Margin note"
          onChange={(event) => { const text = event.target.value; onNotesChange((current) => current.map((item) => item.id === note.id ? { ...item, text } : item)); }}
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpenNote(null); } }} /> : null}
        <small>{note.kind === "note" ? "Kept in Explore until you save it." : "Highlight, kept in Explore until you save it."}</small>
        <div>
          <button type="button" className="is-primary" onClick={() => {
            if (!onCreateDocument(passageTitle(note.text || note.quote), passageMarkdown(note), note.article)) return;
            onNotesChange((current) => current.filter((item) => item.id !== note.id)); setOpenNote(null);
          }}>Save to my map</button>
          <button type="button" onClick={() => { onNotesChange((current) => current.filter((item) => item.id !== note.id)); setOpenNote(null); }}>Delete</button>
          <button type="button" onClick={() => setOpenNote(null)}>Close</button>
        </div>
      </section> : null}
    </div>
  </aside>;
}
