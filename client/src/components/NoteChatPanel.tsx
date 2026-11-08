import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Message } from "../types";
import { renderObsidianMarkdownToHtml } from "../lib/markdown";
import { renderMermaidBlocksIn } from "../lib/mermaidDiagrams";
import { splitTryNext, TRY_NEXT_HEADING } from "../lib/noteChat";
import { loadTextDraft, saveTextDraft } from "../lib/textDrafts";
import "./NoteChatPanel.css";

const STARTERS = ["What is the main claim here, in one line?", "Where is the evidence thinnest?", "What should I find out next?"];

export interface NoteChatPanelProps {
  open: boolean;
  title: string;
  messages: Message[];
  pending: boolean;
  onAsk: (question: string) => void;
  onStop?: () => void;
  onClose: () => void;
  /** Where an unsent question is kept on this device, so a reload doesn't lose it. */
  draftKey?: string;
}

function Answer({ content }: { content: string }) {
  const { body } = useMemo(() => splitTryNext(content), [content]);
  const html = useMemo(() => renderObsidianMarkdownToHtml(body), [body]);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (ref.current) void renderMermaidBlocksIn(ref.current); }, [html]);
  return <div ref={ref} className="note-chat-answer message-content is-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function TryNext({ items, onPick, label = TRY_NEXT_HEADING }: { items: string[]; onPick: (item: string) => void; label?: string }) {
  if (!items.length) return null;
  return <section className="note-chat-try-next" aria-label={label}>
    <h3>{label}</h3>
    <ul>{items.map((item) => <li key={item}><button type="button" onClick={() => onPick(item)} title="Put this in the question box">{item}</button></li>)}</ul>
  </section>;
}

/**
 * Ask about this note: a quiet panel at the right of the page. Answers use the whole note, quote
 * the passages they lean on, and end with a short "Try next" list; picking one puts it in the box.
 */
export default function NoteChatPanel({ open, title, messages, pending, onAsk, onStop, onClose, draftKey }: NoteChatPanelProps) {
  const [draft, setDraftText] = useState(() => draftKey ? loadTextDraft(draftKey) : "");
  const setDraft = (text: string) => {
    setDraftText(text);
    if (draftKey) saveTextDraft(draftKey, text);
  };
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const turns = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const last = turns.at(-1);
  const waiting = pending && last?.role === "user";
  const lastAnswer = last?.role === "assistant" && !pending ? splitTryNext(last.content).tryNext : [];

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [turns.length, last?.content, open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target && !document.querySelector(".note-chat")?.contains(target) && target !== document.body) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function pick(item: string) {
    setDraft(item);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(item.length, item.length);
    });
  }

  function submit() {
    const question = draft.trim();
    if (!question || pending) return;
    onAsk(question);
    setDraft("");
  }

  return createPortal(<aside className="note-chat" role="complementary" aria-labelledby={titleId}>
    <header className="note-chat-head">
      <div>
        <h2 id={titleId}>Ask about this note</h2>
        <p className="note-chat-subtitle">{title}</p>
      </div>
      <button type="button" className="note-chat-close" aria-label="Close Ask about this note" onClick={onClose}>×</button>
    </header>
    <div ref={logRef} className="note-chat-log" aria-live="polite">
      {turns.length ? turns.map((message) => message.role === "user"
        ? <p key={message.id} className="note-chat-question">{message.content}</p>
        : <Answer key={message.id} content={message.content} />) : <>
        <p className="note-chat-intro">Ask anything about this note. Answers use the whole note and quote the passages they lean on.</p>
        <TryNext items={STARTERS} onPick={pick} label="Start with" />
      </>}
      {waiting ? <p className="note-chat-thinking" role="status">Reading the note…</p> : null}
      <TryNext items={lastAnswer} onPick={pick} />
    </div>
    <form className="note-chat-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <textarea ref={inputRef} rows={2} value={draft} placeholder="Ask about this note…" aria-label="Ask about this note"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
        }} />
      {pending && onStop
        ? <button type="button" className="note-chat-send" onClick={onStop}>Stop</button>
        : <button type="submit" className="note-chat-send" disabled={!draft.trim()}>Ask</button>}
    </form>
  </aside>, document.body);
}
