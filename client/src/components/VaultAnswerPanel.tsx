import { useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { AIRetrievalPassage, AIRetrievalRecord } from "../types";
import { renderObsidianMarkdownToHtml } from "../lib/markdown";
import { renderMermaidBlocksIn } from "../lib/mermaidDiagrams";
import { vaultAnswerSources } from "../lib/vaultAnswer";
import "./NoteChatPanel.css";
import "./VaultAnswerPanel.css";

export interface VaultAnswerState {
  question: string;
  status: "answering" | "done" | "failed" | "stopped";
  answer: string;
  retrieval: AIRetrievalRecord | null;
  error?: string;
  /** The document it was saved as. */
  savedId?: string;
}

export interface VaultAnswerPanelProps {
  answer: VaultAnswerState;
  onOpenSource: (passage: AIRetrievalPassage) => void;
  onSave: () => void;
  onOpenSaved: (id: string) => void;
  onStop: () => void;
  onRetry: () => void;
  onClose: () => void;
}

/** [Vault 2] in the streamed answer as [2], matching the numbers in the Sources list. */
function citationsAsMarks(answer: string) {
  return answer.replace(/\[Vault ((?:\d+\s*,\s*)*\d+)\]/gu, (_match, numbers: string) => `[${numbers.replace(/\s+/gu, "")}]`);
}

const sourceNumber = (passage: AIRetrievalPassage) => passage.label?.replace(/^Vault /u, "") ?? "";

/**
 * Answer from my vault: the answer to a search, written only from the user's own
 * passages, with the sources it cites. Nothing is saved until the user saves it.
 */
export default function VaultAnswerPanel({ answer, onOpenSource, onSave, onOpenSaved, onStop, onRetry, onClose }: VaultAnswerPanelProps) {
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderObsidianMarkdownToHtml(citationsAsMarks(answer.answer)), [answer.answer]);
  const sources = vaultAnswerSources(answer.retrieval);
  const notFound = answer.status === "done" && answer.retrieval && answer.retrieval.status !== "used";
  useLayoutEffect(() => { if (bodyRef.current) void renderMermaidBlocksIn(bodyRef.current); }, [html]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target && !document.querySelector(".vault-answer")?.contains(target) && target !== document.body) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(<aside className="note-chat vault-answer" role="complementary" aria-labelledby={titleId}>
    <header className="note-chat-head">
      <div>
        <h2 id={titleId}>Answer from my vault</h2>
        <p className="note-chat-subtitle" title={answer.question}>{answer.question}</p>
      </div>
      <button type="button" className="note-chat-close" aria-label="Close the answer" onClick={onClose}>×</button>
    </header>
    <div className="note-chat-log" aria-live="polite" aria-busy={answer.status === "answering"}>
      {answer.answer ? <div ref={bodyRef} className="note-chat-answer message-content is-markdown" dangerouslySetInnerHTML={{ __html: html }} /> : null}
      {answer.status === "answering" && !answer.answer ? <p className="note-chat-thinking" role="status">Reading your vault…</p> : null}
      {answer.status === "failed" ? <p className="vault-answer-error" role="alert">{answer.error ?? "The answer couldn't be written. Try again."}</p> : null}
      {answer.status === "stopped" ? <p className="note-chat-thinking">Stopped.</p> : null}
      {notFound ? <p className="note-chat-intro">{answer.retrieval?.note ?? "Nothing in your vault matched this question well enough to answer from it."}</p> : null}
      {sources.length ? <section className="vault-answer-sources" aria-label="Sources">
        <h3>Sources</h3>
        <ol>{sources.map((passage) => <li key={`${passage.label ?? ""}:${passage.id}`} className={passage.cited ? "is-cited" : undefined}>
          <button type="button" onClick={() => onOpenSource(passage)} title={passage.excerpt ?? passage.title}>
            {sourceNumber(passage) ? <span className="vault-answer-number">{sourceNumber(passage)}</span> : null}
            <span className="vault-answer-source-title">{passage.title}</span>
            {passage.heading ? <span className="vault-answer-source-meta">{passage.heading}</span> : null}
            {!passage.cited && answer.status === "done" ? <span className="vault-answer-source-meta">Read, not cited</span> : null}
          </button>
        </li>)}</ol>
      </section> : null}
    </div>
    <footer className="note-chat-form vault-answer-actions">
      {answer.status === "answering" ? <button type="button" className="note-chat-send" onClick={onStop}>Stop</button>
        : answer.savedId ? <button type="button" className="note-chat-send" onClick={() => onOpenSaved(answer.savedId!)}>Open saved document</button>
        : answer.status === "done" && answer.answer.trim() ? <button type="button" className="note-chat-send" onClick={onSave}>Save as document</button>
        : <button type="button" className="note-chat-send" onClick={onRetry}>Try again</button>}
      <span className="vault-answer-hint">{answer.savedId ? "Saved, linked to its sources." : "Written only from your vault. Nothing is saved until you save it."}</span>
    </footer>
  </aside>, document.body);
}
