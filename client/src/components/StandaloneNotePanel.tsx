import {
  useEffect,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import LiveMarkdownEditor from "./LiveMarkdownEditor";
import {
  getStandaloneNote,
  getStandaloneNoteContextMessageId,
} from "../lib/standaloneNotes";
import { getStandaloneNoteActivationEvent } from "../lib/standaloneNoteActivation";
import type { Conversation } from "../types";

export default function StandaloneNotePanel({
  conversation,
  isActive,
  onActivate,
  onRename,
  onUpdate,
  registerPanelRef,
}: {
  conversation: Conversation;
  isActive: boolean;
  onActivate: () => void;
  onRename: (conversationId: string, title: string) => void;
  onUpdate: (conversationId: string, noteId: string, content: string) => void;
  registerPanelRef: (
    conversationId: string,
    element: HTMLElement | null,
  ) => void;
}) {
  const note = getStandaloneNote(conversation);
  const [title, setTitle] = useState(conversation.title);

  useEffect(() => {
    setTitle(conversation.title);
  }, [conversation.id, conversation.title]);

  function commitTitle() {
    const nextTitle = title.trim() || "Untitled note";
    setTitle(nextTitle);
    if (nextTitle !== conversation.title) onRename(conversation.id, nextTitle);
  }

  function isInteractiveNoteTarget(target: EventTarget) {
    return (
      target instanceof Element &&
      Boolean(target.closest("input, button, .live-markdown-editor"))
    );
  }

  function handlePanelPointerDown(event: PointerEvent<HTMLElement>) {
    if (
      getStandaloneNoteActivationEvent(
        isActive,
        isInteractiveNoteTarget(event.target),
      ) === "pointerdown"
    ) {
      onActivate();
    }
  }

  function handlePanelClick(event: MouseEvent<HTMLElement>) {
    // Activating from pointer-down lets the browser establish the editor's
    // caret afterwards. Do not reactivate an already-active note, because the
    // conversation selection path clears native DOM selections.
    if (
      getStandaloneNoteActivationEvent(
        isActive,
        isInteractiveNoteTarget(event.target),
      ) === "click"
    ) {
      onActivate();
    }
  }

  return (
    <article
      className={`chat-panel standalone-note-panel${isActive ? " is-active" : ""}`}
      onClick={handlePanelClick}
      onPointerDown={handlePanelPointerDown}
      ref={(element) => registerPanelRef(conversation.id, element)}
    >
      <div className="panel-body standalone-note-body">
        <header className="standalone-note-header">
          <input
            aria-label="Note title"
            className="standalone-note-title"
            onBlur={commitTitle}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            value={title}
          />
          <p>Private workspace note · Markdown Live Preview</p>
        </header>

        {note ? (
          <LiveMarkdownEditor
            ariaLabel={`Edit ${conversation.title}`}
            autoFocus={isActive && !note.content}
            className="is-standalone-note"
            onChange={(content) => onUpdate(conversation.id, note.id, content)}
            placeholder="Capture an idea, collect research, or sketch a line of thought…"
            readingSelectionContext={{
              conversationId: conversation.id,
              messageId: getStandaloneNoteContextMessageId(note.id),
              noteId: note.id,
            }}
            value={note.content}
          />
        ) : (
          <p className="standalone-note-missing">This note could not be loaded.</p>
        )}
      </div>
    </article>
  );
}
