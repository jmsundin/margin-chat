import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import MarkdownMessage from "./MarkdownMessage";
import LiveMarkdownEditor from "./LiveMarkdownEditor";
import {
  buildChatOutline,
  getMessageOutlineId,
} from "../lib/chatOutline";
import ServicePickerModal from "./ServicePickerModal";
import {
  getBackendServiceModel,
  getBackendServiceOption,
  getBackendServiceSelectionLabel,
  type RecentBackendServiceSelection,
} from "../lib/services";
import { excerpt } from "../lib/tree";
import { getWheelGestureAxis } from "../lib/wheelGestures";
import {
  clampChatScrollPosition,
  getJumpToTopVisibility,
} from "../lib/chatScroll";
import type {
  BackendServiceId,
  Conversation,
  ConversationNote,
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
const PANEL_AUTO_SCROLL_THRESHOLD_PX = 48;
const PANEL_SCROLL_EDGE_TOLERANCE_PX = 1;
const AGENT_STATUS_STAGE_INTERVAL_MS = 1800;

const AGENT_PENDING_STAGES = [
  {
    description:
      "Deciding whether this request needs workspace tools or a direct answer.",
    label: "Planning the run",
  },
  {
    description:
      "Looking through saved threads, branches, and anchor text for relevant context.",
    label: "Searching your workspace",
  },
  {
    description:
      "Opening the strongest matching conversation context before answering.",
    label: "Reading the best match",
  },
  {
    description:
      "Composing the final reply from the context it found.",
    label: "Writing the response",
  },
] as const;

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

function TypingIndicator() {
  return (
    <div
      aria-atomic="true"
      aria-label="Assistant is typing"
      aria-live="polite"
      className="message-content is-typing-indicator"
      role="status"
    >
      <span aria-hidden="true" className="typing-indicator">
        <span className="typing-indicator-dot" />
        <span className="typing-indicator-dot" />
        <span className="typing-indicator-dot" />
      </span>
    </div>
  );
}

function AgentStatusIndicator() {
  const [stageIndex, setStageIndex] = useState(0);
  const stage = AGENT_PENDING_STAGES[stageIndex];

  useEffect(() => {
    setStageIndex(0);

    const intervalId = window.setInterval(() => {
      setStageIndex((current) =>
        Math.min(current + 1, AGENT_PENDING_STAGES.length - 1),
      );
    }, AGENT_STATUS_STAGE_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <div
      aria-atomic="true"
      aria-label={`Agent is working: ${stage.label}`}
      aria-live="polite"
      className="message-content is-agent-status"
      role="status"
    >
      <div className="agent-status-card">
        <div className="agent-status-head">
          <span className="agent-status-badge">
            Stage {stageIndex + 1} of {AGENT_PENDING_STAGES.length}
          </span>
          <span aria-hidden="true" className="typing-indicator">
            <span className="typing-indicator-dot" />
            <span className="typing-indicator-dot" />
            <span className="typing-indicator-dot" />
          </span>
        </div>
        <strong className="agent-status-title">{stage.label}</strong>
        <p className="agent-status-description">{stage.description}</p>
      </div>
    </div>
  );
}

type BranchMarginPosition = {
  anchorX: number;
  cardX: number;
  top: number;
};

function BranchMarginThreads({
  links,
  onOpenBranch,
  positions,
}: {
  links: MessageAnchorLink[];
  onOpenBranch: (conversationId: string) => void;
  positions: Record<string, BranchMarginPosition>;
}) {
  if (!links.length) {
    return null;
  }

  return (
    <aside aria-label="Branches from this message" className="branch-margin-layer">
      {links.map((link) => {
        const position = positions[link.branchConversationId];
        const connectorWidth = position
          ? Math.max(position.cardX - position.anchorX, 12)
          : 0;

        return (
          <div className="branch-margin-item" key={link.branchConversationId}>
            <span
              aria-hidden="true"
              className={
                position
                  ? "branch-margin-connector is-positioned"
                  : "branch-margin-connector"
              }
              style={
                position
                  ? ({
                      left: `${position.anchorX}px`,
                      top: `${position.top}px`,
                      width: `${connectorWidth}px`,
                    } as CSSProperties)
                  : undefined
              }
            />
            <button
              className={
                position
                  ? "margin-thread-card is-positioned"
                  : "margin-thread-card"
              }
              onClick={() => onOpenBranch(link.branchConversationId)}
              style={
                position
                  ? ({
                      left: `${position.cardX}px`,
                      top: `${position.top - 18}px`,
                    } as CSSProperties)
                  : undefined
              }
              type="button"
            >
              <span className="margin-thread-label">Branch</span>
              <strong>{link.title}</strong>
              <span className="margin-thread-prompt">
                {excerpt(link.anchor.prompt || link.anchor.quote, 78)}
              </span>
              <span className="margin-thread-open">Open branch →</span>
            </button>
          </div>
        );
      })}
    </aside>
  );
}

interface ChatPanelProps {
  anchorsByMessageId: Record<string, MessageAnchorLink[]>;
  conversation: Conversation;
  draft: string;
  documentUploadState?: { error: string | null; uploading: boolean };
  isActive: boolean;
  isSubmitting: boolean;
  recentModelSelections: RecentBackendServiceSelection[];
  theme: "light" | "dark";
  typingProgressByMessageId: Record<string, number>;
  typingMessageIds: Record<string, boolean>;
  selectionPreview: SelectionDraft | null;
  initialScrollTop?: number;
  onActivate: () => void;
  onAddSideChat?: (conversationId: string) => void;
  onDraftChange: (value: string) => void;
  onCreateNote: (args: {
    content: string;
    conversationId: string;
    kind?: "comment" | "side-chat";
    sourceMessageId: string | null;
  }) => string;
  onDeleteNote: (conversationId: string, noteId: string) => void;
  onDeleteDocument?: (documentId: string) => void;
  onModelChange: (
    conversationId: string,
    serviceId: BackendServiceId,
    modelId: string,
  ) => void;
  onOpenBranch: (conversationId: string) => void;
  onStopStreaming: (conversationId: string) => void;
  onUpdateNote: (conversationId: string, noteId: string, content: string) => void;
  onUseNote: (conversationId: string, content: string) => void;
  onStopTypewriter: (conversationId: string) => void;
  onSubmit: (conversationId: string, value: string) => void;
  onUploadDocuments?: (conversationId: string, files: File[]) => void;
  onTypewriterProgress: (messageId: string, visibleCount: number) => void;
  onTypewriterComplete: (messageId: string) => void;
  onScrollPositionChange?: (
    conversationId: string,
    scrollTop: number,
  ) => void;
  onVisibleOutlineChange?: (
    conversationId: string,
    outlineItemId: string,
  ) => void;
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
  registerBranchOriginRef?: (
    conversationId: string,
    element: HTMLElement | null,
  ) => void;
  showBranchMargin?: boolean;
}

function NoteIcon() {
  return (
    <svg aria-hidden="true" className="note-icon" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M5 4h14v12l-4 4H5z" />
      <path d="M15 20v-4h4" />
      <path d="M8 8h8M8 12h6" />
    </svg>
  );
}

function SideNoteIcon() {
  return (
    <svg aria-hidden="true" className="note-icon" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M4 5h16v12H9l-5 4z" />
      <path d="M8 9h8M8 13h5" />
    </svg>
  );
}

function getTypewriterDurationMs(contentLength: number) {
  return Math.min(
    TYPEWRITER_MAX_DURATION_MS,
    Math.max(TYPEWRITER_MIN_DURATION_MS, contentLength * 110),
  );
}

function normalizeWheelDelta(
  delta: number,
  deltaMode: number,
  viewportSize: number,
) {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return delta * 16;
  }

  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return delta * Math.max(viewportSize, 800);
  }

  return delta;
}

function canScrollElement(element: HTMLElement, deltaY: number) {
  if (Math.abs(deltaY) < 0.5) {
    return false;
  }

  const maxScrollTop = element.scrollHeight - element.clientHeight;

  if (maxScrollTop <= PANEL_SCROLL_EDGE_TOLERANCE_PX) {
    return false;
  }

  if (deltaY < 0) {
    return element.scrollTop > PANEL_SCROLL_EDGE_TOLERANCE_PX;
  }

  return element.scrollTop < maxScrollTop - PANEL_SCROLL_EDGE_TOLERANCE_PX;
}

function isScrollPositionNearBottom(args: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}) {
  return (
    args.scrollHeight - args.clientHeight - args.scrollTop <=
    PANEL_AUTO_SCROLL_THRESHOLD_PX
  );
}

function isElementNearBottom(element: HTMLElement) {
  return isScrollPositionNearBottom({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  });
}

function getServicePillValue(args: {
  currentModelLabel: string | null;
  currentSelectionLabel: string;
  serviceId: BackendServiceId;
}) {
  if (args.serviceId === "openai-agent" && args.currentModelLabel) {
    return `Agent · ${args.currentModelLabel}`;
  }

  if (args.serviceId === "backend-services") {
    return args.currentModelLabel ?? args.currentSelectionLabel;
  }

  return args.currentModelLabel ?? args.currentSelectionLabel;
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
  notes: ConversationNote[],
  registerAnchorRef: (
    branchConversationId: string,
    element: HTMLSpanElement | null,
  ) => void,
  pendingSelection: SelectionDraft | null,
  onOpenBranch: (conversationId: string) => void,
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
    type: "anchor" | "note" | "preview";
    startOffset: number;
    endOffset: number;
    branchConversationId?: string;
  }> = anchors.map((link) => ({
    type: "anchor",
    startOffset: link.anchor.startOffset,
    endOffset: link.anchor.endOffset,
    branchConversationId: link.branchConversationId,
  }));

  for (const note of notes) {
    if (note.startOffset === null || note.endOffset === null) continue;
    decorations.push({
      type: "note",
      startOffset: note.startOffset,
      endOffset: note.endOffset,
      branchConversationId: note.id,
    });
  }

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

  const boundaries = [...new Set([0, message.content.length, ...decorations.flatMap((item) => [item.startOffset, item.endOffset])])]
    .filter((offset) => offset >= 0 && offset <= message.content.length)
    .sort((left, right) => left - right);
  const segments = boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    return {
      start,
      end,
      value: message.content.slice(start, end),
      active: decorations.filter((item) => item.startOffset < end && item.endOffset > start),
    };
  });

  return segments.map((segment, index) => {
    if (!segment.active.length) {
      return <span key={`${message.id}-plain-${index}`}>{segment.value}</span>;
    }

    const branch = segment.active.find((item) => item.type === "anchor");
    const hasNote = segment.active.some((item) => item.type === "note");
    const hasPreview = segment.active.some((item) => item.type === "preview");

    return (
      <mark
        aria-label={branch ? `Open branch ${anchors.find((link) => link.branchConversationId === branch.branchConversationId)?.title ?? "conversation"}` : hasNote ? "Text with a personal note" : undefined}
        key={`${message.id}-decoration-${segment.start}`}
        className={`message-anchor${hasNote ? " is-note-anchor" : ""}${hasPreview ? " is-pending-selection" : ""}`}
        onClick={() => {
          if (!branch) return;
          const selection = window.getSelection();

          if (selection && !selection.isCollapsed) {
            return;
          }

          onOpenBranch(branch.branchConversationId!);
        }}
        onKeyDown={(event) => {
          if (!branch) return;
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }

          event.preventDefault();
          onOpenBranch(branch.branchConversationId!);
        }}
        role={branch ? "link" : undefined}
        tabIndex={branch ? 0 : undefined}
      >
        <span
          ref={(element) =>
            branch ? registerAnchorRef(branch.branchConversationId!, element) : undefined
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
  notes: ConversationNote[];
  conversationId: string;
  isStreaming: boolean;
  isTypewriting: boolean;
  message: Message;
  onTypewriterProgress: (messageId: string, visibleCount: number) => void;
  onTypewriterComplete: (messageId: string) => void;
  onOpenBranch: (conversationId: string) => void;
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
  isStreaming,
  isTypewriting,
  message,
  notes,
  onTypewriterProgress,
  onTypewriterComplete,
  onOpenBranch,
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
        notes={notes}
        className={
          isTypewriting || isStreaming
            ? "message-content is-typewriter-active"
            : "message-content"
        }
        content={renderedMessage.content}
        conversationId={conversationId}
        enableMermaidRendering={
          !isStreaming && !isTypewriting && visibleLength >= typewriterChunks.length
        }
        messageId={message.id}
        onOpenBranch={onOpenBranch}
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
          notes,
          registerAnchorRef,
          pendingSelection,
          onOpenBranch,
        )}
      </div>
    )
  );
}

export default function ChatPanel({
  anchorsByMessageId,
  conversation,
  draft,
  documentUploadState = { error: null, uploading: false },
  isActive,
  isSubmitting,
  recentModelSelections,
  theme,
  typingProgressByMessageId,
  typingMessageIds,
  selectionPreview,
  initialScrollTop,
  onActivate,
  onAddSideChat,
  onCreateNote,
  onDeleteNote,
  onDeleteDocument = () => undefined,
  onDraftChange,
  onModelChange,
  onOpenBranch,
  onStopStreaming,
  onStopTypewriter,
  onSubmit,
  onUploadDocuments = () => undefined,
  onTypewriterProgress,
  onTypewriterComplete,
  onUpdateNote,
  onUseNote,
  onScrollPositionChange,
  onVisibleOutlineChange,
  registerPanelRef,
  registerComposerSurfaceRef,
  registerAnchorRef,
  registerBranchOriginRef,
  showBranchMargin = true,
}: ChatPanelProps) {
  const [isServicePickerOpen, setServicePickerOpen] = useState(false);
  const [sideNotesOpen, setSideNotesOpen] = useState(false);
  const [activeSideNoteId, setActiveSideNoteId] = useState<string | null>(null);
  const [sideNoteEditorValue, setSideNoteEditorValue] = useState("");
  const [newSideNoteMessageId, setNewSideNoteMessageId] = useState<string | null>(null);
  const [messageNoteDraft, setMessageNoteDraft] = useState("");
  const [messageNoteTargetId, setMessageNoteTargetId] = useState<string | null>(null);
  const [showJumpToTop, setShowJumpToTop] = useState(false);
  const [branchMarginPositions, setBranchMarginPositions] = useState<
    Record<string, BranchMarginPosition>
  >({});
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const localAnchorRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const composerPrimaryRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const pendingSideNoteSaveRef = useRef<{
    content: string;
    conversationId: string;
    noteId: string;
  } | null>(null);
  const sideNoteSaveTimeoutRef = useRef<number | null>(null);
  const onUpdateNoteRef = useRef(onUpdateNote);
  onUpdateNoteRef.current = onUpdateNote;
  const hasInitializedScrollPositionRef = useRef(false);
  const previousScrollTopRef = useRef(initialScrollTop ?? 0);
  const previousMessageCountRef = useRef(conversation.messages.length);
  const previousPendingAssistantRef = useRef(false);
  const shouldFocusComposerOnActivateRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const hasActiveTypewriter = conversation.messages.some(
    (message) => typingMessageIds[message.id],
  );
  const latestMessage = conversation.messages.at(-1);
  const currentService =
    getBackendServiceOption(conversation.serviceId) ??
    getBackendServiceOption("backend-services");
  const currentModel =
    getBackendServiceModel(conversation.serviceId, conversation.modelId);
  const currentSelectionLabel = getBackendServiceSelectionLabel(
    conversation.serviceId,
    conversation.modelId,
  );
  const servicePillValue = getServicePillValue({
    currentModelLabel: currentModel?.label ?? null,
    currentSelectionLabel,
    serviceId: conversation.serviceId,
  });
  const showPendingAssistant =
    isSubmitting && !hasActiveTypewriter && latestMessage?.role !== "assistant";
  const showAgentStatus =
    showPendingAssistant && conversation.serviceId === "openai-agent";
  const branchMarginLinks = showBranchMargin
    ? Object.values(anchorsByMessageId).flat()
    : [];
  const outlineItems = buildChatOutline(conversation);
  const branchMarginKey = branchMarginLinks
    .map((link) => link.branchConversationId)
    .join("|");
  const conversationNotes = conversation.notes ?? [];
  const commentNotes = conversationNotes.filter((note) => (note.kind ?? "comment") === "comment");
  const sideNotes = conversationNotes.filter((note) => note.kind === "side-chat");
  const activeSideNote = sideNotes.find((note) => note.id === activeSideNoteId) ?? null;
  const messageNotesById = commentNotes.reduce<Record<string, ConversationNote[]>>(
    (groups, note) => {
      if (!note.sourceMessageId) return groups;
      (groups[note.sourceMessageId] ??= []).push(note);
      return groups;
    },
    {},
  );

  useEffect(() => {
    if (activeSideNote) setSideNoteEditorValue(activeSideNote.content);
  }, [activeSideNote?.id]);

  function flushSideNoteSave() {
    if (sideNoteSaveTimeoutRef.current !== null) {
      window.clearTimeout(sideNoteSaveTimeoutRef.current);
      sideNoteSaveTimeoutRef.current = null;
    }
    const pending = pendingSideNoteSaveRef.current;
    if (!pending) return;
    pendingSideNoteSaveRef.current = null;
    onUpdateNoteRef.current(pending.conversationId, pending.noteId, pending.content);
  }

  useEffect(() => () => flushSideNoteSave(), []);

  function submitMessageNote(messageId: string) {
    const content = messageNoteDraft.trim();
    if (!content) return;
    onCreateNote({ content, conversationId: conversation.id, kind: "comment", sourceMessageId: messageId });
    setMessageNoteDraft("");
    setMessageNoteTargetId(null);
  }

  function openNewSideNote(sourceMessageId: string | null) {
    setActiveSideNoteId(null);
    setSideNoteEditorValue("");
    setNewSideNoteMessageId(sourceMessageId);
    setSideNotesOpen(true);
  }

  function updateSideNote(value: string) {
    setSideNoteEditorValue(value);

    if (activeSideNote) {
      pendingSideNoteSaveRef.current = {
        content: value,
        conversationId: conversation.id,
        noteId: activeSideNote.id,
      };
      if (sideNoteSaveTimeoutRef.current !== null) {
        window.clearTimeout(sideNoteSaveTimeoutRef.current);
      }
      sideNoteSaveTimeoutRef.current = window.setTimeout(flushSideNoteSave, 320);
      return;
    }

    if (!value.trim()) return;

    const noteId = onCreateNote({
      content: value,
      conversationId: conversation.id,
      kind: "side-chat",
      sourceMessageId: newSideNoteMessageId,
    });
    setActiveSideNoteId(noteId);
  }

  const syncBranchMarginPositions = useEffectEvent(() => {
    const panelBody = panelBodyRef.current;

    if (!panelBody || !branchMarginLinks.length) {
      setBranchMarginPositions((current) =>
        Object.keys(current).length ? {} : current,
      );
      return;
    }

    const panelRect = panelBody.getBoundingClientRect();
    const cardWidth = panelBody.clientWidth >= 760 ? 220 : 184;
    const cardX = Math.max(panelBody.clientWidth - cardWidth - 24, 0);
    const nextPositions: Record<string, BranchMarginPosition> = {};

    for (const link of branchMarginLinks) {
      const anchorElement = localAnchorRefs.current[link.branchConversationId];

      if (!anchorElement) {
        continue;
      }

      const anchorRect = anchorElement.getBoundingClientRect();
      const anchorX = anchorRect.right - panelRect.left + panelBody.scrollLeft;
      const top =
        anchorRect.top - panelRect.top + panelBody.scrollTop + anchorRect.height / 2;

      nextPositions[link.branchConversationId] = {
        anchorX,
        cardX: Math.max(cardX, anchorX + 12),
        top,
      };
    }

    setBranchMarginPositions((current) => {
      const nextIds = Object.keys(nextPositions);
      const currentIds = Object.keys(current);
      const positionsMatch =
        nextIds.length === currentIds.length &&
        nextIds.every((conversationId) => {
          const currentPosition = current[conversationId];
          const nextPosition = nextPositions[conversationId];

          return (
            currentPosition &&
            Math.abs(currentPosition.anchorX - nextPosition.anchorX) < 0.5 &&
            Math.abs(currentPosition.cardX - nextPosition.cardX) < 0.5 &&
            Math.abs(currentPosition.top - nextPosition.top) < 0.5
          );
        });

      return positionsMatch ? current : nextPositions;
    });
  });

  useLayoutEffect(() => {
    if (!branchMarginLinks.length) {
      setBranchMarginPositions((current) =>
        Object.keys(current).length ? {} : current,
      );
      return undefined;
    }

    let frameId = window.requestAnimationFrame(syncBranchMarginPositions);
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(syncBranchMarginPositions);
    });

    if (panelBodyRef.current) {
      observer.observe(panelBodyRef.current);
    }

    if (messageListRef.current) {
      observer.observe(messageListRef.current);
    }

    for (const link of branchMarginLinks) {
      const anchorElement = localAnchorRefs.current[link.branchConversationId];

      if (anchorElement) {
        observer.observe(anchorElement);
      }
    }

    window.addEventListener("resize", syncBranchMarginPositions);

    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      window.removeEventListener("resize", syncBranchMarginPositions);
    };
  }, [branchMarginKey, conversation.messages]);

  function handleRegisterAnchorRef(
    branchConversationId: string,
    element: HTMLSpanElement | null,
  ) {
    localAnchorRefs.current[branchConversationId] = element;
    registerAnchorRef(branchConversationId, element);
  }

  useLayoutEffect(() => {
    const panelBody = panelBodyRef.current;

    if (!panelBody) {
      return;
    }

    const messageCountChanged =
      previousMessageCountRef.current !== conversation.messages.length;
    const pendingAssistantChanged =
      previousPendingAssistantRef.current !== showPendingAssistant;
    const assistantStreamStarted =
      messageCountChanged &&
      isSubmitting &&
      latestMessage?.role === "assistant";

    previousMessageCountRef.current = conversation.messages.length;
    previousPendingAssistantRef.current = showPendingAssistant;

    if (!hasInitializedScrollPositionRef.current) {
      hasInitializedScrollPositionRef.current = true;
      if (typeof initialScrollTop === "number") {
        panelBody.scrollTop = clampChatScrollPosition(
          initialScrollTop,
          panelBody.scrollHeight - panelBody.clientHeight,
        );
        shouldStickToBottomRef.current = isElementNearBottom(panelBody);
      } else {
        panelBody.scrollTop = panelBody.scrollHeight;
        shouldStickToBottomRef.current = true;
      }
      previousScrollTopRef.current = panelBody.scrollTop;
      return;
    }

    if (!messageCountChanged && !pendingAssistantChanged) {
      return;
    }

    if (assistantStreamStarted) {
      return;
    }

    if (!shouldStickToBottomRef.current) {
      return;
    }

    panelBody.scrollTop = panelBody.scrollHeight;
    shouldStickToBottomRef.current = true;
  }, [
    conversation.messages.length,
    initialScrollTop,
    isSubmitting,
    latestMessage?.role,
    showPendingAssistant,
  ]);

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

    if (isSubmitting) {
      onStopStreaming(conversation.id);
      return;
    }

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

    if (isSubmitting) {
      onStopStreaming(conversation.id);
      return;
    }

    if (hasActiveTypewriter) {
      stopTypewriter();
      return;
    }

    submitDraft();
  }

  function handleDocumentSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (files.length) {
      onUploadDocuments(conversation.id, files);
    }
  }

  function handlePanelClick(event: MouseEvent<HTMLElement>) {
    if (
      isActive &&
      event.target === composerTextareaRef.current
    ) {
      return;
    }

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

  const handlePanelBodyWheel = useEffectEvent((event: WheelEvent) => {
    const panelBody = panelBodyRef.current;

    if (!panelBody || event.ctrlKey) {
      return;
    }

    const normalizedDeltaX = normalizeWheelDelta(
      event.deltaX,
      event.deltaMode,
      panelBody.clientWidth,
    );
    const normalizedDeltaY = normalizeWheelDelta(
      event.deltaY,
      event.deltaMode,
      panelBody.clientHeight,
    );

    if (
      getWheelGestureAxis(normalizedDeltaX, normalizedDeltaY) !== "vertical"
    ) {
      return;
    }

    if (!canScrollElement(panelBody, normalizedDeltaY)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const maxScrollTop = Math.max(
      panelBody.scrollHeight - panelBody.clientHeight,
      0,
    );
    const nextScrollTop = Math.min(
      Math.max(panelBody.scrollTop + normalizedDeltaY, 0),
      maxScrollTop,
    );

    panelBody.scrollTop = nextScrollTop;
    shouldStickToBottomRef.current = isScrollPositionNearBottom({
      clientHeight: panelBody.clientHeight,
      scrollHeight: panelBody.scrollHeight,
      scrollTop: nextScrollTop,
    });
  });

  useEffect(() => {
    const panelBody = panelBodyRef.current;

    if (!panelBody) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      handlePanelBodyWheel(event);
    };

    panelBody.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      panelBody.removeEventListener("wheel", handleWheel);
    };
  }, [handlePanelBodyWheel]);

  const syncStickToBottomState = useEffectEvent(() => {
    const panelBody = panelBodyRef.current;

    if (!panelBody) {
      return;
    }

    const currentScrollTop = panelBody.scrollTop;
    shouldStickToBottomRef.current = isElementNearBottom(panelBody);
    setShowJumpToTop((wasVisible) =>
      getJumpToTopVisibility({
        currentScrollTop,
        previousScrollTop: previousScrollTopRef.current,
        wasVisible,
      }),
    );
    previousScrollTopRef.current = currentScrollTop;
    onScrollPositionChange?.(conversation.id, currentScrollTop);

    if (!onVisibleOutlineChange || !outlineItems.length) {
      return;
    }

    const panelRect = panelBody.getBoundingClientRect();
    const readingLine = panelRect.top + Math.min(panelRect.height * 0.24, 120);
    let visibleOutlineItemId = outlineItems[0]?.id ?? null;

    for (const outlineItem of outlineItems) {
      const target = Array.from(
        panelBody.querySelectorAll<HTMLElement>("[data-chat-outline-id]"),
      ).find(
        (element) => element.dataset.chatOutlineId === outlineItem.id,
      );

      if (!target || target.getBoundingClientRect().top > readingLine) {
        break;
      }

      visibleOutlineItemId = outlineItem.id;
    }

    if (visibleOutlineItemId) {
      onVisibleOutlineChange(conversation.id, visibleOutlineItemId);
    }
  });

  useEffect(() => {
    const panelBody = panelBodyRef.current;

    return () => {
      if (panelBody) {
        onScrollPositionChange?.(conversation.id, panelBody.scrollTop);
      }
    };
  }, [conversation.id, onScrollPositionChange]);

  useEffect(() => {
    const panelBody = panelBodyRef.current;

    if (!panelBody) {
      return;
    }

    const handleScroll = () => {
      syncStickToBottomState();
    };

    handleScroll();
    panelBody.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      panelBody.removeEventListener("scroll", handleScroll);
    };
  }, [syncStickToBottomState]);

  function handleJumpToTop() {
    const panelBody = panelBodyRef.current;

    if (!panelBody) {
      return;
    }

    panelBody.scrollTop = 0;
    previousScrollTopRef.current = 0;
    shouldStickToBottomRef.current = isElementNearBottom(panelBody);
    setShowJumpToTop(false);
    onScrollPositionChange?.(conversation.id, 0);
  }

  return (
    <article
      className={`chat-panel${branchMarginLinks.length ? " has-branch-margin" : ""}${isActive ? " is-active" : ""}${sideNotesOpen ? " has-side-note-panel" : ""}`}
      onClick={handlePanelClick}
      ref={(element) => registerPanelRef(conversation.id, element)}
    >
      {isActive && showJumpToTop ? (
        <button
          aria-label="Jump to top of current chat"
          className="chat-jump-to-top"
          onClick={handleJumpToTop}
          title="Jump to top"
          type="button"
        >
          <ArrowUpIcon />
        </button>
      ) : null}
      <div className="panel-body" ref={panelBodyRef}>
        {conversation.branchAnchor ? (
          <section
            className="branch-context-card"
            ref={(element) =>
              registerBranchOriginRef?.(conversation.id, element)
            }
          >
            <div className="branch-context-head">
              <p className="eyebrow">Branch origin</p>
              {conversation.parentId ? (
                <button
                  className="branch-context-back"
                  onClick={() => onOpenBranch(conversation.parentId!)}
                  type="button"
                >
                  Back to source chat
                </button>
              ) : null}
            </div>
            <blockquote>“{conversation.branchAnchor.quote}”</blockquote>
            <p className="branch-context-prompt">
              {conversation.branchAnchor.prompt}
            </p>
          </section>
        ) : null}

        <div className="message-list" ref={messageListRef}>
          {conversation.messages.length ? (
            <>
              {conversation.messages.map((message) => {
                const anchors = anchorsByMessageId[message.id] ?? [];
                const messageNotes = messageNotesById[message.id] ?? [];
                const pendingSelection =
                  selectionPreview?.messageId === message.id
                    ? selectionPreview
                    : null;
                return (
                  <section
                    key={message.id}
                    className={`message-row is-${message.role}`}
                    data-message-row-id={message.id}
                    data-chat-outline-id={
                      message.role === "user"
                        ? getMessageOutlineId(message.id)
                        : undefined
                    }
                    tabIndex={-1}
                  >
                    <div className={`message-with-margin is-${message.role}${messageNotes.length ? " has-notes" : ""}`}>
                      <div className={`message-bubble is-${message.role}`}>
                        <div className="message-meta">
                          <span>{message.role}</span>
                          <div aria-label="Message note actions" className="message-note-actions" role="group">
                            <button
                              aria-label="Open a side note for this message"
                              className="message-note-add"
                              onClick={() => openNewSideNote(message.id)}
                              title="Side note"
                              type="button"
                            >
                              <SideNoteIcon />
                            </button>
                            <button
                              aria-label="Add a sticky comment to this message"
                              className="message-note-add"
                              onClick={() => {
                                setMessageNoteTargetId((current) => current === message.id ? null : message.id);
                                setMessageNoteDraft("");
                              }}
                              title="Sticky comment"
                              type="button"
                            >
                              <NoteIcon />
                            </button>
                          </div>
                        </div>
                        <MessageContent
                          anchors={anchors}
                          conversationId={conversation.id}
                          isStreaming={
                            isSubmitting && latestMessage?.id === message.id
                          }
                          isTypewriting={Boolean(typingMessageIds[message.id])}
                          message={message}
                          notes={messageNotes}
                          onTypewriterProgress={onTypewriterProgress}
                          onTypewriterComplete={onTypewriterComplete}
                          onOpenBranch={onOpenBranch}
                          pendingSelection={pendingSelection}
                          registerAnchorRef={handleRegisterAnchorRef}
                          theme={theme}
                          typingProgressByMessageId={typingProgressByMessageId}
                        />
                        {messageNoteTargetId === message.id ? (
                          <div className="message-note-composer">
                            <div className="personal-note-head">
                              <span><NoteIcon /> Sticky comment</span>
                              <span className="personal-note-private">Not sent to AI</span>
                            </div>
                            <LiveMarkdownEditor
                              ariaLabel="Sticky comment"
                              autoFocus
                              className="is-compact"
                              onChange={setMessageNoteDraft}
                              placeholder="Write a private thought…"
                              value={messageNoteDraft}
                            />
                            <div className="message-note-composer-actions">
                              <button onClick={() => setMessageNoteTargetId(null)} type="button">Cancel</button>
                              <button disabled={!messageNoteDraft.trim()} onClick={() => submitMessageNote(message.id)} type="button">Save note</button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </section>
                );
              })}
              {showPendingAssistant ? (
                <section className="message-row is-assistant">
                  <div className="message-bubble is-assistant is-pending">
                    <div className="message-meta">
                      <span>assistant</span>
                    </div>
                    {showAgentStatus ? <AgentStatusIndicator /> : <TypingIndicator />}
                  </div>
                </section>
              ) : null}
            </>
          ) : (
            <section className="message-empty-state">
              <strong>What should we explore?</strong>
              <p>
                Start a conversation, then highlight any response to open a
                focused branch without losing your place.
              </p>
            </section>
          )}
        </div>
        <BranchMarginThreads
          links={branchMarginLinks}
          onOpenBranch={onOpenBranch}
          positions={branchMarginPositions}
        />
      </div>

      <form className="composer" onSubmit={handleSubmit}>
        <div className="composer-hidden">
          <input
            accept=".pdf,.docx,.txt,.md,.markdown,.csv,.json,.html,.htm,.xml,.yaml,.yml,.js,.jsx,.ts,.tsx,.mjs,.css,.py,.rb,.rs,.go,.java,.c,.cpp,.sql,text/*,application/pdf,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            multiple
            onChange={handleDocumentSelection}
            ref={documentInputRef}
            tabIndex={-1}
            type="file"
          />
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
          {(conversation.documents?.length ?? 0) > 0 ||
          documentUploadState.uploading ||
          documentUploadState.error ? (
            <div className="composer-document-area">
              <div aria-label="Attached documents" className="composer-document-list">
                {(conversation.documents ?? []).map((document) => (
                  <span className="composer-document-chip" key={document.id}>
                    <span aria-hidden="true" className="composer-document-icon">
                      DOC
                    </span>
                    <span className="composer-document-name" title={document.filename}>
                      {document.filename}
                    </span>
                    <button
                      aria-label={`Delete ${document.filename} from every chat`}
                      disabled={documentUploadState.uploading || isSubmitting}
                      onClick={() => onDeleteDocument(document.id)}
                      title="Delete this document from every chat"
                      type="button"
                    >
                      <CloseIcon />
                    </button>
                  </span>
                ))}
                {documentUploadState.uploading ? (
                  <span className="composer-document-chip is-loading" role="status">
                    Processing document…
                  </span>
                ) : null}
              </div>
              {documentUploadState.error ? (
                <p className="composer-document-error" role="alert">
                  {documentUploadState.error}
                </p>
              ) : null}
            </div>
          ) : null}

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

          <div className="composer-leading">
            <button
              aria-label="Attach documents"
              className="composer-btn"
              disabled={
                !isActive ||
                isSubmitting ||
                documentUploadState.uploading ||
                (conversation.documents?.length ?? 0) >= 20
              }
              onClick={() => documentInputRef.current?.click()}
              type="button"
            >
              <PlusIcon />
            </button>
          </div>

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

              {onAddSideChat ? (
                <button
                  aria-label="Add side chat"
                  className="composer-side-chat-button"
                  disabled={!isActive}
                  onClick={() => onAddSideChat(conversation.id)}
                  type="button"
                >
                  <PlusIcon />
                  <span>Add side chat</span>
                </button>
              ) : null}
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
                  {servicePillValue}
                </span>
              </button>
              <button
                aria-expanded={sideNotesOpen}
                aria-label="Open a new side note"
                className="composer-notes-button"
                onClick={() => openNewSideNote(null)}
                type="button"
              >
                <SideNoteIcon />
                <span>Side note</span>
                {sideNotes.length ? <strong>{sideNotes.length}</strong> : null}
              </button>
            </div>
          </div>

          <div className="composer-trailing">
            <button
              aria-label={
                isSubmitting || hasActiveTypewriter
                  ? "Stop assistant output"
                  : "Send message"
              }
              className={
                isSubmitting || hasActiveTypewriter
                  ? "composer-action-button is-stop"
                  : "composer-action-button"
              }
              disabled={
                !isActive ||
                (!isSubmitting && !hasActiveTypewriter && !draft.trim())
              }
              type="submit"
            >
              {isSubmitting || hasActiveTypewriter ? <StopIcon /> : <ArrowUpIcon />}
            </button>
          </div>
        </div>
      </form>

      {sideNotesOpen ? (
        <div className="side-note-panel-backdrop" onClick={() => setSideNotesOpen(false)} role="presentation">
          <aside aria-label="Side notes" className="side-note-panel" onClick={(event) => event.stopPropagation()}>
            <header className="side-note-panel-head">
              <div>
                <p className="eyebrow">Side note</p>
                <h2>Notes beside the chat</h2>
                <p>Private workspace · Not sent to AI</p>
              </div>
              <button aria-label="Close side notes" className="notes-drawer-close" onClick={() => setSideNotesOpen(false)} type="button"><CloseIcon /></button>
            </header>
            <nav aria-label="Side note documents" className="side-note-tabs">
              <button
                className={!activeSideNote ? "side-note-tab is-active" : "side-note-tab"}
                onClick={() => openNewSideNote(null)}
                type="button"
              >
                <PlusIcon /> New note
              </button>
              {sideNotes.map((note, index) => (
                <button
                  className={activeSideNote?.id === note.id ? "side-note-tab is-active" : "side-note-tab"}
                  key={note.id}
                  onClick={() => {
                    setActiveSideNoteId(note.id);
                    setSideNoteEditorValue(note.content);
                    setNewSideNoteMessageId(note.sourceMessageId);
                  }}
                  type="button"
                >
                  <SideNoteIcon />
                  <span>{excerpt(note.content.replace(/[#*_>`~-]/g, " ").replace(/\s+/g, " ").trim(), 28) || `Side note ${index + 1}`}</span>
                </button>
              ))}
            </nav>
            <div className="side-note-editor-shell">
              {(activeSideNote?.sourceMessageId ?? newSideNoteMessageId) ? (
                <button
                  className="side-note-source"
                  onClick={() => {
                    const messageId = activeSideNote?.sourceMessageId ?? newSideNoteMessageId;
                    if (!messageId) return;
                    const target = panelBodyRef.current?.querySelector<HTMLElement>(`[data-message-row-id="${CSS.escape(messageId)}"]`);
                    target?.scrollIntoView({ behavior: "smooth", block: "center" });
                    target?.focus({ preventScroll: true });
                  }}
                  type="button"
                >
                  Linked to message · View in chat
                </button>
              ) : null}
              <LiveMarkdownEditor
                ariaLabel="Side note Markdown editor"
                autoFocus
                className="is-side-note"
                onBlur={flushSideNoteSave}
                onChange={updateSideNote}
                placeholder="Start a side note… Use # headings, **bold**, lists, links, quotes, and code."
                value={sideNoteEditorValue}
              />
              <p className="side-note-editor-hint">
                Live Preview · Enter continues Markdown blocks. Esc leaves the editor.
              </p>
            </div>
            <footer className="side-note-panel-actions">
              <button
                disabled={!sideNoteEditorValue.trim()}
                onClick={() => onUseNote(conversation.id, sideNoteEditorValue)}
                type="button"
              >
                Use in next message
              </button>
              {activeSideNote ? (
                <button
                  className="is-danger"
                  onClick={() => {
                    onDeleteNote(conversation.id, activeSideNote.id);
                    setActiveSideNoteId(null);
                    setSideNoteEditorValue("");
                    setNewSideNoteMessageId(null);
                  }}
                  type="button"
                >
                  Delete side note
                </button>
              ) : null}
            </footer>
          </aside>
        </div>
      ) : null}

      <ServicePickerModal
        currentModelId={conversation.modelId}
        currentServiceId={conversation.serviceId}
        isOpen={isServicePickerOpen}
        onClose={() => setServicePickerOpen(false)}
        recentSelections={recentModelSelections}
        onSelectModel={(serviceId, modelId) =>
          onModelChange(conversation.id, serviceId, modelId)
        }
      />
    </article>
  );
}
