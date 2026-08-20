import { useEffect, useState } from "react";
import LiveMarkdownEditor from "./LiveMarkdownEditor";
import { excerpt } from "../lib/tree";
import type { ConversationNote } from "../types";

interface MarginNoteTreeNodeProps {
  conversationId: string;
  note: ConversationNote;
  onDelete: (conversationId: string, noteId: string) => void;
  onUpdate: (conversationId: string, noteId: string, content: string) => void;
  onUse?: (conversationId: string, content: string) => void;
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
}: MarginNoteTreeNodeProps) {
  const [draft, setDraft] = useState(note.content);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => setDraft(note.content), [note.content]);

  function save() {
    if (!draft.trim()) {
      setDraft(note.content);
      return;
    }

    if (draft !== note.content) {
      onUpdate(conversationId, note.id, draft);
    }
  }

  function closeEditor() {
    save();
    setExpanded(false);
  }

  return (
    <article
      className={`conversation-tree-node margin-note-tree-node${expanded ? " is-expanded" : ""}`}
      data-margin-note-tree-node={note.id}
    >
      <span aria-hidden="true" className="conversation-tree-node-anchor" />
      <button
        aria-expanded={expanded}
        aria-label={`${expanded ? "Close" : "Edit"} margin note ${getNoteTitle(note.content)}`}
        className="margin-note-tree-summary"
        onClick={() => (expanded ? closeEditor() : setExpanded(true))}
        type="button"
      >
        <span className="conversation-tree-node-head">
          <span className="conversation-tree-node-kicker">
            <MarginNoteIcon />
            Margin note
          </span>
          <span aria-hidden="true" className="conversation-tree-node-expand">
            {expanded ? "Close" : "Edit ↗"}
          </span>
        </span>
        <strong>{getNoteTitle(note.content)}</strong>
        <span className="conversation-tree-node-origin">
          {note.quote
            ? `“${excerpt(note.quote, 88)}”`
            : "Linked to this conversation"}
        </span>
        {!expanded ? (
          <span className="conversation-tree-node-meta">
            <span>Private note</span>
            <span aria-hidden="true">·</span>
            <span>Not sent to AI</span>
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div className="margin-note-tree-editor">
          <LiveMarkdownEditor
            ariaLabel="Edit margin note"
            autoFocus
            className="is-compact"
            onBlur={save}
            onChange={setDraft}
            value={draft}
          />
          <div className="margin-note-tree-actions">
            <button
              className="is-danger"
              onClick={() => onDelete(conversationId, note.id)}
              type="button"
            >
              Delete
            </button>
            {onUse ? (
              <button
                onClick={() =>
                  onUse(conversationId, draft.trim() || note.content)
                }
                type="button"
              >
                Use in message
              </button>
            ) : null}
            <button onClick={closeEditor} type="button">Done</button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
