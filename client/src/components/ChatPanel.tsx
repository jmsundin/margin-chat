import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import MarkdownMessage from "./MarkdownMessage";
import ServicePickerModal from "./ServicePickerModal";
import {
  getBackendServiceModel,
  getBackendServiceOption,
  getBackendServiceSelectionLabel,
} from "../lib/services";
import type {
  BackendServiceId,
  Conversation,
  Message,
  MessageAnchorLink,
  SelectionDraft,
} from "../types";

const TYPEWRITER_MIN_DURATION_MS = 180;
const TYPEWRITER_MAX_DURATION_MS = 900;
const TYPEWRITER_WORDS_PER_STEP = 3;
const COMPOSER_MIN_HEIGHT_PX = 102;
const COMPOSER_MAX_HEIGHT_PX = 250;
const COMPOSER_MIN_TEXTAREA_HEIGHT_PX = 44;

function PlusIcon() {
  return (
    <svg
      aria-hidden="true"
      className="composer-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg
      aria-hidden="true"
      className="composer-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
      <path d="m5.6 5.6 2.8 2.8" />
      <path d="m15.6 15.6 2.8 2.8" />
      <path d="m18.4 5.6-2.8 2.8" />
      <path d="m8.4 15.6-2.8 2.8" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      aria-hidden="true"
      className="composer-icon is-small"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      aria-hidden="true"
      className="composer-send-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.1"
    >
      <path d="M12 17V7" />
      <path d="m7.5 11.5 4.5-4.5 4.5 4.5" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg
      aria-hidden="true"
      className="composer-send-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <rect x="7.5" y="7.5" width="9" height="9" rx="1.6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="composer-icon is-small"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <path d="m7 7 10 10" />
      <path d="m17 7-10 10" />
    </svg>
  );
}

interface ChatPanelProps {
  anchorsByMessageId: Record<string, MessageAnchorLink[]>;
  conversation: Conversation;
  draft: string;
  isActive: boolean;
  isSubmitting: boolean;
  theme: "light" | "dark";
  typingProgressByMessageId: Record<string, number>;
  typingMessageIds: Record<string, boolean>;
  selectionPreview: SelectionDraft | null;
  onActivate: () => void;
  onDraftChange: (value: string) => void;
  onModelChange: (
    conversationId: string,
    serviceId: BackendServiceId,
    modelId: string,
  ) => void;
  onStopTypewriter: (conversationId: string) => void;
  onSubmit: (conversationId: string, value: string) => void;
  onTypewriterProgress: (messageId: string, visibleCount: number) => void;
  onTypewriterComplete: (messageId: string) => void;
  registerPanelRef: (
    conversationId: string,
    element: HTMLElement | null,
  ) => void;
  registerComposerSurfaceRef: (
    conversationId: string,
    element: HTMLDivElement | null,
  ) => void;
  registerAnchorRef: (
    branchConversationId: string,
    element: HTMLSpanElement | null,
  ) => void;
}

function getTypewriterDurationMs(contentLength: number) {
  return Math.min(
    TYPEWRITER_MAX_DURATION_MS,
    Math.max(TYPEWRITER_MIN_DURATION_MS, contentLength * 110),
  );
}

function splitTypewriterChunks(value: string) {
  const tokens = value.match(/\S+\s*|\s+/g) ?? [];
  const chunks: string[] = [];
  let currentChunk = "";
  let wordCount = 0;

  for (const token of tokens) {
    currentChunk += token;

    if (token.trim().length > 0) {
      wordCount += 1;
    }

    if (wordCount >= TYPEWRITER_WORDS_PER_STEP) {
      chunks.push(currentChunk);
      currentChunk = "";
      wordCount = 0;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function renderMessageContent(
  message: Message,
  anchors: MessageAnchorLink[],
  registerAnchorRef: (
    branchConversationId: string,
    element: HTMLSpanElement | null,
  ) => void,
  pendingSelection: SelectionDraft | null,
) {
  const canRenderPendingSelection =
    pendingSelection &&
    pendingSelection.endOffset > pendingSelection.startOffset &&
    !anchors.some(
      (link) =>
        pendingSelection.startOffset < link.anchor.endOffset &&
        pendingSelection.endOffset > link.anchor.startOffset,
    );
  const decorations: Array<{
    type: "anchor" | "preview";
    startOffset: number;
    endOffset: number;
    branchConversationId?: string;
  }> = anchors.map((link) => ({
    type: "anchor",
    startOffset: link.anchor.startOffset,
    endOffset: link.anchor.endOffset,
    branchConversationId: link.branchConversationId,
  }));

  if (canRenderPendingSelection) {
    decorations.push({
      type: "preview",
      startOffset: pendingSelection.startOffset,
      endOffset: pendingSelection.endOffset,
    });
  }

  if (!decorations.length) {
    return message.content;
  }

  const segments: Array<{
    type: "plain" | "anchor" | "preview";
    value: string;
    branchConversationId?: string;
  }> = [];

  let cursor = 0;
  const orderedDecorations = [...decorations].sort(
    (left, right) => left.startOffset - right.startOffset,
  );

  for (const decoration of orderedDecorations) {
    const start = Math.max(cursor, decoration.startOffset);
    const end = Math.max(start, decoration.endOffset);

    if (start > cursor) {
      segments.push({
        type: "plain",
        value: message.content.slice(cursor, start),
      });
    }

    if (end > start) {
      segments.push({
        type: decoration.type,
        value: message.content.slice(start, end),
        branchConversationId: decoration.branchConversationId,
      });
    }

    cursor = Math.max(cursor, end);
  }

  if (cursor < message.content.length) {
    segments.push({
      type: "plain",
      value: message.content.slice(cursor),
    });
  }

  return segments.map((segment, index) => {
    if (segment.type === "plain") {
      return <span key={`${message.id}-plain-${index}`}>{segment.value}</span>;
    }

    if (segment.type === "preview") {
      return (
        <mark
          key={`${message.id}-preview`}
          className="message-anchor is-pending-selection"
        >
          <span>{segment.value}</span>
        </mark>
      );
    }

    return (
      <mark
        key={`${message.id}-anchor-${segment.branchConversationId}`}
        className="message-anchor"
      >
        <span
          ref={(element) =>
            registerAnchorRef(segment.branchConversationId!, element)
          }
        >
          {segment.value}
        </span>
      </mark>
    );
  });
}

interface MessageContentProps {
  anchors: MessageAnchorLink[];
  conversationId: string;
  isTypewriting: boolean;
  message: Message;
  onTypewriterProgress: (messageId: string, visibleCount: number) => void;
  onTypewriterComplete: (messageId: string) => void;
  pendingSelection: SelectionDraft | null;
  registerAnchorRef: (
    branchConversationId: string,
    element: HTMLSpanElement | null,
  ) => void;
  theme: "light" | "dark";
  typingProgressByMessageId: Record<string, number>;
}

function MessageContent({
  anchors,
  conversationId,
  isTypewriting,
  message,
  onTypewriterProgress,
  onTypewriterComplete,
  pendingSelection,
  registerAnchorRef,
  theme,
  typingProgressByMessageId,
}: MessageContentProps) {
  const [typewriterChunks, setTypewriterChunks] = useState(() =>
    splitTypewriterChunks(message.content),
  );
  const [visibleLength, setVisibleLength] = useState(() =>
    isTypewriting
      ? Math.min(
          typingProgressByMessageId[message.id] ?? 0,
          splitTypewriterChunks(message.content).length,
        )
      : splitTypewriterChunks(message.content).length,
  );
  const persistTypewriterProgress = useEffectEvent((visibleCount: number) => {
    onTypewriterProgress(message.id, visibleCount);
  });
  const completeTypewriter = useEffectEvent(() => {
    onTypewriterComplete(message.id);
  });

  useEffect(() => {
    setTypewriterChunks(splitTypewriterChunks(message.content));
  }, [message.content]);

  useEffect(() => {
    if (!isTypewriting) {
      setVisibleLength(typewriterChunks.length);
      return;
    }

    const initialVisibleLength = Math.min(
      typingProgressByMessageId[message.id] ?? 0,
      typewriterChunks.length,
    );

    setVisibleLength(initialVisibleLength);

    if (initialVisibleLength >= typewriterChunks.length) {
      completeTypewriter();
      return;
    }

    let frameId = 0;
    let startedAt = 0;
    const duration = getTypewriterDurationMs(typewriterChunks.length);
    const remainingLength = typewriterChunks.length - initialVisibleLength;
    const remainingDuration =
      typewriterChunks.length > 0
        ? duration * (remainingLength / typewriterChunks.length)
        : 0;

    const animate = (timestamp: number) => {
      if (!startedAt) {
        startedAt = timestamp;
      }

      const elapsed = timestamp - startedAt;
      const progress =
        remainingDuration > 0 ? Math.min(elapsed / remainingDuration, 1) : 1;
      const nextVisibleLength = Math.max(
        initialVisibleLength + 1,
        initialVisibleLength + Math.ceil(remainingLength * progress),
      );

      setVisibleLength((current) =>
        current === nextVisibleLength ? current : nextVisibleLength,
      );
      persistTypewriterProgress(nextVisibleLength);

      if (progress < 1) {
        frameId = window.requestAnimationFrame(animate);
        return;
      }

      completeTypewriter();
    };

    frameId = window.requestAnimationFrame(animate);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    completeTypewriter,
    typewriterChunks.length,
    isTypewriting,
    message.id,
    persistTypewriterProgress,
    typingProgressByMessageId,
  ]);

  const renderedMessage =
    isTypewriting || visibleLength < typewriterChunks.length
      ? {
          ...message,
          content: typewriterChunks.slice(0, visibleLength).join(""),
        }
      : message;

  return (
    message.role === "assistant" ? (
      <MarkdownMessage
        anchors={anchors}
        className={
          isTypewriting ? "message-content is-typewriter-active" : "message-content"
        }
        content={renderedMessage.content}
        conversationId={conversationId}
        enableMermaidRendering={
          !isTypewriting && visibleLength >= typewriterChunks.length
        }
        messageId={message.id}
        pendingSelection={pendingSelection}
        registerAnchorRef={registerAnchorRef}
        theme={theme}
      />
    ) : (
      <div
        className={
          isTypewriting ? "message-content is-typewriter-active" : "message-content"
        }
        data-message-bubble="true"
        data-conversation-id={conversationId}
        data-message-id={message.id}
      >
        {renderMessageContent(
          renderedMessage,
          anchors,
          registerAnchorRef,
          pendingSelection,
        )}
      </div>
    )
  );
}

export default function ChatPanel({
  anchorsByMessageId,
  conversation,
  draft,
  isActive,
  isSubmitting,
  theme,
  typingProgressByMessageId,
  typingMessageIds,
  selectionPreview,
  onActivate,
  onDraftChange,
  onModelChange,
  onStopTypewriter,
  onSubmit,
  onTypewriterProgress,
  onTypewriterComplete,
  registerPanelRef,
  registerComposerSurfaceRef,
  registerAnchorRef,
}: ChatPanelProps) {
  const [isServicePickerOpen, setServicePickerOpen] = useState(false);
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const composerPrimaryRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const shouldFocusComposerOnActivateRef = useRef(false);
  const hasActiveTypewriter = conversation.messages.some(
    (message) => typingMessageIds[message.id],
  );
  const currentService =
    getBackendServiceOption(conversation.serviceId) ??
    getBackendServiceOption("backend-services");
  const currentModel =
    getBackendServiceModel(conversation.serviceId, conversation.modelId);
  const currentSelectionLabel = getBackendServiceSelectionLabel(
    conversation.serviceId,
    conversation.modelId,
  );

  const scrollToBottom = useEffectEvent(() => {
    const panelBody = panelBodyRef.current;

    if (!panelBody) {
      return;
    }

    panelBody.scrollTop = panelBody.scrollHeight;
  });

  useEffect(() => {
    scrollToBottom();
  }, [conversation.messages.length]);

  const syncComposerTextareaHeight = useEffectEvent(() => {
    const surface = composerSurfaceRef.current;
    const textarea = composerTextareaRef.current;

    if (!surface || !textarea) {
      return;
    }

    textarea.style.height = `${COMPOSER_MIN_TEXTAREA_HEIGHT_PX}px`;

    const chromeHeight = surface.offsetHeight - textarea.offsetHeight;
    const maxTextareaHeight = Math.max(
      COMPOSER_MIN_TEXTAREA_HEIGHT_PX,
      COMPOSER_MAX_HEIGHT_PX - chromeHeight,
    );
    const nextHeight = Math.max(
      COMPOSER_MIN_TEXTAREA_HEIGHT_PX,
      Math.min(textarea.scrollHeight, maxTextareaHeight),
    );

    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxTextareaHeight ? "auto" : "hidden";
  });

  useLayoutEffect(() => {
    syncComposerTextareaHeight();
  }, [draft, syncComposerTextareaHeight]);

  const focusComposerTextarea = useEffectEvent(() => {
    if (isSubmitting) {
      return;
    }

    const textarea = composerTextareaRef.current;

    if (!textarea) {
      return;
    }

    textarea.focus({ preventScroll: true });
    const cursorPosition = textarea.value.length;
    textarea.setSelectionRange(cursorPosition, cursorPosition);
  });

  useLayoutEffect(() => {
    if (!isActive || isSubmitting || !shouldFocusComposerOnActivateRef.current) {
      return;
    }

    shouldFocusComposerOnActivateRef.current = false;
    focusComposerTextarea();
  }, [focusComposerTextarea, isActive, isSubmitting]);

  useEffect(() => {
    const handleResize = () => {
      syncComposerTextareaHeight();
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [syncComposerTextareaHeight]);

  useEffect(() => {
    if (isActive && !isSubmitting) {
      return;
    }

    setServicePickerOpen(false);
  }, [isActive, isSubmitting]);

  function submitDraft() {
    onSubmit(conversation.id, draft);
  }

  function stopTypewriter() {
    onStopTypewriter(conversation.id);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (hasActiveTypewriter) {
      stopTypewriter();
      return;
    }

    submitDraft();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }

    event.preventDefault();

    if (hasActiveTypewriter) {
      stopTypewriter();
      return;
    }

    submitDraft();
  }

  function handlePanelClick(event: MouseEvent<HTMLElement>) {
    const selection = window.getSelection();

    if (
      selection &&
      !selection.isCollapsed &&
      selection.toString().trim().length > 0
    ) {
      return;
    }

    const composerPrimary = composerPrimaryRef.current;
    const clickIsInsideComposerPrimary = (() => {
      if (!composerPrimary) {
        return false;
      }

      const { clientX, clientY } = event;
      const rect = composerPrimary.getBoundingClientRect();

      return (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      );
    })();

    if (clickIsInsideComposerPrimary) {
      if (isActive) {
        focusComposerTextarea();
        return;
      }

      shouldFocusComposerOnActivateRef.current = true;
      onActivate();
      return;
    }

    if (isActive) {
      return;
    }

    onActivate();
  }

  return (
    <article
      className={isActive ? "chat-panel is-active" : "chat-panel"}
      onClick={handlePanelClick}
      ref={(element) => registerPanelRef(conversation.id, element)}
    >
      <div className="panel-body" ref={panelBodyRef}>
        {conversation.branchAnchor ? (
          <section className="branch-context-card">
            <p className="eyebrow">Branch origin</p>
            <blockquote>“{conversation.branchAnchor.quote}”</blockquote>
            <p>{conversation.branchAnchor.prompt}</p>
          </section>
        ) : null}

        <div className="message-list">
          {conversation.messages.length ? (
            conversation.messages.map((message) => {
              const anchors = anchorsByMessageId[message.id] ?? [];
              const pendingSelection =
                selectionPreview?.messageId === message.id
                  ? selectionPreview
                  : null;
              return (
                <section
                  key={message.id}
                  className={`message-row is-${message.role}`}
                >
                  <div className={`message-bubble is-${message.role}`}>
                    <div className="message-meta">
                      <span>{message.role}</span>
                    </div>
                    <MessageContent
                      anchors={anchors}
                      conversationId={conversation.id}
                      isTypewriting={Boolean(typingMessageIds[message.id])}
                      message={message}
                      onTypewriterProgress={onTypewriterProgress}
                      onTypewriterComplete={onTypewriterComplete}
                      pendingSelection={pendingSelection}
                      registerAnchorRef={registerAnchorRef}
                      theme={theme}
                      typingProgressByMessageId={typingProgressByMessageId}
                    />
                  </div>
                </section>
              );
            })
          ) : (
            <section className="message-empty-state">
              <strong>No messages yet.</strong>
              <p>
                Send a message to start the conversation. Once text appears in
                the thread, you can highlight it to create a branch.
              </p>
            </section>
          )}
        </div>
      </div>

      <form className="composer" onSubmit={handleSubmit}>
        <div className="composer-hidden">
          <input multiple tabIndex={-1} type="file" />
        </div>

        <div
          className="composer-surface"
          data-composer-surface="true"
          data-conversation-id={conversation.id}
          ref={(element) => {
            composerSurfaceRef.current = element;
            registerComposerSurfaceRef(conversation.id, element);
          }}
        >
          <div ref={composerPrimaryRef} className="composer-primary">
            <div className="composer-primary-scroll">
              <textarea
                aria-label={
                  isActive
                    ? "Reply in this conversation"
                    : "Activate this panel to reply"
                }
                className="composer-textarea"
                id={`composer-${conversation.id}`}
                disabled={!isActive || isSubmitting}
                onKeyDown={handleComposerKeyDown}
                onChange={(event) => onDraftChange(event.target.value)}
                placeholder={
                  !isActive
                    ? "Select this panel to write here."
                    : isSubmitting
                      ? "Waiting for the backend response..."
                      : "Ask anything"
                }
                ref={composerTextareaRef}
                rows={1}
                value={draft}
              />
            </div>
          </div>

          {/* <div className="composer-leading">
            <button
              aria-label="Add files and more"
              className="composer-btn"
              type="button"
            >
              <PlusIcon />
            </button>
          </div> */}

          <div className="composer-footer-actions">
            <div className="composer-footer-scroll">
              {/* <div className="composer-pill-composite">
                <button
                  aria-label="Thinking, click to remove"
                  className="composer-pill-remove"
                  type="button"
                >
                  <CloseIcon />
                </button>
                <button
                  aria-label="Thinking mode"
                  className="composer-pill"
                  type="button"
                >
                  <span className="composer-pill-icon">
                    <SparkIcon />
                  </span>
                  <span className="composer-pill-label">Thinking</span>
                  <ChevronDownIcon />
                </button>
              </div> */}

              <button
                aria-expanded={isServicePickerOpen}
                aria-haspopup="dialog"
                aria-label={`Choose AI model. Current selection: ${currentSelectionLabel}`}
                className={
                  isActive ? "composer-service-pill" : "composer-service-pill is-disabled"
                }
                disabled={!isActive || isSubmitting}
                onClick={() => setServicePickerOpen(true)}
                type="button"
              >
                <span className="composer-service-label">AI Model</span>
                <span className="composer-service-value">
                  {currentModel?.label ?? currentService?.label ?? "Automatic"}
                </span>
              </button>
            </div>
          </div>

          <div className="composer-trailing">
            <button
              aria-label={hasActiveTypewriter ? "Stop assistant output" : "Send message"}
              className={
                hasActiveTypewriter
                  ? "composer-action-button is-stop"
                  : "composer-action-button"
              }
              disabled={
                !isActive ||
                (!hasActiveTypewriter && (isSubmitting || !draft.trim()))
              }
              type="submit"
            >
              {hasActiveTypewriter ? <StopIcon /> : <ArrowUpIcon />}
            </button>
          </div>
        </div>
      </form>

      <ServicePickerModal
        currentModelId={conversation.modelId}
        currentServiceId={conversation.serviceId}
        isOpen={isServicePickerOpen}
        onClose={() => setServicePickerOpen(false)}
        onSelectModel={(serviceId, modelId) =>
          onModelChange(conversation.id, serviceId, modelId)
        }
      />
    </article>
  );
}
