import { useEffect, useId, useRef, useState } from "react";
import RichNoteEditor from "./RichNoteEditor";
import { renderObsidianMarkdownToHtml } from "../lib/markdown";
import { excerpt } from "../lib/tree";
import type { ConversationNote } from "../types";
import "./MarginNoteTreeNode.css";

interface MarginNoteTreeNodeProps {
  conversationId: string;
  note: ConversationNote;
  onDelete: (conversationId: string, noteId: string) => void;
  onUpdate: (conversationId: string, noteId: string, content: string) => void;
  onUse?: (conversationId: string, content: string) => void;
  openRequest?: number;
}

function MarginNoteIcon() {
  return (
    <svg
      aria-hidden="true"
      className="conversation-tree-node-icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <path d="M5 4h14v12l-4 4H5z" />
      <path d="M15 20v-4h4" />
      <path d="M8 8h8M8 12h6" />
    </svg>
  );
}

function getNoteTitle(content: string) {
  return (
    excerpt(
      content
        .replace(/[#*_>`~-]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
      72,
    ) || "Untitled margin note"
  );
}

export default function MarginNoteTreeNode({
  conversationId,
  note,
  onDelete,
  onUpdate,
  onUse,
  openRequest,
}: MarginNoteTreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [addedToDraft, setAddedToDraft] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const editorId = useId();
  const title = getNoteTitle(note.content);

  useEffect(() => { if (openRequest) setExpanded(true); }, [openRequest]);

  useEffect(() => { setAddedToDraft(false); }, [note.content]);
  useEffect(() => {
    if (expanded) cardRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [expanded, openRequest]);
  useEffect(() => {
    if (!addedToDraft) return;
    const timeout = window.setTimeout(() => setAddedToDraft(false), 2400);
    return () => window.clearTimeout(timeout);
  }, [addedToDraft]);

  function closeEditor() {
    setExpanded(false);
    toggleRef.current?.focus();
  }

  return (
    <article
      className={`conversation-tree-node margin-note-tree-node${expanded ? " is-expanded" : ""}`}
      data-margin-note-tree-node={note.id}
      ref={cardRef}
      onKeyDownCapture={(event) => {
        if (!expanded || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        closeEditor();
      }}
    >
      <span aria-hidden="true" className="conversation-tree-node-anchor" />
      <header className="margin-note-tree-header">
        <span className="margin-note-tree-label"><MarginNoteIcon />Margin note</span>
        <button
          aria-controls={expanded ? editorId : undefined}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Minimize" : "Edit"} margin note ${title}`}
          className="margin-note-tree-summary"
          onClick={() => (expanded ? closeEditor() : setExpanded(true))}
          ref={toggleRef}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            {expanded ? <path d="M5 12h14" /> : <><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" /></>}
          </svg>
          {expanded ? "Minimize" : "Edit"}
        </button>
      </header>

      {note.quote ? (
        <div className="margin-note-tree-source">
          <span>On this passage</span>
          <blockquote title={note.quote}>{note.quote}</blockquote>
        </div>
      ) : null}

      {!expanded ? (
        <>
          <div className="margin-note-tree-preview">
            {note.content.trim() ? (
              typeof window === "undefined" ? <p>{note.content}</p> :
                <div className="message-content is-markdown obsidian-note-markdown" dangerouslySetInnerHTML={{ __html: renderObsidianMarkdownToHtml(note.content) }} />
            ) : <p className="margin-note-tree-empty">Keep a thought beside this passage.</p>}
          </div>
          <p className="margin-note-tree-privacy" title="This note stays private. Insert it into a document when you want AI to use it as context.">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
            <span>Private note <span aria-hidden="true">·</span> Not sent to AI</span>
          </p>
        </>
      ) : null}

      {expanded ? (
        <div className="margin-note-tree-editor" id={editorId}>
          <span className="margin-note-tree-editor-label">Your note</span>
          <RichNoteEditor
            ariaLabel="Edit margin note"
            autoFocus
            className="is-margin-note"
            onChange={(content) => onUpdate(conversationId, note.id, content)}
            placeholder="What would you like to remember?"
            value={note.content}
          />
          <p className="margin-note-tree-save-hint">Changes save automatically <span aria-hidden="true">·</span> Esc to minimize</p>
          <div className="margin-note-tree-actions">
            <button
              aria-label="Delete margin note"
              className="margin-note-tree-delete"
              onClick={() => onDelete(conversationId, note.id)}
              title="Delete margin note"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>
            </button>
            {onUse ? (
              <button
                className="margin-note-tree-use"
                disabled={!note.content.trim() || addedToDraft}
                onClick={() => {
                  onUse(conversationId, note.content);
                  setAddedToDraft(true);
                }}
                type="button"
              >
                {addedToDraft ? "Inserted into document" : "Insert into document"}
              </button>
            ) : null}
            <button className="margin-note-tree-done" onClick={closeEditor} type="button">Done</button>
          </div>
          <span className="sr-only" role="status">{addedToDraft ? "Note inserted into your document." : ""}</span>
          <p className="margin-note-tree-privacy">Private note <span aria-hidden="true">·</span> Not sent to AI</p>
        </div>
      ) : null}
    </article>
  );
}
