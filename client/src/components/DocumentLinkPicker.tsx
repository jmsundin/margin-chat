import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Conversation } from "../types";
import { getEditableDocument } from "../lib/editableDocument";
import "./DocumentLinkPicker.css";

export interface DocumentLinkTarget {
  conversationId: string;
  blockId?: string;
}

interface DocumentLinkPickerProps {
  conversations: Record<string, Conversation>;
  sourceConversationId: string;
  sourceBlockId?: string;
  onSelect: (target: DocumentLinkTarget) => void;
  onCancel: () => void;
  error?: string;
  disabled?: boolean;
}

/** Plain text only: previews never render a target's HTML or interactive Markdown. */
function blockPreview(content: string): string {
  return content
    .replace(/^\s*(`{3,}|~{3,}).*$/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)+/gm, "")
    .replace(/[*`~]+/g, "")
    .replace(/\b_([^_]+)_\b/g, "$1")
    .replace(/\s+/g, " ").trim();
}

export default function DocumentLinkPicker({
  conversations, sourceConversationId, sourceBlockId, onSelect, onCancel, error, disabled = false,
}: DocumentLinkPickerProps) {
  const [query, setQuery] = useState("");
  const [blockQuery, setBlockQuery] = useState("");
  const [documentId, setDocumentId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const helpId = useId();
  const documents = useMemo(() => Object.values(conversations).map((conversation) => ({
    id: conversation.id,
    title: conversation.title.trim() || "Untitled document",
    updatedAt: conversation.updatedAt,
    blocks: getEditableDocument(conversation).blocks
      .map((block, index) => ({ id: block.id, preview: blockPreview(block.content), position: index + 1 }))
      .filter((block) => block.preview && !(conversation.id === sourceConversationId && block.id === sourceBlockId)),
  })).filter((document) => document.id !== sourceConversationId || document.blocks.length)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title)),
  [conversations, sourceConversationId, sourceBlockId]);
  const selectedDocument = documents.find((document) => document.id === documentId);
  const activeQuery = selectedDocument ? blockQuery : query;
  const normalizedQuery = activeQuery.trim().toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(normalizedQuery);
  const matchingDocuments = documents.filter((document) => matches(document.title) || document.blocks.some((block) => matches(block.preview)));
  const matchingBlocks = selectedDocument?.blocks.filter((block) => matches(block.preview)) ?? [];

  useEffect(() => { inputRef.current?.focus(); }, [documentId]);
  useEffect(() => {
    setDocumentId(null);
    setQuery("");
    setBlockQuery("");
  }, [sourceConversationId, sourceBlockId]);

  function browseBlocks(id: string) {
    const document = documents.find((item) => item.id === id);
    setBlockQuery(document && !matches(document.title) ? query : "");
    setDocumentId(id);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (selectedDocument) setDocumentId(null);
      else onCancel();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(optionsRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (!buttons.length) return;
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index === -1 && event.target !== inputRef.current) return;
    event.preventDefault();
    const next = index === -1 ? event.key === "ArrowDown" ? 0 : buttons.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
    buttons[next].scrollIntoView?.({ block: "nearest" });
  }

  return <section className="document-link-picker" aria-labelledby={headingId} onKeyDown={handleKeyDown}>
    <header className="document-link-picker-header">
      {selectedDocument ? <button type="button" className="document-link-picker-back" aria-label="Back to documents" onClick={() => setDocumentId(null)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
      </button> : null}
      <div className="document-link-picker-heading"><h3 id={headingId}>{selectedDocument ? selectedDocument.title : "Connect to a document or block"}</h3>
        <p>{selectedDocument ? "Choose a block" : "Choose a document, or browse its blocks"}</p>
      </div>
      <button type="button" className="document-link-picker-close" aria-label="Cancel connection" onClick={onCancel}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
      </button>
    </header>
    <label className="document-link-picker-search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
      <input ref={inputRef} type="search" aria-label={selectedDocument ? "Search blocks" : "Search documents and blocks"}
        aria-describedby={helpId} autoComplete="off" placeholder={selectedDocument ? "Search blocks…" : "Search documents and blocks…"}
        value={activeQuery} disabled={disabled} onChange={(event) => selectedDocument ? setBlockQuery(event.target.value) : setQuery(event.target.value)} />
    </label>
    {error ? <p className="document-link-picker-error" role="alert">{error}</p> : null}
    <div className="document-link-picker-options" ref={optionsRef} aria-busy={disabled}>
      {selectedDocument ? matchingBlocks.map((block) => <button key={block.id} type="button" className="document-link-picker-block"
        disabled={disabled} onClick={() => onSelect({ conversationId: selectedDocument.id, blockId: block.id })}>
        <span className="document-link-picker-block-label">Block {block.position}</span><span>{block.preview || "Empty block"}</span>
      </button>) : matchingDocuments.map((document) => {
        const current = document.id === sourceConversationId;
        const contentMatch = normalizedQuery && !matches(document.title) ? document.blocks.find((block) => matches(block.preview)) : undefined;
        return <div className="document-link-picker-document" key={document.id}>
          <button type="button" className="document-link-picker-target" disabled={disabled}
            aria-label={current ? `Browse other blocks in ${document.title}` : `Connect to document ${document.title}`}
            onClick={() => current ? browseBlocks(document.id) : onSelect({ conversationId: document.id })}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H5v18h14V8l-5-5ZM14 3v5h5M8 12h8M8 16h6" /></svg>
            <span className="document-link-picker-target-copy"><span className="document-link-picker-title">{document.title}</span>
              <span className="document-link-picker-preview">{contentMatch?.preview || (current ? "Current document · other blocks" : "Entire document")}</span>
            </span>
          </button>
          {document.blocks.length > 0 ? <button type="button" className="document-link-picker-browse" disabled={disabled}
            aria-label={`Browse blocks in ${document.title}`} onClick={() => browseBlocks(document.id)}>
            Blocks <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          </button> : null}
        </div>;
      })}
      {(selectedDocument ? !matchingBlocks.length : !matchingDocuments.length) ? <p className="document-link-picker-empty" role="status">
        {normalizedQuery ? "No matches. Try another search." : selectedDocument ? "No other blocks to connect to." : "No documents available to connect to."}
      </p> : null}
    </div>
    <p className="document-link-picker-help" id={helpId}>↑ ↓ to browse · Enter to connect · Esc to go back</p>
  </section>;
}
