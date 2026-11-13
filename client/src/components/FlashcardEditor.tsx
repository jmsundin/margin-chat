import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { splitDocumentMarkdown, type DocumentBlock } from "../lib/editableDocument";
import { flashcardDraftProblem, type FlashcardDraft } from "../lib/flashcardEdit";
import RichDocumentEditor from "./LazyRichDocumentEditor";

function toBlocks(markdown: string, key: string): DocumentBlock[] {
  const now = new Date().toISOString();
  return splitDocumentMarkdown(markdown).map((part) => part.replace(/\s+$/u, "")).filter(Boolean)
    .map((content, index) => ({ id: `${key}:${index}`, kind: "markdown" as const, content, createdAt: now, updatedAt: now, authorship: "user" as const }));
}
const toMarkdown = (blocks: ReadonlyArray<DocumentBlock>) => blocks.map((block) => block.content).join("\n\n").trim();

/** One side of a card, edited like a document: Markdown, images, lists, code. */
function CardSide({ label, id, markdown, onChange, hint }: { label: string; id: string; markdown: string; onChange: (markdown: string) => void; hint?: string }) {
  const [blocks, setBlocks] = useState(() => toBlocks(markdown, id));
  return (
    <section className="flashcard-editor-side">
      <h3>{label}</h3>
      {hint ? <p className="flashcard-editor-hint">{hint}</p> : null}
      <RichDocumentEditor conversationId={id} blocks={blocks} ariaLabel={label} className="flashcard-editor-document"
        onChangeBlocks={(next) => { setBlocks(next); onChange(toMarkdown(next)); }}/>
    </section>
  );
}

interface Props {
  cardId: string;
  draft: FlashcardDraft;
  docTitle: string;
  /** Saves the card; resolves to an error sentence, or null when it was saved. */
  onSave: (draft: FlashcardDraft) => string | null;
  onCancel: () => void;
}

/** Edit a card's sides with the document editor. Saving rewrites the card where it is written. */
export default function FlashcardEditor({ cardId, draft: initial, docTitle, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);
  const problem = flashcardDraftProblem(draft);
  const key = `flashcard-edit:${cardId}`;

  const save = useCallback(() => {
    if (problem) { setError(problem); return; }
    if (!changed) { onCancel(); return; }
    setError(onSave(draft));
  }, [changed, draft, onCancel, onSave, problem]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); }
      else if (event.key === "Escape" && !document.querySelector(".flashcard-editor [role='listbox'], .flashcard-editor [role='menu']")) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, save]);
  useEffect(() => { root.current?.querySelector<HTMLElement>("[contenteditable='true']")?.focus(); }, []);

  return (
    <div className="flashcard-editor" ref={root}>
      <header className="flashcard-editor-head">
        <h2>Edit card</h2>
        <span title="Saving changes the card where it is written">in {docTitle || "Untitled"}</span>
      </header>
      {draft.kind === "cloze" ? (
        <CardSide label="Text" id={`${key}:text`} markdown={draft.text} hint="Wrap the parts to hide in {{c1::…}}; use c2, c3 for more cards."
          onChange={(text) => setDraft({ kind: "cloze", text })}/>
      ) : <>
        <CardSide label="Front" id={`${key}:front`} markdown={draft.front} onChange={(front) => setDraft((before) => before.kind === "pair" ? { ...before, front } : before)}/>
        <CardSide label="Back" id={`${key}:back`} markdown={draft.back} onChange={(back) => setDraft((before) => before.kind === "pair" ? { ...before, back } : before)}/>
        <label className="flashcard-editor-both">
          <input type="checkbox" checked={draft.both} onChange={(event) => setDraft({ ...draft, both: event.target.checked })}/>
          Also ask the other way round
        </label>
      </>}
      {error ? <p className="flashcard-editor-error" role="alert">{error}</p> : null}
      <footer className="flashcard-editor-actions">
        <button type="button" className="flashcard-secondary" onClick={onCancel}>Cancel</button>
        <button type="button" className="flashcard-primary" onClick={save} disabled={Boolean(problem)} title={problem ?? "Save (⌘/Ctrl+Enter)"}>Save</button>
      </footer>
    </div>
  );
}
