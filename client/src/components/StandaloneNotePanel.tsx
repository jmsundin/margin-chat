import {
  useEffect,
  useRef,
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
  const [draft, setDraft] = useState(note?.content ?? "");
  const draftRef = useRef(draft);
  const noteContentRef = useRef(note?.content ?? "");
  const onUpdateRef = useRef(onUpdate);
  const saveTimeoutRef = useRef<number | null>(null);

  draftRef.current = draft;
  noteContentRef.current = note?.content ?? "";
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    setTitle(conversation.title);
  }, [conversation.id, conversation.title]);

  useEffect(() => {
    setDraft(note?.content ?? "");
  }, [note?.id]);

  useEffect(() => {
    if (!note || draft === note.content) return undefined;
    const timeoutId = window.setTimeout(() => {
      saveTimeoutRef.current = null;
      onUpdate(conversation.id, note.id, draft);
    }, 320);
    saveTimeoutRef.current = timeoutId;
    return () => {
      window.clearTimeout(timeoutId);
      if (saveTimeoutRef.current === timeoutId) saveTimeoutRef.current = null;
    };
  }, [conversation.id, draft, note, onUpdate]);

  useEffect(() => () => {
    if (!note || draftRef.current === noteContentRef.current) return;
    onUpdateRef.current(conversation.id, note.id, draftRef.current);
  }, [conversation.id, note?.id]);

  function flushDraft() {
    if (!note || draftRef.current === note.content) return;
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    onUpdate(conversation.id, note.id, draftRef.current);
  }

  function commitTitle() {
    const nextTitle = title.trim() || "Untitled note";
    setTitle(nextTitle);
    onRename(conversation.id, nextTitle);
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
            autoFocus={isActive && !draft}
            className="is-standalone-note"
            onBlur={flushDraft}
            onChange={setDraft}
            placeholder="Capture an idea, collect research, or sketch a line of thought…"
            readingSelectionContext={{
              conversationId: conversation.id,
              messageId: getStandaloneNoteContextMessageId(note.id),
              noteId: note.id,
            }}
            value={draft}
          />
        ) : (
          <p className="standalone-note-missing">This note could not be loaded.</p>
        )}
      </div>
    </article>
  );
}
