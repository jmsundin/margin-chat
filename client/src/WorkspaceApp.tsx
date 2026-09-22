import { getNextTheme, type ThemeMode } from "./lib/appearance";
import "./workspace-improvements.css";
import { getChatPanelLayout, resizeChatPanels } from "./lib/chatPanelLayout";
import { getConversationAnnotationPreview } from "./lib/annotationPreview";
import {
  startTransition,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import AppSettingsModal from "./components/AppSettingsModal";
import BranchRail from "./components/BranchRail";
import DocumentPanel from "./components/DocumentPanel";
import { getEditableDocument, getEditableDocumentText, insertDocumentBlock, remapDocumentRange, splitDocumentMarkdown, type EditableDocument, type DocumentGeneration } from "./lib/editableDocument";
import { buildDocumentAIMessage, type DocumentAIRequest } from "./lib/documentAI";
import { acceptDocumentVersion, undoDocumentInsertion, remapDocumentReplacement } from "./lib/documentVersions";
import { remapDocumentAnchor } from "./lib/documentAnchors";
import NotificationToast from "./components/NotificationToast";
import AIControls from "./components/AIControls";
import JevRelatedItems from "./components/JevRelatedItems";
import { useJevAssistance, useJevPreference } from "./lib/useJevAssistance";
import { applyJevCategories, withJevConsent } from "./lib/jevAssistance";
import { applyJevGroupSuggestions } from "./lib/jevGrouping";
import { getThreadCategoryLabel } from "./lib/threadCategories";
import { normalizeAISettings } from "@margin-chat/workspace-contracts";
import { prepareAIContext } from "./lib/aiContext";
import ConnectorOverlay from "./components/ConnectorOverlay";
import ConversationTreeNode from "./components/ConversationTreeNode";
import KnowledgeGraphWorkspace from "./components/KnowledgeGraphWorkspace";
import { saveUrlMapNode } from "./lib/urlMap";
import { findSavedPublicTopic, savePublicTopic } from "./lib/publicTopicWorkspace";
import type { PublicTopic } from "./lib/publicKnowledge";
import { addMapChildNote, createMapNote, getRemovableMapNote, removeMapNote, restoreMapNote, setPersonalMapConnection } from "./lib/graphWorkspaceEdits";
import { useTopicExpansion } from "./lib/useTopicExpansion";
import GraphSourceFocus from "./components/GraphSourceFocus";
import { ConversationGroupSelect, ConversationGroupPickerContext } from "./components/ConversationGroupControls";
import MainChatTileView from "./components/MainChatTileView";
import MarginNoteTreeNode from "./components/MarginNoteTreeNode";
import ProfileModal from "./components/ProfileModal";
import ChatHistoryImport from "./components/ChatHistoryImport";
import CaptureInbox from "./components/CaptureInbox";
import { openCaptureAsNote } from "./lib/captures";
import SearchModal from "./components/SearchModal";
import SearchSourceFocus from "./components/SearchSourceFocus";
import { resolveSearchSource } from "./lib/searchSource";
import type { SearchEvidenceRef } from "./lib/conversationSearch";
import StandaloneNotePanel from "./components/StandaloneNotePanel";
import ThreadSidebar from "./components/ThreadSidebar";
import ResizableSidebar from "./components/ResizableSidebar";
import {
  ApiError,
  requestDeleteDocument,
  requestChatReply,
  requestChatTitle,
  requestUploadDocument,
} from "./lib/api";
import {
  getRecentModelSelectionsStorageKey,
  getStateSavedAtStorageKey,
  getStateStorageKey,
  loadRecentModelSelections,
  loadStoredState,
} from "./lib/appState";
import { getConversationRequestPayload } from "./lib/chatContext";
import { useChatStreams } from "./lib/useChatStreams";
import { addChildConversation, addRootConversation, appendMessage, appendMessageDelta, deleteThread, removeConversationDocument } from "./lib/workspaceCommands";
import { buildSearchResults, buildThreadSummaries } from "./lib/conversationSearch";
import {
  CONVERSATION_GROUP_COLORS,
  assignConversationToGroup,
  getConversationGroupId,
} from "./lib/conversationGroups";
import {
  getSelectionTooltipLayout,
  writeSelectedQuoteToClipboard,
} from "./lib/selectionTooltip";
import {
  getHorizontalWheelDelta,
  isProfileDialogWheelTarget,
} from "./lib/wheelGestures";
import { canSyncWorkspaceToCloud } from "./lib/workspaceStorage";
import { useMarkdownVault } from "./lib/useMarkdownVault";
import {
  getBackendServiceLabel,
  resolveBackendServiceModelId,
  type RecentBackendServiceSelection,
  upsertRecentBackendServiceSelection,
} from "./lib/services";
import {
  createDefaultGraphNodeLayout,
  normalizeGraphLayouts,
} from "./lib/graphLayout";
import {
  buildConversationTitle,
  collectConversationTreeIds,
  excerpt,
  getBranchNavigation,
  getConversationPath,
  getConversationRootId,
  getConversationTreeLanes,
} from "./lib/tree";
import { buildEditableDocumentOutline } from "./lib/chatOutline";
import { getConversationSelectionViewMode } from "./lib/conversationNavigation";
import {
  getStandaloneNoteContextMessageId,
  upsertStandaloneNoteContextMessage,
} from "./lib/standaloneNotes";
import {
  DEFAULT_MAIN_CHAT_TITLE,
  DEFAULT_SIDE_CHAT_TITLE,
  createChildConversation,
  createMainConversation,
  createSideConversation,
  createStandaloneNoteConversation,
} from "./initialState";
import type {
  AIExecutionRecord,
  AISettings,
  AppState,
  ApiKeyProvider,
  ApiKeySettings,
  AuthenticatedUser,
  BackendServiceId,
  ConnectionLine,
  ConnectorOcclusionRect,
  Conversation,
  ConversationNote,
  GraphNodeLayout,
  MainViewMode,
  Message,
  MessageAnchorLink,
  SelectionDraft,
} from "./types";

const LEFT_SIDEBAR_STORAGE_KEY = "margin-chat-left-sidebar-open";
const CHAT_PANEL_WIDTH_STORAGE_KEY = "margin-chat-panel-width";
const BRANCH_PROMPT_PLACEHOLDER = "Ask about the selected text...";
const NOTE_PROMPT_PLACEHOLDER = "Add a private thought about this text...";
const EXPLAIN_SELECTION_PROMPT = "Explain the selected text.";
const TOOLTIP_VIEWPORT_MARGIN = 16;
const CHAT_PANEL_DEFAULT_WIDTH_PX = 760;
const CHAT_PANEL_KEYBOARD_STEP_PX = 24;
const CHAT_PANEL_MAX_WIDTH_PX = 980;
const CHAT_PANEL_MIN_WIDTH_PX = 320;
const MOBILE_PANEL_RESIZE_BREAKPOINT_PX = 900;

function normalizeWheelDelta(
  delta: number,
  deltaMode: number,
  pageSize: number,
) {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return delta * 16;
  }

  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return delta * pageSize;
  }

  return delta;
}
const FALLBACK_TOOLTIP_SIZE = {
  height: 300,
  width: 360,
};

function SendIcon() {
  return (
    <svg
      aria-hidden="true"
      className="send-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      <path d="M21 3 10 14" />
      <path d="m21 3-7 18-4-7-7-4 18-7Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="selection-close-icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.9"
      viewBox="0 0 24 24"
    >
      <path d="m7 7 10 10" />
      <path d="m17 7-10 10" />
    </svg>
  );
}

function SidebarPanelIcon() {
  return (
    <svg
      aria-hidden="true"
      className="workspace-menu-icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

function getIsMobileViewport() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.matchMedia(
    `(max-width: ${MOBILE_PANEL_RESIZE_BREAKPOINT_PX}px)`,
  ).matches;
}

function loadInitialLeftSidebarOpen(): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  if (getIsMobileViewport()) {
    return false;
  }

  try {
    const storedValue = window.localStorage.getItem(LEFT_SIDEBAR_STORAGE_KEY);

    if (storedValue === "true") {
      return true;
    }

    if (storedValue === "false") {
      return false;
    }
  } catch {
    return true;
  }

  return true;
}

function getChatPanelWidthBounds() {
  // This is the saved desktop preference. The current canvas separately limits
  // the rendered width, so visiting a phone never shrinks the desktop setting.
  return {
    max: CHAT_PANEL_MAX_WIDTH_PX,
    min: CHAT_PANEL_MIN_WIDTH_PX,
  };
}

function loadInitialChatPanelWidth() {
  const bounds = getChatPanelWidthBounds();

  if (typeof window === "undefined") {
    return clamp(
      CHAT_PANEL_DEFAULT_WIDTH_PX,
      bounds.min,
      bounds.max,
    );
  }

  try {
    const rawStoredValue = window.localStorage.getItem(
      CHAT_PANEL_WIDTH_STORAGE_KEY,
    );
    const storedValue =
      rawStoredValue === null ? Number.NaN : Number(rawStoredValue);

    if (Number.isFinite(storedValue)) {
      return clamp(storedValue, bounds.min, bounds.max);
    }
  } catch {
    return clamp(
      CHAT_PANEL_DEFAULT_WIDTH_PX,
      bounds.min,
      bounds.max,
    );
  }

  return clamp(
    CHAT_PANEL_DEFAULT_WIDTH_PX,
    bounds.min,
    bounds.max,
  );
}

function isApiErrorStatus(error: unknown, statusCode: number) {
  return error instanceof ApiError && error.statusCode === statusCode;
}

function isAbortError(error: unknown) {
  return typeof DOMException !== "undefined" && error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function getErrorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

const INITIAL_LEFT_SIDEBAR_OPEN = loadInitialLeftSidebarOpen();
const INITIAL_CHAT_PANEL_WIDTH = loadInitialChatPanelWidth();

interface WorkspaceAppProps {
  billingDashboard: import("./types").BillingDashboardData | null;
  billingDashboardLoading: boolean;
  billingDashboardError: string | null;
  billingOpenRequest: number;
  onRefreshBilling: () => void | Promise<void>;
  onAddMoney: (amountCents: number) => void | Promise<void>;
  billingNotice: { kind: "error" | "info" | "success"; message: string } | null;
  onDismissBillingNotice: () => void;
  onAuthExpired: (message?: string) => void;
  onBillingRequired: (message?: string) => void;
  billingErrorMessage: string | null;
  billingSubmitting: boolean;
  onLogout: () => void;
  onManageBilling: () => void | Promise<void>;
  onStartSubscription: () => void | Promise<void>;
  onSetTheme: Dispatch<SetStateAction<ThemeMode>>;
  onUpdateProfile: (args: {
    displayName: string;
    email: string;
  }) => Promise<AuthenticatedUser>;
  onUpdateApiKeys: (args: {
    keys: Partial<Record<ApiKeyProvider, string | null>>;
  }) => Promise<ApiKeySettings>;
  theme: ThemeMode;
  user: AuthenticatedUser;
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function areGraphLayoutsEqual(
  left: Record<string, GraphNodeLayout>,
  right: Record<string, GraphNodeLayout>,
) {
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);

  if (leftIds.length !== rightIds.length) {
    return false;
  }

  return leftIds.every((conversationId) => {
    const leftLayout = left[conversationId];
    const rightLayout = right[conversationId];

    return (
      Boolean(rightLayout) &&
      leftLayout.x === rightLayout.x &&
      leftLayout.y === rightLayout.y &&
      leftLayout.width === rightLayout.width &&
      leftLayout.height === rightLayout.height &&
      Boolean(leftLayout.positioned) === Boolean(rightLayout.positioned) &&
      leftLayout.treeOriginX === rightLayout.treeOriginX &&
      leftLayout.treeOriginY === rightLayout.treeOriginY
    );
  });
}

function buildBackendErrorReply(
  serviceId: BackendServiceId,
  error: unknown,
): string {
  const message =
    error instanceof Error && error.message
      ? error.message
      : "The backend request failed unexpectedly.";

  return `${getBackendServiceLabel(serviceId)} request failed.\n\n${message}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function getLineRect(element: Element | null): DOMRect | null {
  if (!element) {
    return null;
  }

  const clientRect = Array.from(element.getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .at(-1);

  if (clientRect) {
    return clientRect;
  }

  const fallbackRect = element.getBoundingClientRect();

  if (fallbackRect.width > 0 && fallbackRect.height > 0) {
    return fallbackRect;
  }

  return null;
}

function getElementRect(element: Element | null): DOMRect | null {
  if (!element) {
    return null;
  }

  const rect = element.getBoundingClientRect();

  if (rect.width > 0 && rect.height > 0) {
    return rect;
  }

  return null;
}

function getSelectionSourceElement(node: Node | null): HTMLDivElement | null {
  if (!node) {
    return null;
  }

  const selector =
    "[data-message-bubble='true'], [data-selection-source='standalone-note']";

  if (node instanceof HTMLDivElement) {
    return node.closest(selector);
  }

  if (node instanceof HTMLElement) {
    return node.closest(selector);
  }

  return node.parentElement?.closest(selector) ?? null;
}

function getElementForSelectionNode(node: Node) {
  return node instanceof Element ? node : node.parentElement;
}

function getCodeMirrorSelection(
  sourceElement: HTMLDivElement,
  range: Range,
): { endOffset: number; quote: string; startOffset: number } | null {
  const startElement = getElementForSelectionNode(range.startContainer);
  const endElement = getElementForSelectionNode(range.endContainer);

  if (
    !startElement?.closest(".cm-content") ||
    !endElement?.closest(".cm-content")
  ) {
    return null;
  }

  const startRenderedBlock = startElement.closest<HTMLElement>(
    ".cm-live-rendered-block",
  );
  const endRenderedBlock = endElement.closest<HTMLElement>(
    ".cm-live-rendered-block",
  );

  // Inactive Live Preview lines are CodeMirror replacement widgets, so their
  // native DOM selection does not update EditorState. Map the visible quote
  // back into the widget's Markdown source instead.
  if (startRenderedBlock && startRenderedBlock === endRenderedBlock) {
    const rawQuote = range.toString();
    const quote = rawQuote.trim();
    const source = startRenderedBlock.dataset.sourceValue ?? "";
    const blockStart = Number.parseInt(
      startRenderedBlock.dataset.sourceFrom ?? "",
      10,
    );
    const prefixRange = range.cloneRange();
    prefixRange.selectNodeContents(startRenderedBlock);
    prefixRange.setEnd(range.startContainer, range.startOffset);
    const expectedQuoteStart =
      prefixRange.toString().length +
      (rawQuote.length - rawQuote.trimStart().length);
    let quoteStart = -1;

    if (quote) {
      for (
        let candidate = source.indexOf(quote);
        candidate >= 0;
        candidate = source.indexOf(quote, candidate + 1)
      ) {
        if (
          quoteStart < 0 ||
          Math.abs(candidate - expectedQuoteStart) <
            Math.abs(quoteStart - expectedQuoteStart)
        ) {
          quoteStart = candidate;
        }
      }
    }

    if (quote && Number.isFinite(blockStart) && quoteStart >= 0) {
      return {
        endOffset: blockStart + quoteStart + quote.length,
        quote,
        startOffset: blockStart + quoteStart,
      };
    }
  }

  const startOffset = Number.parseInt(
    sourceElement.dataset.editorSelectionStart ?? "",
    10,
  );
  const endOffset = Number.parseInt(
    sourceElement.dataset.editorSelectionEnd ?? "",
    10,
  );
  const rawQuote = sourceElement.dataset.editorSelectionQuote ?? "";
  const quote = rawQuote.trim();
  const leadingWhitespace = rawQuote.length - rawQuote.trimStart().length;
  const trailingWhitespace = rawQuote.length - rawQuote.trimEnd().length;

  if (
    !quote ||
    !Number.isFinite(startOffset) ||
    !Number.isFinite(endOffset) ||
    endOffset <= startOffset
  ) {
    return null;
  }

  return {
    endOffset: endOffset - trailingWhitespace,
    quote,
    startOffset: startOffset + leadingWhitespace,
  };
}

function getAnchorsByMessageId(
  conversations: Record<string, Conversation>,
  conversationId: string,
): Record<string, MessageAnchorLink[]> {
  const links: Record<string, MessageAnchorLink[]> = {};

  for (const conversation of Object.values(conversations)) {
    if (
      !conversation.branchAnchor ||
      conversation.branchAnchor.sourceConversationId !== conversationId
    ) {
      continue;
    }

    const messageId = conversation.branchAnchor.sourceMessageId;
    const bucket = links[messageId] ?? [];

    bucket.push({
      branchConversationId: conversation.id,
      title: conversation.title,
      anchor: conversation.branchAnchor,
      preview: getConversationAnnotationPreview(conversation),
    });

    links[messageId] = bucket;
  }

  return links;
}

function hasOverlappingAnchor(
  conversations: Record<string, Conversation>,
  selectionDraft: SelectionDraft,
): boolean {
  // A zero-length range represents the whole message, without a passage highlight.
  if (selectionDraft.endOffset <= selectionDraft.startOffset) return false;
  return Object.values(conversations).some((conversation) => {
    const anchor = conversation.branchAnchor;

    if (
      !anchor || anchor.endOffset <= anchor.startOffset ||
      anchor.sourceConversationId !== selectionDraft.conversationId ||
      anchor.sourceMessageId !== selectionDraft.messageId
    ) {
      return false;
    }

    return (
      selectionDraft.startOffset < anchor.endOffset &&
      selectionDraft.endOffset > anchor.startOffset
    );
  });
}

export default function WorkspaceApp({
  billingDashboard, billingDashboardLoading, billingDashboardError, billingOpenRequest, onRefreshBilling, onAddMoney,
  billingNotice,
  onDismissBillingNotice,
  onAuthExpired,
  onBillingRequired,
  billingErrorMessage,
  billingSubmitting,
  onLogout,
  onManageBilling,
  onStartSubscription,
  onSetTheme,
  onUpdateProfile,
  onUpdateApiKeys,
  theme,
  user,
}: WorkspaceAppProps) {
  const stateStorageKey = getStateStorageKey(user.id);
  const stateSavedAtStorageKey = getStateSavedAtStorageKey(user.id);
  const recentModelSelectionsStorageKey = getRecentModelSelectionsStorageKey(
    user.id,
  );
  const initialStoredStateRef = useRef<ReturnType<typeof loadStoredState> | null>(
    null,
  );

  if (!initialStoredStateRef.current) {
    initialStoredStateRef.current = loadStoredState(
      stateStorageKey,
      stateSavedAtStorageKey,
    );
  }

  const [state, setState] = useState<AppState>(
    () => initialStoredStateRef.current!.state,
  );
  const [recentModelSelections, setRecentModelSelections] = useState<
    RecentBackendServiceSelection[]
  >(() => loadRecentModelSelections(recentModelSelectionsStorageKey));
  const vault = useMarkdownVault({ user, state, setState, legacyHasState: initialStoredStateRef.current.hasStoredState });
  const storageMode = vault.storageMode;
  const cloudBackupMatchesLocal = vault.matchesCloud;
  const localDirectoryStatus = vault.localDirectoryStatus;
  const [mainViewMode, setMainViewMode] = useState<MainViewMode>("chat");
  const [noteOpenRequest, setNoteOpenRequest] = useState<{ noteId: string; sequence: number } | null>(null);
  const [graphFocusRequest, setGraphFocusRequest] = useState<{
    conversationId: string;
    requestId: number;
    openReader?: boolean;
    neighborhoodDepth?: number;
    preserveMapMode?: boolean;
  } | null>(null);
  const graphFocusRequestCounterRef = useRef(0);
  const mapUndoRef = useRef<((current: AppState) => AppState) | null>(null);
  const [mapEditMessage, setMapEditMessage] = useState("");
  const topicExpansion = useTopicExpansion({ state, setState, userId: user.id, onAuthExpired,
    onBillingRefresh: () => { void onRefreshBilling(); },
    onReady: (conversationId) => {
      setGraphFocusRequest({ conversationId, requestId: ++graphFocusRequestCounterRef.current, neighborhoodDepth: 2, preserveMapMode: true });
      mapUndoRef.current = null;
      setMapEditMessage("AI subgraph added. Open any child note to review or edit it.");
    },
  });
  const [leftSidebarOpen, setLeftSidebarOpen] =
    useState(INITIAL_LEFT_SIDEBAR_OPEN);
  const [graphExplorerContainer, setGraphExplorerContainer] = useState<HTMLDivElement | null>(null);
  const [mapSidebarSection, setMapSidebarSection] = useState<"chats" | "explore">("chats");
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    getIsMobileViewport(),
  );
  const [chatPanelWidth] = useState(INITIAL_CHAT_PANEL_WIDTH);
  const [isResizingChatPanel, setIsResizingChatPanel] = useState(false);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [resizingChatPanelConversationId, setResizingChatPanelConversationId] =
    useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectionResponseDestination, setSelectionResponseDestination] = useState<"inline" | "side">("inline");
  const [selectionReplaceText, setSelectionReplaceText] = useState(false);
  const [documentErrors, setDocumentErrors] = useState<Record<string, string>>({});
  const { executions: chatExecutions, pendingConversationIds } = useChatStreams(appendAssistantDelta, saveExecutionDetails);
  const [documentUploadByConversationId, setDocumentUploadByConversationId] =
    useState<Record<string, { error: string | null; uploading: boolean }>>({});
  const [typingMessageIds, setTypingMessageIds] = useState<Record<string, boolean>>(
    {},
  );
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(
    null,
  );
  const [selectionIntent, setSelectionIntent] = useState<"branch" | "note">("branch");
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [jevEnabled, setJevEnabled] = useJevPreference(user.id);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [historyImportOpen, setHistoryImportOpen] = useState(false);
  const [profileInitialTab, setProfileInitialTab] = useState<"account" | "storage" | "billing">("account");
  const previousPendingChats = useRef(pendingConversationIds);
  const refreshBillingAfterChat = useEffectEvent(() => { void onRefreshBilling(); });
  useEffect(() => {
    const completed = Object.keys(previousPendingChats.current).some((id) => !pendingConversationIds[id]);
    previousPendingChats.current = pendingConversationIds;
    if (completed) refreshBillingAfterChat();
  }, [pendingConversationIds]);
  useEffect(() => {
    if (!billingOpenRequest) return;
    setProfileInitialTab("billing");
    setProfileModalOpen(true);
  }, [billingOpenRequest]);
  const [captureInboxOpen, setCaptureInboxOpen] = useState(() => new URLSearchParams(window.location.search).has("inbox"));
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchSourceRequest, setSearchSourceRequest] = useState<{ source: SearchEvidenceRef; sequence: number } | null>(null);
  const [activeOutlineItemId, setActiveOutlineItemId] = useState<string | null>(
    null,
  );
  const [toolbarSize, setToolbarSize] = useState(FALLBACK_TOOLTIP_SIZE);
  const [connections, setConnections] = useState<ConnectionLine[]>([]);
  const [connectorOcclusionRects, setConnectorOcclusionRects] = useState<
    ConnectorOcclusionRect[]
  >([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [resizedPanelWidths, setResizedPanelWidths] = useState<Record<string, number>>({});
  const toolbarRef = useRef<HTMLFormElement>(null);
  const panelRefs = useRef<Record<string, HTMLElement | null>>({});
  const anchorRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const branchOriginRefs = useRef<Record<string, HTMLElement | null>>({});
  const composerSurfaceRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const treeNodeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const panelScrollPositionsRef = useRef<Record<string, number>>({});
  const suppressNextChatAutoCenterRef = useRef(false);
  const pendingTreeLaneFocusRef = useRef<string | null>(null);
  const typingProgressByMessageIdRef = useRef<Record<string, number>>({});
  const currentStateRef = useRef(state);
  currentStateRef.current = state;
  const selectionSyncFrameRef = useRef(0);
  const panelResizeStateRef = useRef<{
    conversationId: string;
    originWidth: number;
    startClientX: number;
    direction: 1 | -1;
    companionId?: string;
    companionWidth?: number;
    maxWidth: number;
    pointerId: number;
    handle: HTMLDivElement;
    previousCursor: string;
    previousUserSelect: string;
  } | null>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const cloudSyncEnabled = canSyncWorkspaceToCloud(user);
  const cloudBackupSizeBytes = useMemo(
    () => profileModalOpen ? new TextEncoder().encode(JSON.stringify(state)).byteLength : 0,
    [state, profileModalOpen],
  );

  const activeConversation =
    state.conversations[state.activeConversationId] ??
    state.conversations[state.rootId];
  const {
    children: focusedBranches,
    parent: parentConversation,
    path,
    siblings: siblingBranches,
  } = getBranchNavigation(state.conversations, activeConversation.id);
  const isMainView = activeConversation.parentId === null;
  const activeRootConversation = path[0] ?? activeConversation;
  const conversationTreeLanes = getConversationTreeLanes(
    state.conversations,
    activeConversation.id,
  );
  const currentChatOutline = buildEditableDocumentOutline(activeConversation);
  const currentChatOutlineKey = currentChatOutline
    .map((item) => item.id)
    .join("|");
  const isTileView = mainViewMode === "tiles";
  const isGraphView = mainViewMode === "graph";
  const chatPanelLayout = getChatPanelLayout({
    availableWidth: canvasWidth,
    preferredWidth: chatPanelWidth,
    hasParent: Boolean(parentConversation),
    hasSideItems: conversationTreeLanes.length > 0,
    mobile: isMobileViewport,
  });
  const panelMaximumWidth = Math.max(CHAT_PANEL_MIN_WIDTH_PX, Math.min(CHAT_PANEL_MAX_WIDTH_PX, canvasWidth - 48));
  function getRenderedPanelWidth(conversationId: string) {
    if (isMobileViewport) return chatPanelLayout.width;
    return Math.min(resizedPanelWidths[conversationId] ?? chatPanelLayout.width, panelMaximumWidth);
  }
  function getPanelResizeInfo(conversation: Conversation) {
    const width = getRenderedPanelWidth(conversation.id);
    const pathIndex = path.findIndex((item) => item.id === conversation.id);
    const companion = conversation.parentId
      ? state.conversations[conversation.parentId]
      : path[pathIndex + 1];
    const companionWidth = companion ? getRenderedPanelWidth(companion.id) : undefined;
    return {
      width,
      companionId: companion?.id,
      companionWidth,
      direction: (companion && conversation.parentId ? -1 : 1) as 1 | -1,
      maxWidth: panelMaximumWidth,
    };
  }
  const summaryMinute = Math.floor(Date.now() / 60_000);
  const jev = useJevAssistance({
    userId: user.id, enabled: jevEnabled, ready: vault.ready,
    conversations: state.conversations, currentId: activeConversation.id,
    groups: state.groups,
    pending: Object.values(pendingConversationIds).some(Boolean),
  });
  const jevCategoryKey = JSON.stringify(jev.categories);
  const jevGroupSuggestionKey = JSON.stringify(jev.groupSuggestions);
  useEffect(() => {
    if (jev.status !== "ready") return;
    setState((current) => applyJevGroupSuggestions(current, jev.categories, jev.groupSuggestions));
  }, [jev.status, jevCategoryKey, jevGroupSuggestionKey]);
  const threadSummaries = useMemo(
    () => applyJevCategories(buildThreadSummaries(state.conversations), jev.categories).map((thread) => ({
        ...thread,
        groupId: getConversationGroupId(state.groups, thread.id),
      })),
    [state.conversations, state.groups, summaryMinute, jevCategoryKey],
  );
  const threadSummaryById = new Map(
    threadSummaries.map((thread) => [thread.id, thread] as const),
  );
  const pinnedThreadSummaries = state.pinnedThreadIds
    .map((threadId) => threadSummaryById.get(threadId))
    .filter(
      (thread): thread is (typeof threadSummaries)[number] => Boolean(thread),
    );
  const streamingThreadIds = new Set<string>();

  for (const [conversationId, isStreaming] of Object.entries(
    pendingConversationIds,
  )) {
    if (!isStreaming) {
      continue;
    }

    const rootConversationId = getConversationRootId(
      state.conversations,
      conversationId,
    );

    if (rootConversationId) {
      streamingThreadIds.add(rootConversationId);
    }
  }
  const nearbyBranchCount = siblingBranches.length + focusedBranches.length;
  const branchNavigationCount =
    nearbyBranchCount + Math.max(path.length - 1, 0);
  const branchAccessEnabled = branchNavigationCount > 0;
  const mobileChatContextCopy = isMainView
    ? focusedBranches.length
      ? `${focusedBranches.length} direct ${
          focusedBranches.length === 1 ? "branch" : "branches"
        } ready to review`
      : "Focused on the main thread with quick actions nearby"
    : `Branching from ${parentConversation?.title ?? activeRootConversation.title}`;
  const mobilePanelsOpen =
    isMobileViewport &&
    !isTileView &&
    !isGraphView &&
    leftSidebarOpen;
  const searchResults = searchModalOpen
    ? buildSearchResults(state.conversations, deferredSearchQuery, threadSummaries)
    : [];

  useEffect(() => {
    const mediaQuery = window.matchMedia(
      `(max-width: ${MOBILE_PANEL_RESIZE_BREAKPOINT_PX}px)`,
    );

    const syncViewport = () => {
      setIsMobileViewport(mediaQuery.matches);
    };

    syncViewport();
    mediaQuery.addEventListener("change", syncViewport);

    return () => {
      mediaQuery.removeEventListener("change", syncViewport);
    };
  }, []);

  useEffect(() => {
    if (!isMobileViewport || storageMode === "loading") {
      return;
    }

    setLeftSidebarOpen(false);
    setState((current) =>
      current.railOpen
        ? {
            ...current,
            railOpen: false,
          }
        : current,
    );
  }, [isMobileViewport, storageMode]);

  useEffect(() => {
    if (!mobilePanelsOpen) {
      return undefined;
    }

    function closeMobilePanels(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      setLeftSidebarOpen(false);
      setState((current) =>
        current.railOpen ? { ...current, railOpen: false } : current,
      );
    }

    document.addEventListener("keydown", closeMobilePanels);

    return () => {
      document.removeEventListener("keydown", closeMobilePanels);
    };
  }, [mobilePanelsOpen]);

  useEffect(() => {
    if (branchAccessEnabled || !state.railOpen) {
      return;
    }

    setState((current) =>
      current.railOpen ? { ...current, railOpen: false } : current,
    );
  }, [branchAccessEnabled, state.railOpen]);

  useEffect(() => {
    setRecentModelSelections(
      loadRecentModelSelections(recentModelSelectionsStorageKey),
    );
  }, [recentModelSelectionsStorageKey]);

  useEffect(() => {
    window.localStorage.setItem(
      recentModelSelectionsStorageKey,
      JSON.stringify(recentModelSelections),
    );
  }, [recentModelSelections, recentModelSelectionsStorageKey]);

  useEffect(() => {
    const normalizedGraphLayouts = normalizeGraphLayouts(
      state.conversations,
      state.graphLayouts,
    );

    if (areGraphLayoutsEqual(state.graphLayouts, normalizedGraphLayouts)) {
      return;
    }

    setState((current) => ({
      ...current,
      graphLayouts: normalizedGraphLayouts,
    }));
  }, [state.conversations, state.graphLayouts]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        LEFT_SIDEBAR_STORAGE_KEY,
        leftSidebarOpen ? "true" : "false",
      );
    } catch {
      return;
    }
  }, [leftSidebarOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        CHAT_PANEL_WIDTH_STORAGE_KEY,
        String(chatPanelWidth),
      );
    } catch {
      return;
    }
  }, [chatPanelWidth]);

  useEffect(() => {
    function stopChatPanelResize(event?: PointerEvent | Event) {
      const resizeState = panelResizeStateRef.current;

      if (!resizeState || (event instanceof PointerEvent && event.pointerId !== resizeState.pointerId)) {
        return;
      }

      panelResizeStateRef.current = null;
      setIsResizingChatPanel(false);
      setResizingChatPanelConversationId(null);
      if (resizeState.handle.hasPointerCapture?.(resizeState.pointerId)) resizeState.handle.releasePointerCapture(resizeState.pointerId);
      document.body.style.cursor = resizeState.previousCursor;
      document.body.style.userSelect = resizeState.previousUserSelect;

      panelRefs.current[resizeState.conversationId]?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }

    function handleChatPanelResizePointerMove(event: PointerEvent) {
      const resizeState = panelResizeStateRef.current;

      if (!resizeState || event.pointerId !== resizeState.pointerId) {
        return;
      }

      event.preventDefault();
      const next = resizeChatPanels({
        width: resizeState.originWidth,
        companionWidth: resizeState.companionWidth,
        delta: (event.clientX - resizeState.startClientX) * resizeState.direction,
        maxWidth: resizeState.maxWidth,
      });
      setResizedPanelWidths((current) => ({
        ...current,
        [resizeState.conversationId]: next.width,
        ...(resizeState.companionId && next.companionWidth !== undefined ? { [resizeState.companionId]: next.companionWidth } : {}),
      }));
    }

    window.addEventListener("pointermove", handleChatPanelResizePointerMove);
    window.addEventListener("pointerup", stopChatPanelResize);
    window.addEventListener("pointercancel", stopChatPanelResize);
    window.addEventListener("lostpointercapture", stopChatPanelResize);
    window.addEventListener("blur", stopChatPanelResize);
    window.addEventListener("resize", stopChatPanelResize);

    return () => {
      window.removeEventListener("pointermove", handleChatPanelResizePointerMove);
      window.removeEventListener("pointerup", stopChatPanelResize);
      window.removeEventListener("pointercancel", stopChatPanelResize);
      window.removeEventListener("lostpointercapture", stopChatPanelResize);
      window.removeEventListener("blur", stopChatPanelResize);
      window.removeEventListener("resize", stopChatPanelResize);
      const resizing = panelResizeStateRef.current;
      if (resizing) {
        panelResizeStateRef.current = null;
        if (resizing.handle.hasPointerCapture?.(resizing.pointerId)) resizing.handle.releasePointerCapture(resizing.pointerId);
        document.body.style.cursor = resizing.previousCursor;
        document.body.style.userSelect = resizing.previousUserSelect;
      }
    };
  }, []);

  useEffect(() => {
    if (mainViewMode === "chat" || !panelResizeStateRef.current) {
      return;
    }

    const resizing = panelResizeStateRef.current;
    panelResizeStateRef.current = null;
    setIsResizingChatPanel(false);
    setResizingChatPanelConversationId(null);
    if (resizing.handle.hasPointerCapture?.(resizing.pointerId)) resizing.handle.releasePointerCapture(resizing.pointerId);
    document.body.style.cursor = resizing.previousCursor;
    document.body.style.userSelect = resizing.previousUserSelect;
  }, [mainViewMode]);

  useEffect(() => {
    if (mainViewMode !== "graph") {
      setGraphFocusRequest(null);
    }
  }, [mainViewMode]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchModalOpen(true);
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || mainViewMode !== "chat") return;
    const measure = () => setCanvasWidth(canvas.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [mainViewMode, vault.ready]);

  useEffect(() => {
    if (mainViewMode !== "chat" || !vault.ready || panelResizeStateRef.current || isResizingSidebar) return;
    if (suppressNextChatAutoCenterRef.current) {
      suppressNextChatAutoCenterRef.current = false;
      return;
    }

    const panel = panelRefs.current[state.activeConversationId];
    const parentPanel = parentConversation && panelRefs.current[parentConversation.id];
    const canvas = canvasRef.current;
    if (canvas && panel && parentPanel && chatPanelLayout.fitsPair &&
      getRenderedPanelWidth(activeConversation.id) + getRenderedPanelWidth(parentConversation!.id) + 80 <= canvasWidth + 1) {
      canvas.scrollTo({
        left: canvas.scrollLeft + parentPanel.getBoundingClientRect().left - canvas.getBoundingClientRect().left - 24,
        behavior: "smooth",
      });
      return;
    }
    panel?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [mainViewMode, state.activeConversationId, canvasWidth, chatPanelLayout.width, chatPanelLayout.fitsPair, vault.ready, isResizingSidebar]);

  useLayoutEffect(() => {
    const parentConversationId = pendingTreeLaneFocusRef.current;
    const canvas = canvasRef.current;

    if (!parentConversationId || !canvas) {
      return undefined;
    }

    const targetLane = Array.from(
      canvas.querySelectorAll<HTMLElement>("[data-tree-parent-id]"),
    ).find(
      (lane) => lane.dataset.treeParentId === parentConversationId,
    );

    if (!targetLane) {
      return undefined;
    }

    pendingTreeLaneFocusRef.current = null;
    const frameId = window.requestAnimationFrame(() => {
      targetLane.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [state.activeConversationId]);

  useEffect(() => {
    setActiveOutlineItemId((current) =>
      current && currentChatOutline.some((item) => item.id === current)
        ? current
        : currentChatOutline[0]?.id ?? null,
    );
  }, [activeConversation.id, currentChatOutlineKey]);

  const handleConversationCanvasWheel = useEffectEvent((event: WheelEvent) => {
    const canvas = canvasRef.current;
    const target = event.target;

    if (
      !canvas ||
      event.ctrlKey ||
      isProfileDialogWheelTarget(target)
    ) {
      return;
    }

    const deltaX = normalizeWheelDelta(
      event.deltaX,
      event.deltaMode,
      canvas.clientWidth,
    );
    const deltaY = normalizeWheelDelta(
      event.deltaY,
      event.deltaMode,
      canvas.clientHeight,
    );
    const horizontalDelta = getHorizontalWheelDelta({
      deltaX,
      deltaY,
      shiftKey: event.shiftKey,
    });

    if (Math.abs(horizontalDelta) < 0.5) {
      return;
    }

    // The canvas owns horizontal gestures even when they begin over a chat's
    // vertically scrollable body or composer. Capturing and stopping the event
    // prevents nested surfaces from swallowing the gesture or scrolling
    // sideways independently.
    event.preventDefault();
    event.stopPropagation();

    const maxScrollLeft = Math.max(
      canvas.scrollWidth - canvas.clientWidth,
      0,
    );
    const nextScrollLeft = clamp(
      canvas.scrollLeft + horizontalDelta,
      0,
      maxScrollLeft,
    );

    if (nextScrollLeft === canvas.scrollLeft) {
      return;
    }

    canvas.scrollLeft = nextScrollLeft;
  });

  useEffect(() => {
    const canvas = canvasRef.current;

    if (mainViewMode !== "chat" || !canvas) {
      return undefined;
    }

    const handleWheel = (event: WheelEvent) => {
      handleConversationCanvasWheel(event);
    };

    canvas.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: false,
    });

    return () => {
      canvas.removeEventListener("wheel", handleWheel, true);
    };
  }, [handleConversationCanvasWheel, mainViewMode]);

  useEffect(() => {
    if (!selectionDraft) {
      return undefined;
    }

    const selectedQuote = selectionDraft.quote;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement;

      if (toolbarRef.current?.contains(target)) {
        return;
      }

      setSelectionDraft(null);
      window.getSelection()?.removeAllRanges();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectionDraft(null);
        window.getSelection()?.removeAllRanges();
      }
    }

    function handleCopy(event: ClipboardEvent) {
      const activeElement = document.activeElement;
      const isEditingText =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable);

      if (
        writeSelectedQuoteToClipboard({
          clipboardData: event.clipboardData,
          isEditingText,
          quote: selectedQuote,
        })
      ) {
        event.preventDefault();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("copy", handleCopy);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("copy", handleCopy);
    };
  }, [selectionDraft]);

  useLayoutEffect(() => {
    if (!selectionDraft || !toolbarRef.current) {
      return;
    }

    const nextSize = {
      width: toolbarRef.current.offsetWidth,
      height: toolbarRef.current.scrollHeight,
    };

    setToolbarSize((current) =>
      current.width === nextSize.width && current.height === nextSize.height
        ? current
        : nextSize,
    );
  }, [selectionDraft]);

  useEffect(() => {
    if (mainViewMode !== "chat" || isMobileViewport) {
      setConnections([]);
      setConnectorOcclusionRects([]);
      return;
    }

    let frame = 0;

    const requestUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const nextConnections: ConnectionLine[] = [];
        const nextOcclusionRects: ConnectorOcclusionRect[] = [];
        const focusedConversation =
          state.conversations[state.activeConversationId];

        if (!focusedConversation) {
          setConnections(nextConnections);
          setConnectorOcclusionRects(nextOcclusionRects);
          return;
        }

        const canvasRect = getElementRect(canvasRef.current);

        if (canvasRect && canvasRect.top > 0) {
          nextOcclusionRects.push({
            id: "canvas-top-band",
            x: 0,
            y: 0,
            width: window.innerWidth,
            height: canvasRect.top,
            radius: 0,
          });
        }

        const activePath = getConversationPath(
          state.conversations,
          focusedConversation.id,
        );
        const activePathIds = new Set(
          activePath.map((conversation) => conversation.id),
        );

        for (const [pathIndex, parentConversation] of activePath.entries()) {
          const expandedChildId = activePath[pathIndex + 1]?.id ?? null;

          for (const childConversationId of parentConversation.childIds) {
            if (expandedChildId && childConversationId !== expandedChildId) {
              continue;
            }

            const childConversation =
              state.conversations[childConversationId];

            if (!childConversation?.branchAnchor) {
              continue;
            }

            const anchorRect = getLineRect(
              anchorRefs.current[childConversation.id],
            );
            const parentPanelRect = getElementRect(
              panelRefs.current[parentConversation.id],
            );
            const targetElement = activePathIds.has(childConversation.id)
              ? branchOriginRefs.current[childConversation.id]
              : treeNodeRefs.current[childConversation.id];
            const targetRect = getElementRect(targetElement);

            if (!anchorRect || !parentPanelRect || !targetRect) {
              continue;
            }

            nextConnections.push({
              id: `tree-${childConversation.id}`,
              start: {
                x: parentPanelRect.right,
                y: anchorRect.top + anchorRect.height / 2,
              },
              end: {
                x: targetRect.left,
                y: targetRect.top + targetRect.height / 2,
              },
              active: activePathIds.has(childConversation.id),
              variant: "curve",
            });
          }
        }

        for (const conversation of activePath) {
          const composerSurface = composerSurfaceRefs.current[conversation.id];
          const composerRect = getElementRect(composerSurface);

          if (!composerRect) {
            continue;
          }

          nextOcclusionRects.push({
            id: `composer-${conversation.id}`,
            x: composerRect.left - 2,
            y: composerRect.top - 2,
            width: composerRect.width + 4,
            height: composerRect.height + 4,
            radius: 30,
          });
        }

        setConnections(nextConnections);
        setConnectorOcclusionRects(nextOcclusionRects);
      });
    };

    requestUpdate();
    window.addEventListener("resize", requestUpdate);
    window.addEventListener("scroll", requestUpdate, true);
    canvasRef.current?.addEventListener("scroll", requestUpdate);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", requestUpdate);
      window.removeEventListener("scroll", requestUpdate, true);
      canvasRef.current?.removeEventListener("scroll", requestUpdate);
    };
  }, [
    chatPanelWidth,
    chatPanelLayout.width,
    resizedPanelWidths,
    isMobileViewport,
    leftSidebarOpen,
    mainViewMode,
    state.activeConversationId,
    state.conversations,
    state.railOpen,
  ]);

  function handleResetChatPanelWidth(conversation: Conversation) {
    const { companionId } = getPanelResizeInfo(conversation);
    setResizedPanelWidths((current) => {
      const next = { ...current };
      delete next[conversation.id];
      if (companionId) delete next[companionId];
      return next;
    });
  }

  function handleChatPanelResizePointerDown(
    conversationId: string,
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (
      event.button !== 0 || !event.isPrimary ||
      window.matchMedia(
        `(max-width: ${MOBILE_PANEL_RESIZE_BREAKPOINT_PX}px)`,
      ).matches
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const conversation = state.conversations[conversationId];
    if (!conversation) return;
    const info = getPanelResizeInfo(conversation);
    event.currentTarget.setPointerCapture(event.pointerId);

    panelResizeStateRef.current = {
      conversationId,
      originWidth: info.width,
      startClientX: event.clientX,
      direction: info.direction,
      companionId: info.companionId,
      companionWidth: info.companionWidth,
      maxWidth: info.maxWidth,
      pointerId: event.pointerId,
      handle: event.currentTarget,
      previousCursor: document.body.style.cursor,
      previousUserSelect: document.body.style.userSelect,
    };
    setIsResizingChatPanel(true);
    setResizingChatPanelConversationId(conversationId);
    document.body.style.setProperty("cursor", "col-resize");
    document.body.style.setProperty("user-select", "none");
  }

  function handleChatPanelResizeKeyDown(
    conversation: Conversation,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const info = getPanelResizeInfo(conversation);
    const delta = event.key === "Home" ? -info.maxWidth
      : event.key === "End" ? info.maxWidth
        : (event.key === "ArrowRight" ? 1 : -1) * info.direction * CHAT_PANEL_KEYBOARD_STEP_PX;
    const next = resizeChatPanels({ ...info, delta });
    setResizedPanelWidths((current) => ({
      ...current,
      [conversation.id]: next.width,
      ...(info.companionId && next.companionWidth !== undefined ? { [info.companionId]: next.companionWidth } : {}),
    }));
  }

  function handleDraftChange(conversationId: string, value: string) {
    setDrafts((current) => ({
      ...current,
      [conversationId]: value,
    }));
  }

  function appendAssistantMessage(conversationId: string, content: string) {
    const assistantMessage: Message = {
      id: createId("message"),
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
    };

    typingProgressByMessageIdRef.current[assistantMessage.id] = 0;
    setTypingMessageIds((current) => ({
      ...current,
      [assistantMessage.id]: true,
    }));

    setState((current) => appendMessage(current, conversationId, assistantMessage));
  }

  function appendAssistantDelta(conversationId: string, messageId: string, contentDelta: string, createdAt: string) {
    setState((current) => {
      const next = appendMessageDelta(current, conversationId, messageId, contentDelta, createdAt);
      const conversation = next.conversations[conversationId];
      const generation = conversation?.document?.generations.find((item) => item.messageId === messageId);
      if (!generation?.acceptedAt) return next;
      const blocks = conversation.document!.blocks.map((block) => generation.blockIds.includes(block.id)
        ? { ...block, content: block.content + contentDelta, updatedAt: createdAt } : block);
      return { ...next, conversations: { ...next.conversations, [conversationId]: { ...conversation, document: { ...conversation.document!, blocks } } } };
    });
  }

  function replaceDocumentConversation(current: AppState, updated: Conversation): AppState {
    const before = current.conversations[updated.id];
    if (!before) return current;
    const archived = getEditableDocument(before).blocks
      .filter((block) => !block.sourceMessageId && !updated.document?.blocks.some((item) => item.id === block.id)
        && block.content.trim() && !updated.messages.some((message) => message.id === `document:${block.id}`))
      .map((block) => ({ id: `document:${block.id}`, role: "user" as const, content: block.content, createdAt: block.createdAt }));
    const conversation = { ...updated, messages: [...updated.messages, ...archived] };
    const conversations = { ...current.conversations, [updated.id]: {
      ...conversation,
      notes: conversation.notes?.map((note) => remapDocumentAnchor(note, before, conversation)),
    } };
    for (const child of Object.values(conversations)) {
      if (child.branchAnchor?.sourceConversationId === updated.id) {
        conversations[child.id] = { ...child, branchAnchor: remapDocumentAnchor(child.branchAnchor, before, conversation) };
      }
    }
    return { ...current, conversations };
  }

  function handleDocumentChange(conversationId: string, document: EditableDocument) {
    setState((current) => {
      const conversation = current.conversations[conversationId];
      if (!conversation) return current;
      if (conversation.document) {
        const streaming = new Set(conversation.document.generations.filter((generation)=>generation.status === "streaming" && chatExecutions.has(conversationId)).flatMap((generation)=>generation.blockIds));
        document = {...document,
          blocks:document.blocks.map((block)=>streaming.has(block.id)?conversation.document!.blocks.find((item)=>item.id===block.id) ?? block:block),
          prompts:conversation.document.prompts,
          generations: conversation.document.generations.map((generation) => ({
            ...remapDocumentReplacement(generation, conversation.document!.blocks, document.blocks),
            blockIds: document.blocks.filter((block) => block.generationId === generation.id).map((block) => block.id),
          })),
        };
      }
      const updated = { ...conversation, document, updatedAt: new Date().toISOString() };
      const next = replaceDocumentConversation(current, updated);
      currentStateRef.current = next;
      return next;
    });
  }

  function handleDocumentSubmit(conversationId: string, request: DocumentAIRequest) {
    const source = currentStateRef.current.conversations[conversationId];
    if (!source || !request.prompt.trim() || chatExecutions.has(conversationId)) return;
    const now = new Date().toISOString();
    const originalDocument = getEditableDocument(source);
    const sourceBlock = originalDocument.blocks.find((block) => block.id === request.blockId);
    const rerun = originalDocument.generations.find((generation) => generation.id === request.rerunGenerationId);
    if (!rerun && sourceBlock && request.sourceContent !== undefined && request.sourceContent !== sourceBlock.content) {
      const mapped=remapDocumentRange(request.sourceContent,sourceBlock.content,request.from,request.to);
      if(!mapped){setDocumentErrors((current)=>({...current,[conversationId]:"The passage changed while the prompt was open. Select it again to choose the insertion point."}));return;}
      request={...request,from:mapped.from,to:mapped.to};
    }
    if (!rerun && (!sourceBlock || request.from < 0 || request.to < request.from || request.to > sourceBlock.content.length)) {
      setDocumentErrors((current) => ({ ...current, [conversationId]: "That insertion point changed. Place the cursor again and retry." }));
      return;
    }
    const priorPrompt = rerun && originalDocument.prompts.find((prompt) => prompt.id === rerun.promptId);
    const selectedQuote = request.quote || priorPrompt?.selection?.quote;
    const userMessage: Message = { id: createId("message"), role: "user", content: request.prompt.trim(), createdAt: now };
    const messageId = createId("message");
    const generationId = createId("generation");
    const promptId = createId("prompt");
    const outputBlockId = createId("block");
    let target = source;
    if (request.destination === "side") {
      target = {
        id: createId("conversation"), kind: "chat", title: excerpt(request.prompt.trim(), 52), parentId: source.id,
        serviceId: source.serviceId, modelId: source.modelId, ai: source.ai, documents: [...(source.documents ?? [])],
        branchAnchor: selectedQuote && sourceBlock ? { id: createId("anchor"), sourceConversationId: source.id,
          sourceMessageId: sourceBlock.sourceMessageId ?? `document:${sourceBlock.id}`, sourceBlockId: sourceBlock.id,
          startOffset: request.from, endOffset: request.to, quote: selectedQuote, prompt: userMessage.content, createdAt: now } : null,
        childIds: [], messages: [], notes: [], createdAt: now, updatedAt: now,
        document: {schemaVersion:1,blocks:[],prompts:[],generations:[]},
      };
    }
    const promptRecord = { id: promptId, content: userMessage.content, sourceMessageId: userMessage.id, createdAt: now,
      serviceId: target.serviceId, modelId: target.modelId, ai: target.ai,
      ...(selectedQuote ? { selection: priorPrompt?.selection ?? { blockId: request.blockId, from: request.from, to: request.to, quote: selectedQuote } } : {}) };
    const insertion = request.destination === "side" ? { blockId: null, offset: 0 }
      : { blockId: request.blockId, offset: request.replaceSelection ? request.from : request.to,
        ...(request.replaceSelection ? { replaceTo: request.to } : {}) };
    const generation: DocumentGeneration = { id: generationId, promptId, messageId, createdAt: now,
      serviceId: target.serviceId, modelId: target.modelId, ai: target.ai, status: "streaming", blockIds: rerun ? [] : [outputBlockId],
      ...(rerun ? {alternativeOf: rerun.id} : {acceptedAt: now}), insertion,
      ...(request.replaceSelection && sourceBlock ? {replacement: {blockId:sourceBlock.id,offset:request.from,content:sourceBlock.content.slice(request.from,request.to)}} : {}) };
    let prepared: Conversation = { ...target, messages: [...target.messages, userMessage], updatedAt: now,
      title: [DEFAULT_MAIN_CHAT_TITLE, DEFAULT_SIDE_CHAT_TITLE, "Untitled document", "New note"].includes(target.title) ? excerpt(userMessage.content, 52) : target.title,
      document: { ...getEditableDocument(target), prompts: [...getEditableDocument(target).prompts, promptRecord], generations: [...getEditableDocument(target).generations, generation] } };
    if (!rerun) prepared = insertDocumentBlock(prepared, { id: outputBlockId, kind: "markdown", content: "", createdAt: now, updatedAt: now, sourceMessageId: messageId, generationId }, insertion, now);
    const targetId = prepared.id;
    setDocumentErrors((current) => ({...current,[conversationId]:"",[targetId]:""}));
    setState((current) => {
      const sourceSnapshot = sourceBlock && !sourceBlock.sourceMessageId && sourceBlock.content.trim() && !source.messages.some((message)=>message.id===`document:${sourceBlock.id}`)
        ? [{id:`document:${sourceBlock.id}`,role:"user" as const,content:sourceBlock.content,createdAt:sourceBlock.createdAt}] : [];
      const base = request.destination === "side" ? { ...current, conversations: { ...current.conversations, [source.id]: { ...current.conversations[source.id], messages:[...source.messages,...sourceSnapshot], document: originalDocument } } } : current;
      const next = request.destination === "side" ? addChildConversation(base, prepared, {activate:true})
        : replaceDocumentConversation(current, prepared);
      currentStateRef.current = next;
      return next;
    });
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
    const requestMessage = buildDocumentAIMessage(source, userMessage, selectedQuote);
    chatExecutions.start({ conversationId: targetId, messageId, createdAt: now,
      request: (onDelta, signal, onMetadata) => requestChatReply({
        ...prepareAIContext(currentStateRef.current.conversations, target, [requestMessage]),
        ai: withJevConsent(target.ai, jevEnabled), expectedUserId: user.id,
        conversation: getConversationRequestPayload(currentStateRef.current.conversations, target), messages: [requestMessage],
        modelId: target.modelId, serviceId: target.serviceId, onDelta, onMetadata, signal,
      }),
      onError(error) {
        if (isApiErrorStatus(error,401)) onAuthExpired();
        else if (isApiErrorStatus(error,402)) onBillingRequired(getErrorText(error,"Add money to continue using hosted AI."));
        setDocumentErrors((current) => ({...current,[targetId]:getErrorText(error,"AI could not finish. Open the prompt icon to try again.")}));
      },
      onFinish(status) {
        setState((current) => {
          const conversation = current.conversations[targetId];
          if (!conversation?.document) return current;
          const output = conversation.document.blocks.find((block)=>block.id===outputBlockId);
          const parts = output?.content ? splitDocumentMarkdown(output.content) : [];
          const completedBlocks = output && parts.length > 1 ? parts.map((content,index)=>({...output,id:index ? `${outputBlockId}:part:${index}` : outputBlockId,content})) : output ? [output] : [];
          return {...current,conversations:{...current.conversations,[targetId]:{...conversation,document:{...conversation.document,
            blocks:completedBlocks.length ? conversation.document.blocks.flatMap((block)=>block.id===outputBlockId?completedBlocks:[block]):conversation.document.blocks,
            generations:conversation.document.generations.map((item)=>item.id===generationId?{...item,status,...(completedBlocks.length ? {blockIds:completedBlocks.map((block)=>block.id)} : {})}:item),
          }}}};
        });
        void onRefreshBilling();
      },
    });
  }

  function handleAcceptDocumentVersion(conversationId: string, generationId: string) {
    setState((current) => {
      const conversation = current.conversations[conversationId];
      if (!conversation || chatExecutions.has(conversationId)) return current;
      const updated = acceptDocumentVersion(conversation, generationId);
      if (updated === conversation) return current;
      const next = replaceDocumentConversation(current, updated);
      currentStateRef.current = next;
      return next;
    });
  }

  function handleUndoDocumentInsertion(conversationId: string, generationId: string) {
    setState((current) => {
      const conversation = current.conversations[conversationId];
      if (!conversation || chatExecutions.has(conversationId)) return current;
      const updated = undoDocumentInsertion(conversation, generationId);
      if (updated === conversation) return current;
      const next = replaceDocumentConversation(current, updated);
      currentStateRef.current = next;
      return next;
    });
  }

  function saveExecutionDetails(conversationId: string, messageId: string, execution: AIExecutionRecord) {
    setState((current) => {
      const conversation = current.conversations[conversationId];
      if (!conversation?.messages.some((message) => message.id === messageId)) return current;
      return { ...current, conversations: { ...current.conversations, [conversationId]: {
        ...conversation, messages: conversation.messages.map((message) => message.id === messageId ? { ...message, execution } : message),
      } } };
    });
  }

  function handleAISettingsChange(conversationId: string, ai: AISettings) {
    setState((current) => {
      const conversation = current.conversations[conversationId];
      if (!conversation) return current;
      return { ...current, conversations: { ...current.conversations, [conversationId]: { ...conversation, ai: normalizeAISettings(ai), updatedAt: new Date().toISOString() } } };
    });
  }

  function stopChatStream(conversationId: string) {
    chatExecutions.stop(conversationId);
  }

  function abortChatStreams(conversationIds: Iterable<string>) {
    chatExecutions.abort(conversationIds);
  }

  function abortAllChatStreams() {
    chatExecutions.abortAll();
  }

  function handleTypewriterProgress(messageId: string, visibleCount: number) {
    typingProgressByMessageIdRef.current[messageId] = visibleCount;
  }

  function handleTypewriterComplete(messageId: string) {
    delete typingProgressByMessageIdRef.current[messageId];
    setTypingMessageIds((current) => {
      if (!current[messageId]) {
        return current;
      }

      const next = { ...current };
      delete next[messageId];
      return next;
    });
  }

  function handleStopTypewriter(conversationId: string) {
    const conversation = state.conversations[conversationId];

    if (!conversation) {
      return;
    }

    const messageIdsToStop = conversation.messages
      .map((message) => message.id)
      .filter((messageId) => typingMessageIds[messageId]);

    if (!messageIdsToStop.length) {
      return;
    }

    for (const messageId of messageIdsToStop) {
      delete typingProgressByMessageIdRef.current[messageId];
    }

    setTypingMessageIds((current) => {
      let changed = false;
      const next = { ...current };

      for (const messageId of messageIdsToStop) {
        if (!next[messageId]) {
          continue;
        }

        delete next[messageId];
        changed = true;
      }

      return changed ? next : current;
    });
  }

  function startAssistantStream(conversation: Conversation, messages: Message[]) {
    return chatExecutions.start({
      conversationId: conversation.id,
      messageId: createId("message"),
      createdAt: new Date().toISOString(),
      request: (onDelta, signal, onMetadata) => requestChatReply({
        ...prepareAIContext(state.conversations, conversation, messages),
        ai: withJevConsent(conversation.ai, jevEnabled),
        expectedUserId: user.id,
        conversation: getConversationRequestPayload(state.conversations, conversation),
        messages,
        modelId: conversation.modelId,
        onDelta,
        onMetadata,
        serviceId: conversation.serviceId,
        signal,
      }),
      onError(error) {
        if (isAbortError(error)) return;
        if (isApiErrorStatus(error, 401)) { onAuthExpired(); return; }
        if (isApiErrorStatus(error, 402)) {
          onBillingRequired(getErrorText(error, "Add money to your prepaid balance to continue using hosted AI."));
          return;
        }
        appendAssistantMessage(conversation.id, buildBackendErrorReply(conversation.serviceId, error));
      },
    });
  }

  function handleSubmit(conversationId: string, value: string, options: { preserveDraft?: boolean } = {}) {
    const trimmed = value.trim();

    if (
      !trimmed ||
      pendingConversationIds[conversationId] ||
      chatExecutions.has(conversationId)
    ) {
      return;
    }

    const conversation = currentStateRef.current.conversations[conversationId];

    if (!conversation) {
      return;
    }

    const isUntitledConversation =
      conversation.messages.length === 0 &&
      (conversation.title === DEFAULT_MAIN_CHAT_TITLE ||
        conversation.title === DEFAULT_SIDE_CHAT_TITLE);
    const nextConversationTitle =
      isUntitledConversation
        ? excerpt(trimmed, 34)
        : conversation.title;
    const shouldGenerateTitle = isUntitledConversation;
    const createdAt = new Date().toISOString();
    const userMessage: Message = {
      id: createId("message"),
      role: "user",
      content: trimmed,
      createdAt,
    };

    if (!options.preserveDraft) {
      setDrafts((current) => ({ ...current, [conversationId]: "" }));
    }

    setState((current) => {
      const currentConversation = current.conversations[conversationId];

      if (!currentConversation) {
        return current;
      }

      return {
        ...current,
        rootId:
          getConversationRootId(current.conversations, conversationId) ??
          current.rootId,
        conversations: {
          ...current.conversations,
          [conversationId]: {
            ...currentConversation,
            messages: [...currentConversation.messages, userMessage],
            title: nextConversationTitle,
            updatedAt: createdAt,
          },
        },
      };
    });

    if (shouldGenerateTitle) {
      void requestChatTitle({
        ai: normalizeAISettings(conversation.ai),
        expectedUserId: user.id,
        modelId: conversation.modelId,
        prompt: trimmed,
        serviceId: conversation.serviceId,
      })
        .then((generatedTitle) => {
          setState((current) => {
            const currentConversation = current.conversations[conversationId];

            if (
              !currentConversation ||
              currentConversation.title !== nextConversationTitle
            ) {
              return current;
            }

            return {
              ...current,
              conversations: {
                ...current.conversations,
                [conversationId]: {
                  ...currentConversation,
                  title: generatedTitle,
                },
              },
            };
          });
        })
        .catch(() => {
          // Keep the prompt excerpt as a useful fallback when title generation fails.
        })
        .finally(() => { void onRefreshBilling(); });
    }

    startAssistantStream(
      {
        ...conversation,
        title: nextConversationTitle,
      },
      [...conversation.messages, userMessage],
    );
  }

  function handleResubmitPrompt(conversationId: string, messageId: string) {
    const message = currentStateRef.current.conversations[conversationId]?.messages.find((item) => item.id === messageId);
    if (message?.role !== "user") return;
    handleSubmit(conversationId, message.content, { preserveDraft: true });
  }

  async function handleUploadDocuments(
    conversationId: string,
    files: File[],
  ) {
    const conversation = currentStateRef.current.conversations[conversationId];
    const availableSlots = Math.max(
      0,
      20 - (conversation?.documents?.length ?? 0),
    );
    const selectedFiles = files.slice(0, availableSlots);

    if (!conversation || !selectedFiles.length) {
      return;
    }

    setDocumentUploadByConversationId((current) => ({
      ...current,
      [conversationId]: { error: null, uploading: true },
    }));

    const uploadNotices: string[] = [];
    try {
      for (const file of selectedFiles) {
        const currentConversation = currentStateRef.current.conversations[conversationId];
        if (!currentConversation) break;
        const document = await requestUploadDocument(file, user.id, normalizeAISettings(currentConversation.ai));
        if (document.error) uploadNotices.push(`${document.filename}: ${document.error}`);

        setState((current) => {
          const currentConversation = current.conversations[conversationId];

          if (
            !currentConversation ||
            currentConversation.documents?.some(
              (candidate) => candidate.id === document.id,
            )
          ) {
            return current;
          }

          return {
            ...current,
            conversations: {
              ...current.conversations,
              [conversationId]: {
                ...currentConversation,
                documents: [
                  ...(currentConversation.documents ?? []),
                  document,
                ],
                updatedAt: new Date().toISOString(),
              },
            },
          };
        });
      }

      setDocumentUploadByConversationId((current) => ({
        ...current,
        [conversationId]: { error: uploadNotices.length ? uploadNotices.join(" ") : null, uploading: false },
      }));
    } catch (error) {
      if (isApiErrorStatus(error, 401)) {
        onAuthExpired();
        return;
      }

      setDocumentUploadByConversationId((current) => ({
        ...current,
        [conversationId]: {
          error: getErrorText(error, "Unable to process that document."),
          uploading: false,
        },
      }));
    } finally {
      void onRefreshBilling();
    }
  }

  async function handleDeleteDocument(documentId: string) {
    try {
      await requestDeleteDocument(documentId, user.id);
      setState((current) => ({
        ...current,
        conversations: Object.fromEntries(
          Object.entries(current.conversations).map(
            ([conversationId, conversation]) => [
              conversationId,
              {
                ...conversation,
                documents: (conversation.documents ?? []).filter(
                  (document) => document.id !== documentId,
                ),
              },
            ],
          ),
        ),
      }));
    } catch (error) {
      if (isApiErrorStatus(error, 401)) {
        onAuthExpired();
        return;
      }

      const conversationId = currentStateRef.current.activeConversationId;
      setDocumentUploadByConversationId((current) => ({
        ...current,
        [conversationId]: {
          error: getErrorText(error, "Unable to delete that document."),
          uploading: false,
        },
      }));
    }
  }

  function handleRemoveDocument(conversationId: string, documentId: string) {
    setState((current) => removeConversationDocument(current, conversationId, documentId, new Date().toISOString()));
  }

  function handleBranchFromMessage(draft: SelectionDraft) {
    window.getSelection()?.removeAllRanges();
    setSelectionDraft(draft);
    setSelectionIntent("branch");
    window.requestAnimationFrame(() => document.getElementById("branch-prompt")?.focus());
  }

  function handleModelChange(
    conversationId: string,
    serviceId: BackendServiceId,
    modelId: string,
  ) {
    const nextModelId = resolveBackendServiceModelId(serviceId, modelId);

    setState((current) => {
      const conversation = current.conversations[conversationId];

      if (!conversation) {
        return current;
      }

      const conversationUnchanged =
        conversation.serviceId === serviceId &&
        conversation.modelId === nextModelId;
      const defaultsUnchanged =
        current.defaultServiceId === serviceId &&
        current.defaultModelId === nextModelId;

      if (conversationUnchanged && defaultsUnchanged) {
        return current;
      }

      return {
        ...current,
        defaultModelId: nextModelId,
        defaultServiceId: serviceId,
        conversations: conversationUnchanged
          ? current.conversations
          : {
              ...current.conversations,
              [conversationId]: {
                ...conversation,
                modelId: nextModelId,
                serviceId,
              },
            },
      };
    });

    setRecentModelSelections((current) =>
      upsertRecentBackendServiceSelection(current, {
        modelId: nextModelId,
        serviceId,
      }),
    );
  }

  function syncSelectionDraft() {
    const selection = window.getSelection();

    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return;
    }

    const range = selection.getRangeAt(0);
    if ((range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest(".rich-document-editor")) return;
    const startBubble = getSelectionSourceElement(range.startContainer);
    const endBubble = getSelectionSourceElement(range.endContainer);

    if (!startBubble || !endBubble || startBubble !== endBubble) {
      setSelectionDraft(null);
      return;
    }

    const conversationId = startBubble.dataset.conversationId;
    const messageId = startBubble.dataset.messageId;
    const sourceKind =
      startBubble.dataset.selectionSource === "standalone-note"
        ? "standalone-note"
        : "message";
    const sourceNoteId = startBubble.dataset.noteId;

    if (!conversationId || !messageId) {
      setSelectionDraft(null);
      return;
    }

    const conversation = state.conversations[conversationId];
    const hasValidSource =
      sourceKind === "standalone-note"
        ? Boolean(
            conversation?.kind === "note" &&
              sourceNoteId &&
              (conversation.notes ?? []).some(
                (note) =>
                  note.id === sourceNoteId && note.kind === "standalone",
              ),
          )
        : Boolean(
            conversation?.messages.some(
              (candidate) => candidate.id === messageId,
            ),
          );

    if (!conversation || !hasValidSource) {
      setSelectionDraft(null);
      return;
    }

    const codeMirrorSelection =
      sourceKind === "standalone-note"
        ? getCodeMirrorSelection(startBubble, range)
        : null;
    const quote = codeMirrorSelection?.quote ?? selection.toString().trim();

    if (!quote) {
      return;
    }

    const startRange = range.cloneRange();
    startRange.selectNodeContents(startBubble);
    startRange.setEnd(range.startContainer, range.startOffset);

    const endRange = range.cloneRange();
    endRange.selectNodeContents(startBubble);
    endRange.setEnd(range.endContainer, range.endOffset);

    const selectionRects = Array.from(range.getClientRects()).filter(
      (candidate) => candidate.width > 0 || candidate.height > 0,
    );
    const rect = selectionRects.at(-1) ?? range.getBoundingClientRect();

    setSelectionDraft({
      conversationId,
      messageId,
      quote,
      startOffset:
        codeMirrorSelection?.startOffset ?? startRange.toString().length,
      endOffset: codeMirrorSelection?.endOffset ?? endRange.toString().length,
      prompt: "",
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      sourceKind,
      sourceNoteId:
        sourceKind === "standalone-note" ? sourceNoteId : undefined,
    });
    setSelectionIntent("branch");

  }

  useEffect(() => {
    function queueSelectionSync() {
      window.cancelAnimationFrame(selectionSyncFrameRef.current);
      selectionSyncFrameRef.current = window.requestAnimationFrame(() => {
        syncSelectionDraft();
      });
    }

    function handleDocumentMouseUp(event: MouseEvent) {
      if (toolbarRef.current?.contains(event.target as Node)) {
        return;
      }

      queueSelectionSync();
    }

    function handleDocumentPointerUp(event: PointerEvent) {
      if (toolbarRef.current?.contains(event.target as Node)) {
        return;
      }

      queueSelectionSync();
    }

    function handleDocumentKeyUp() {
      if (toolbarRef.current?.contains(document.activeElement)) {
        return;
      }

      queueSelectionSync();
    }

    document.addEventListener("mouseup", handleDocumentMouseUp);
    document.addEventListener("pointerup", handleDocumentPointerUp);
    document.addEventListener("keyup", handleDocumentKeyUp);

    return () => {
      window.cancelAnimationFrame(selectionSyncFrameRef.current);
      document.removeEventListener("mouseup", handleDocumentMouseUp);
      document.removeEventListener("pointerup", handleDocumentPointerUp);
      document.removeEventListener("keyup", handleDocumentKeyUp);
    };
  }, [isMobileViewport, state.conversations]);

  function handleUpdateGraphNodeLayouts(
    nextLayouts: Record<string, Partial<GraphNodeLayout>>,
  ) {
    setState((current) => {
      let changed = false;
      const graphLayouts = { ...current.graphLayouts };

      for (const [conversationId, nextLayout] of Object.entries(nextLayouts)) {
        const conversation = current.conversations[conversationId];

        if (!conversation) {
          continue;
        }

        const currentLayout =
          current.graphLayouts[conversationId] ?? createDefaultGraphNodeLayout();
        const preservesTreeOrigin =
          conversation.parentId === null &&
          nextLayout.positioned &&
          !currentLayout.positioned;
        const mergedLayout = createDefaultGraphNodeLayout({
          ...currentLayout,
          ...nextLayout,
          treeOriginX: preservesTreeOrigin
            ? currentLayout.treeOriginX ?? currentLayout.x
            : currentLayout.treeOriginX,
          treeOriginY: preservesTreeOrigin
            ? currentLayout.treeOriginY ?? currentLayout.y
            : currentLayout.treeOriginY,
        });

        if (
          currentLayout.x === mergedLayout.x &&
          currentLayout.y === mergedLayout.y &&
          currentLayout.width === mergedLayout.width &&
          currentLayout.height === mergedLayout.height &&
          Boolean(currentLayout.positioned) ===
            Boolean(mergedLayout.positioned) &&
          currentLayout.treeOriginX === mergedLayout.treeOriginX &&
          currentLayout.treeOriginY === mergedLayout.treeOriginY
        ) {
          continue;
        }

        graphLayouts[conversationId] = mergedLayout;
        changed = true;
      }

      return changed ? { ...current, graphLayouts } : current;
    });
  }

  function handleCreateBranch(promptOverride?: string) {
    const draft = selectionDraft;

    if (!draft) {
      return;
    }

    if (draft.sourceBlockId) {
      handleDocumentSubmit(draft.conversationId, {blockId:draft.sourceBlockId,from:draft.startOffset,to:draft.endOffset,quote:draft.quote,sourceContent:draft.sourceContent,
        prompt:promptOverride ?? draft.prompt,destination:selectionResponseDestination,replaceSelection:selectionReplaceText});
      return;
    }

    if (hasOverlappingAnchor(state.conversations, draft)) {
      window.alert(
        "That highlight overlaps an existing branch. Try a different phrase for now.",
      );
      return;
    }

    const parentConversation = state.conversations[draft.conversationId];

    if (!parentConversation) {
      return;
    }

    const now = new Date().toISOString();
    const branchId = createId("conversation");
    const prompt = (promptOverride ?? draft.prompt).trim();

    if (!prompt) {
      return;
    }

    const userMessage: Message = {
      id: createId("message"),
      role: "user",
      content: prompt,
      createdAt: now,
    };
    const branchConversation: Conversation = {
      id: branchId,
      title: buildConversationTitle(draft.quote, prompt),
      parentId: parentConversation.id,
      modelId: parentConversation.modelId,
      serviceId: parentConversation.serviceId,
      ...(parentConversation.ai ? { ai: structuredClone(parentConversation.ai) } : {}),
      branchAnchor: {
        id: createId("anchor"),
        sourceConversationId: draft.conversationId,
        sourceMessageId: draft.messageId,
        startOffset: draft.startOffset,
        endOffset: draft.endOffset,
        quote: draft.quote,
        prompt,
        createdAt: now,
      },
      childIds: [],
      documents: [...(parentConversation.documents ?? [])],
      createdAt: now,
      updatedAt: now,
      messages: [userMessage],
      notes: [],
    };
    setState((current) => addChildConversation(current, branchConversation, {
      activate: true,
      sourceNoteId: draft.sourceNoteId,
    }));

    setDrafts((current) => ({
      ...current,
      [branchId]: "",
    }));
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();

    startAssistantStream(branchConversation, branchConversation.messages);
  }

  function handleExplainSelection() {
    handleCreateBranch(EXPLAIN_SELECTION_PROMPT);
  }

  function handleCreateNote(args: {
    content: string;
    conversationId: string;
    endOffset?: number | null;
    kind?: "comment" | "side-chat";
    quote?: string | null;
    sourceMessageId: string | null;
    sourceStandaloneNoteId?: string;
    sourceBlockId?: string;
    startOffset?: number | null;
  }) {
    const content = args.kind === "side-chat" ? args.content : args.content.trim();
    if (!content.trim()) return "";
    const now = new Date().toISOString();
    const note: ConversationNote = {
      id: createId("note"),
      content,
      kind: args.kind ?? "comment",
      sourceMessageId: args.sourceMessageId,
      ...(args.sourceBlockId ? {sourceBlockId: args.sourceBlockId} : {}),
      startOffset: args.startOffset ?? null,
      endOffset: args.endOffset ?? null,
      quote: args.quote ?? null,
      createdAt: now,
      updatedAt: now,
    };

    setState((current) => {
      const conversation = current.conversations[args.conversationId];
      if (!conversation) return current;
      const sourceNote = args.sourceStandaloneNoteId
        ? (conversation.notes ?? []).find(
            (candidate) =>
              candidate.id === args.sourceStandaloneNoteId &&
              candidate.kind === "standalone",
          )
        : null;
      return {
        ...current,
        conversations: {
          ...current.conversations,
          [conversation.id]: {
            ...conversation,
            document: args.sourceBlockId ? getEditableDocument(conversation) : conversation.document,
            messages: args.sourceBlockId && !conversation.messages.some((message)=>message.id === args.sourceMessageId) ? [...conversation.messages, {id:args.sourceMessageId!,role:"user",content:getEditableDocument(conversation).blocks.find((block)=>block.id===args.sourceBlockId)?.content || args.quote || content,createdAt:now}] : sourceNote
              ? upsertStandaloneNoteContextMessage(
                  conversation.messages,
                  sourceNote,
                  now,
                )
              : conversation.messages,
            notes: [...(conversation.notes ?? []), note],
            updatedAt: now,
          },
        },
      };
    });

    return note.id;
  }

  function handleCreateSelectionNote() {
    if (!selectionDraft?.prompt.trim()) return;
    handleCreateNote({
      content: selectionDraft.prompt,
      conversationId: selectionDraft.conversationId,
      kind: "comment",
      sourceMessageId: selectionDraft.messageId,
      startOffset: selectionDraft.startOffset,
      endOffset: selectionDraft.endOffset,
      quote: selectionDraft.quote,
      sourceStandaloneNoteId: selectionDraft.sourceNoteId,
      sourceBlockId: selectionDraft.sourceBlockId,
    });
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
  }

  function handleUpdateNote(conversationId: string, noteId: string, content: string) {
    const value = content;
    const now = new Date().toISOString();
    setState((current) => {
      const conversation = current.conversations[conversationId];
      if (!conversation) return current;
      return {
        ...current,
        conversations: {
          ...current.conversations,
          [conversationId]: {
            ...conversation,
            notes: (conversation.notes ?? []).map((note) => note.id === noteId ? { ...note, content: value, updatedAt: now } : note),
            updatedAt: now,
          },
        },
      };
    });
  }

  function handleUpdateStandaloneNote(
    conversationId: string,
    noteId: string,
    content: string,
  ) {
    const now = new Date().toISOString();
    setState((current) => {
      const conversation = current.conversations[conversationId];
      if (!conversation || conversation.kind !== "note") return current;

      const notes = (conversation.notes ?? []).map((note) =>
        note.id === noteId && note.kind === "standalone"
          ? { ...note, content, updatedAt: now }
          : note,
      );
      const standaloneNote = notes.find(
        (note) => note.id === noteId && note.kind === "standalone",
      );
      const contextMessageId = getStandaloneNoteContextMessageId(noteId);
      const hasContextMessage = conversation.messages.some(
        (message) => message.id === contextMessageId,
      );

      return {
        ...current,
        conversations: {
          ...current.conversations,
          [conversationId]: {
            ...conversation,
            messages:
              standaloneNote && hasContextMessage
                ? upsertStandaloneNoteContextMessage(
                    conversation.messages,
                    standaloneNote,
                    now,
                  )
                : conversation.messages,
            notes,
            updatedAt: now,
          },
        },
      };
    });
  }

  function handleDeleteNote(conversationId: string, noteId: string) {
    setState((current) => {
      const conversation = current.conversations[conversationId];
      if (!conversation) return current;
      const currentNotes = conversation.notes ?? [];
      const notes = currentNotes.filter((note) => note.id !== noteId);
      if (notes.length === currentNotes.length) return current;
      return {
        ...current,
        conversations: {
          ...current.conversations,
          [conversationId]: { ...conversation, notes, updatedAt: new Date().toISOString() },
        },
      };
    });
  }

  function handleUseNote(conversationId: string, content: string) {
    const conversation=currentStateRef.current.conversations[conversationId];
    if(!conversation)return;
    const now=new Date().toISOString();
    const document=getEditableDocument(conversation);
    handleDocumentChange(conversationId,{...document,blocks:[...document.blocks,{id:createId("block"),kind:"markdown",content,createdAt:now,updatedAt:now}]});
  }

  function handleCreateMainConversation() {
    const now = new Date().toISOString();
    const conversationId = createId("conversation");
    const mainConversation = createMainConversation({
      createdAt: now,
      id: conversationId,
      modelId: state.defaultModelId,
      serviceId: state.defaultServiceId,
    });
    mainConversation.title = "Untitled document";
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
    setSearchModalOpen(false);
    setSearchQuery("");

    if (mainViewMode === "tiles") {
      setMainViewMode("chat");
    }

    startTransition(() => {
      setState((current) => addRootConversation(current, mainConversation));
    });
    setDrafts((current) => ({
      ...current,
      [conversationId]: "",
    }));

    if (isMobileViewport) {
      setLeftSidebarOpen(false);
      setState((current) =>
        current.railOpen
          ? {
              ...current,
              railOpen: false,
            }
          : current,
      );
    }
  }

  function handleSavePublicTopic(topic: PublicTopic) {
    const existing = findSavedPublicTopic(state.conversations, topic);
    setState((current) => savePublicTopic(current, topic).state);
    mapUndoRef.current = null;
    setMapEditMessage(existing ? `${existing.title} is already in your map.` : `${topic.label} added to your map. Keep exploring or choose “Show in my map”.`);
  }

  function handleCreateMapNote(args: { linkedTo?: string; url?: string }) {
    const id = createId("note-conversation");
    const createdAt = new Date().toISOString();
    const noteId = createId("note");
    setState((current) => createMapNote(current, { ...args, id, noteId, createdAt }));
    setGraphFocusRequest({ conversationId: id, requestId: ++graphFocusRequestCounterRef.current, openReader: true });
  }

  function handleSetMapConnection(source: string, target: string, connected: boolean) {
    const now = new Date().toISOString();
    if (setPersonalMapConnection(state, source, target, connected, now) === state) return;
    setState((current) => setPersonalMapConnection(current, source, target, connected, now));
    mapUndoRef.current = (current) => setPersonalMapConnection(current, source, target, !connected, new Date().toISOString());
    setMapEditMessage(connected ? "Connection added to your map." : "Connection removed. Both notes are still in your workspace.");
  }

  function handleAddMapChildNote(parentId: string) {
    if (!state.conversations[parentId]) return;
    const id = createId("note-conversation");
    const noteId = createId("note");
    const createdAt = new Date().toISOString();
    setState((current) => addMapChildNote(current, { parentId, id, noteId, createdAt }));
    setGraphFocusRequest({ conversationId: id, requestId: ++graphFocusRequestCounterRef.current, openReader: true });
  }

  function handleRemoveMapNote(id: string) {
    const removed = getRemovableMapNote(state, id);
    if (!removed) return;
    const replacement = createMainConversation({ id: createId("conversation"), modelId: state.defaultModelId, serviceId: state.defaultServiceId });
    setState((current) => removeMapNote(current, id, replacement));
    mapUndoRef.current = (current) => restoreMapNote(current, removed);
    setMapEditMessage(`${removed.conversation.title} removed from your workspace.`);
  }

  function handleUndoMapEdit() {
    const undo = mapUndoRef.current;
    if (!undo) return;
    setState(undo);
    mapUndoRef.current = null;
    setMapEditMessage("Restored your last map edit.");
  }

  function handleCreateStandaloneNote() {
    const now = new Date().toISOString();
    const conversationId = createId("note-conversation");
    const noteConversation = createStandaloneNoteConversation({
      createdAt: now,
      id: conversationId,
      modelId: state.defaultModelId,
      noteId: createId("note"),
      serviceId: state.defaultServiceId,
    });
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
    setSearchModalOpen(false);
    setSearchQuery("");
    setMainViewMode("chat");

    startTransition(() => {
      setState((current) => addRootConversation(current, noteConversation));
    });

    if (isMobileViewport) {
      setLeftSidebarOpen(false);
      setState((current) =>
        current.railOpen ? { ...current, railOpen: false } : current,
      );
    }
  }

  function handleAddSideChat(sourceConversationId: string) {
    if (!state.conversations[sourceConversationId]) {
      return;
    }

    const now = new Date().toISOString();
    const sideConversationId = createId("conversation");

    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
    setMainViewMode("chat");

    startTransition(() => {
      setState((current) => {
        const sourceConversation = current.conversations[sourceConversationId];

        if (!sourceConversation) {
          return current;
        }

        const sideConversation = createSideConversation({
          createdAt: now,
          id: sideConversationId,
          sourceConversation,
        });
        return addChildConversation(current, sideConversation, {
          activate: true,
          groupSourceId: sourceConversation.id,
        });
      });
    });

    setDrafts((current) => ({
      ...current,
      [sideConversationId]: "",
    }));

    if (isMobileViewport) {
      setLeftSidebarOpen(false);
    }
  }

  function handleAddGraphChildChat(parentConversationId: string) {
    if (!state.conversations[parentConversationId]) {
      return null;
    }

    const now = new Date().toISOString();
    const childConversationId = createId("conversation");

    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();

    setState((current) => {
      const parentConversation =
        current.conversations[parentConversationId];

      if (!parentConversation) {
        return current;
      }

      const childConversation = createChildConversation({
        createdAt: now,
        id: childConversationId,
        parentConversation,
      });
      return addChildConversation(current, childConversation);
    });

    setDrafts((current) => ({
      ...current,
      [childConversationId]: "",
    }));

    return childConversationId;
  }

  function handleOpenSearch() {
    if (isMobileViewport) {
      setLeftSidebarOpen(false);
      setState((current) =>
        current.railOpen
          ? {
              ...current,
              railOpen: false,
            }
          : current,
      );
    }

    setSearchModalOpen(true);
  }

  function handleCloseSearch() {
    setSearchModalOpen(false);
  }

  function handleOpenSearchSource(source: SearchEvidenceRef) {
    if (resolveSearchSource(state.conversations, source).status === "missing") return;
    setSearchModalOpen(false);
    handleSelectConversation(source.conversationId, { nextViewMode: "chat" });
    if (source.sourceKind === "annotation" && source.noteId) {
      setNoteOpenRequest((current) => ({ noteId: source.noteId!, sequence: (current?.sequence ?? 0) + 1 }));
    }
    setSearchSourceRequest((current) => ({ source, sequence: (current?.sequence ?? 0) + 1 }));
  }

  function handleSelectSearchResult(conversationId: string) {
    handleCloseSearch();
    handleRevealConversation(conversationId);
  }

  function handleSelectConversation(
    conversationId: string,
    options: {
      nextViewMode?: MainViewMode;
      preserveRail?: boolean;
    } = {},
  ) {
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
    setMainViewMode(
      getConversationSelectionViewMode({
        currentViewMode: mainViewMode,
        requestedViewMode: options.nextViewMode,
        targetKind: state.conversations[conversationId]?.kind,
      }),
    );

    startTransition(() => {
      setState((current) => {
        if (!current.conversations[conversationId]) {
          return current;
        }

        return {
          ...current,
          activeConversationId: conversationId,
          railOpen: options.preserveRail ? current.railOpen : false,
          rootId:
            getConversationRootId(current.conversations, conversationId) ??
            current.rootId,
        };
      });
    });

    if (isMobileViewport) {
      setLeftSidebarOpen(false);
    }
  }

  function handleRevealConversation(conversationId: string) {
    if (mainViewMode === "graph") {
      setGraphFocusRequest({
        conversationId,
        requestId: ++graphFocusRequestCounterRef.current,
      });
    }

    handleSelectConversation(conversationId);
  }

  function handleSelectOutlineItem(outlineItemId: string) {
    const panel = panelRefs.current[activeConversation.id];
    const target = panel
      ? Array.from(
          panel.querySelectorAll<HTMLElement>("[data-chat-outline-id]"),
        ).find(
          (element) => element.dataset.chatOutlineId === outlineItemId,
        ) ?? null
      : null;

    if (!target) {
      return;
    }

    setActiveOutlineItemId(outlineItemId);
    target.scrollIntoView({
      behavior: "smooth",
      block: "start",
      inline: "nearest",
    });
    target.focus({ preventScroll: true });
    target.classList.remove("is-outline-target");
    window.requestAnimationFrame(() => {
      target.classList.add("is-outline-target");
    });

    if (isMobileViewport) {
      setLeftSidebarOpen(false);
    }
  }

  function handleVisibleOutlineChange(
    conversationId: string,
    outlineItemId: string,
  ) {
    if (conversationId !== activeConversation.id) {
      return;
    }

    const visibleId = currentChatOutline.find((item) => item.id === outlineItemId || item.memberIds?.includes(outlineItemId))?.id;
    if (visibleId) setActiveOutlineItemId((current) => current === visibleId ? current : visibleId);
  }

  function handlePinThread(conversationId: string) {
    setState((current) => {
      const conversation = current.conversations[conversationId];

      if (
        !conversation ||
        conversation.parentId !== null ||
        current.pinnedThreadIds.includes(conversationId)
      ) {
        return current;
      }

      return {
        ...current,
        pinnedThreadIds: [...current.pinnedThreadIds, conversationId],
      };
    });
  }

  function handleCreateConversationGroup(name: string) {
    const trimmedName = name.trim();

    if (!trimmedName) {
      return;
    }

    const groupId = createId("group");

    setState((current) => ({
      ...current,
      groups: {
        ...current.groups,
        [groupId]: {
          collapsed: false,
          color:
            CONVERSATION_GROUP_COLORS[
              Object.keys(current.groups).length %
                CONVERSATION_GROUP_COLORS.length
            ],
          conversationIds: [],
          id: groupId,
          name: trimmedName,
        },
      },
    }));
  }

  function handleAssignConversationGroup(
    conversationId: string,
    groupId: string | null,
  ) {
    setState((current) => {
      if (
        !current.conversations[conversationId] ||
        (groupId && !current.groups[groupId])
      ) {
        return current;
      }

      const conversationIds = collectConversationTreeIds(
        current.conversations,
        conversationId,
      );
      const groups = conversationIds.reduce(
        (nextGroups, nextConversationId) =>
          assignConversationToGroup(
            nextGroups,
            nextConversationId,
            groupId,
          ),
        current.groups,
      );

      const conversations = { ...current.conversations };
      let changed = groups !== current.groups;
      for (const id of conversationIds) {
        if (conversations[id].grouping === "manual") continue;
        conversations[id] = { ...conversations[id], grouping: "manual" };
        changed = true;
      }
      return changed ? { ...current, groups, conversations } : current;
    });
  }

  function handleCreateAndAssignGroup(conversationId: string, name: string) {
    const nextName = name.trim().slice(0, 48);
    if (!nextName) return;
    const newGroupId = createId("group");
    setState((current) => {
      if (!current.conversations[conversationId]) return current;
      const existing = Object.values(current.groups).find((group) => group.name.toLocaleLowerCase() === nextName.toLocaleLowerCase());
      const groupId = existing?.id ?? newGroupId;
      let groups = existing ? current.groups : {
        ...current.groups,
        [groupId]: { id: groupId, name: nextName, collapsed: false,
          color: CONVERSATION_GROUP_COLORS[Object.keys(current.groups).length % CONVERSATION_GROUP_COLORS.length], conversationIds: [] },
      };
      const conversations = { ...current.conversations };
      for (const id of collectConversationTreeIds(current.conversations, conversationId)) {
        groups = assignConversationToGroup(groups, id, groupId);
        conversations[id] = { ...conversations[id], grouping: "manual" };
      }
      return { ...current, groups, conversations };
    });
  }

  function handleToggleConversationGroup(groupId: string) {
    setState((current) => {
      const group = current.groups[groupId];

      if (!group) {
        return current;
      }

      return {
        ...current,
        groups: {
          ...current.groups,
          [groupId]: {
            ...group,
            collapsed: !group.collapsed,
          },
        },
      };
    });
  }

  function handleUnpinThread(conversationId: string) {
    setState((current) => {
      const nextPinnedThreadIds = current.pinnedThreadIds.filter(
        (threadId) => threadId !== conversationId,
      );

      if (nextPinnedThreadIds.length === current.pinnedThreadIds.length) {
        return current;
      }

      return {
        ...current,
        pinnedThreadIds: nextPinnedThreadIds,
      };
    });
  }

  function handleRenameThread(conversationId: string, title: string) {
    const trimmedTitle = title.trim();

    if (!trimmedTitle) {
      return;
    }

    setState((current) => {
      const conversation = current.conversations[conversationId];

      if (
        !conversation ||
        (conversation.parentId !== null && conversation.kind !== "note") ||
        conversation.title === trimmedTitle
      ) {
        return current;
      }

      return {
        ...current,
        conversations: {
          ...current.conversations,
          [conversationId]: {
            ...conversation,
            title: trimmedTitle,
            updatedAt: new Date().toISOString(),
          },
        },
      };
    });

  }

  function handleDeleteThread(conversationId: string) {
    const rootConversation = state.conversations[conversationId];

    if (!rootConversation || rootConversation.parentId !== null) {
      return;
    }

    const deletedConversationIds = collectConversationTreeIds(
      state.conversations,
      conversationId,
    );

    if (!deletedConversationIds.length) {
      return;
    }

    const deletedConversationIdSet = new Set(deletedConversationIds);
    const deletedMessageIds = deletedConversationIds.flatMap(
      (deletedConversationId) =>
        state.conversations[deletedConversationId]?.messages.map((message) => message.id) ??
        [],
    );
    const deleteAllThreads =
      deletedConversationIds.length === Object.keys(state.conversations).length;
    const replacementConversation = createMainConversation({
      createdAt: new Date().toISOString(),
      id: createId("conversation"),
      modelId: state.defaultModelId,
      serviceId: state.defaultServiceId,
    });

    abortChatStreams(deletedConversationIds);

    if (
      selectionDraft &&
      deletedConversationIdSet.has(selectionDraft.conversationId)
    ) {
      setSelectionDraft(null);
      window.getSelection()?.removeAllRanges();
    }

    for (const deletedConversationId of deletedConversationIds) {
      delete panelRefs.current[deletedConversationId];
      delete anchorRefs.current[deletedConversationId];
      delete composerSurfaceRefs.current[deletedConversationId];
      delete tabRefs.current[deletedConversationId];
      delete panelScrollPositionsRef.current[deletedConversationId];
    }

    for (const deletedMessageId of deletedMessageIds) {
      delete typingProgressByMessageIdRef.current[deletedMessageId];
    }

    setDrafts((current) => {
      let changed = false;
      const next = { ...current };

      for (const deletedConversationId of deletedConversationIds) {
        if (!Object.hasOwn(next, deletedConversationId)) {
          continue;
        }

        delete next[deletedConversationId];
        changed = true;
      }

      if (deleteAllThreads && next[replacementConversation.id] !== "") {
        next[replacementConversation.id] = "";
        changed = true;
      }

      return changed ? next : current;
    });

    setTypingMessageIds((current) => {
      let changed = false;
      const next = { ...current };

      for (const deletedMessageId of deletedMessageIds) {
        if (!next[deletedMessageId]) {
          continue;
        }

        delete next[deletedMessageId];
        changed = true;
      }

      return changed ? next : current;
    });

    startTransition(() => {
      setState((current) => deleteThread(current, conversationId, replacementConversation));
    });
  }

  function handleSetMainViewMode(nextViewMode: MainViewMode) {
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
    setSearchModalOpen(false);
    setSearchQuery("");
    setMainViewMode(nextViewMode);

    if (isMobileViewport) {
      setLeftSidebarOpen(false);
      setState((current) =>
        current.railOpen ? { ...current, railOpen: false } : current,
      );
    }

    setState((current) =>
      current.railOpen ? { ...current, railOpen: false } : current,
    );
  }

  function handleToggleLeftSidebar() {
    if (isMobileViewport) {
      setState((current) =>
        current.railOpen ? { ...current, railOpen: false } : current,
      );
    }

    startTransition(() => {
      setLeftSidebarOpen((current) => !current);
    });
  }

  function handleToggleRail() {
    if (isMobileViewport) {
      setLeftSidebarOpen(false);
    }

    startTransition(() => {
      setState((current) => ({
        ...current,
        railOpen: !current.railOpen,
      }));
    });
  }

  function handleCloseRail() {
    setState((current) =>
      current.railOpen ? { ...current, railOpen: false } : current,
    );
  }

  async function handleSaveProfile(args: {
    displayName: string;
    email: string;
  }) {
    setProfileSaving(true);
    setProfileSaveError(null);

    try {
      await onUpdateProfile(args);
      setProfileModalOpen(false);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 401) {
        onAuthExpired();
        return;
      }

      setProfileSaveError(getErrorText(error, "Unable to update your profile."));
    } finally {
      setProfileSaving(false);
    }
  }

  const handleChooseLocalDirectory = vault.chooseDirectory;
  const handleClearLocalDirectory = vault.clearDirectory;
  const handleManualCloudBackup = vault.syncNow;

  async function handleWorkspaceLogout() {
    abortAllChatStreams();
    try {
      await vault.flushLocal();
      onLogout();
    } catch (error) {
      setProfileSaveError(getErrorText(error, "Your latest edit could not be saved. Download your vault before signing out."));
    }
  }

  const selectionTooltipLayout =
    selectionDraft && typeof window !== "undefined"
      ? getSelectionTooltipLayout({
          rect: selectionDraft.rect,
          tooltipHeight: toolbarSize.height,
          tooltipWidth: toolbarSize.width,
          viewportHeight: window.innerHeight,
          viewportMargin: TOOLTIP_VIEWPORT_MARGIN,
          viewportWidth: window.innerWidth,
        })
      : { left: 0, maxHeight: 0, top: 0 };
  const toolbarStyle = {
    left: `${selectionTooltipLayout.left}px`,
    maxHeight: `${selectionTooltipLayout.maxHeight}px`,
    top: `${selectionTooltipLayout.top}px`,
  } as CSSProperties;
  const conversationCanvasStyle = {
    "--chat-panel-width": `${chatPanelLayout.width}px`,
  } as CSSProperties;

  function renderConversationChatPanel(conversation: Conversation) {
    return <DocumentPanel key={conversation.id} conversation={conversation}
      isActive={conversation.id === activeConversation.id} isSubmitting={Boolean(pendingConversationIds[conversation.id])}
      aiControls={<AIControls conversation={conversation} conversations={state.conversations} disabled={Boolean(pendingConversationIds[conversation.id])} onChange={(settings) => handleAISettingsChange(conversation.id, settings)} />}
      groupControl={<ConversationGroupSelect className="is-composer-group" conversationId={conversation.id} groups={state.groups} onAssign={handleAssignConversationGroup} />}
      recentModelSelections={recentModelSelections} theme={theme} anchors={Object.values(getAnchorsByMessageId(state.conversations, conversation.id)).flat()}
      error={documentErrors[conversation.id] ?? documentUploadByConversationId[conversation.id]?.error ?? undefined}
      onChange={(document) => handleDocumentChange(conversation.id, document)}
      onRename={(title) => handleRenameThread(conversation.id, title)}
      onSubmit={(request) => handleDocumentSubmit(conversation.id, request)} onStop={() => stopChatStream(conversation.id)}
      onSelection={(selection) => { setSelectionDraft(selection); setSelectionIntent("branch"); setSelectionResponseDestination("inline"); setSelectionReplaceText(false); }}
      onVisibleOutlineChange={handleVisibleOutlineChange}
      onClearSelection={() => setSelectionDraft((current) => current?.conversationId === conversation.id ? null : current)}
      onOpenBranch={handleSelectConversation} onOpenNote={(noteId) => setNoteOpenRequest((current) => ({noteId, sequence:(current?.sequence ?? 0)+1}))}
      onModelChange={(serviceId,modelId) => handleModelChange(conversation.id,serviceId,modelId)}
      onUpload={(files) => {void handleUploadDocuments(conversation.id,files);}}
      onRemoveAttachment={(id) => handleRemoveDocument(conversation.id,id)} uploading={documentUploadByConversationId[conversation.id]?.uploading}
      onAcceptVersion={(id) => handleAcceptDocumentVersion(conversation.id,id)} onUndoInsertion={(id) => handleUndoDocumentInsertion(conversation.id,id)}
      registerPanelRef={(element) => {panelRefs.current[conversation.id]=element;}}
      registerAnchorRef={(id,element) => {anchorRefs.current[id]=element;}}
      registerBranchOriginRef={(element) => {branchOriginRefs.current[conversation.id]=element;}}
    />;
  }

  function renderExpandedTreeConversation(
    conversation: Conversation,
    allowMinimize: boolean,
  ) {
    const resizeInfo = getPanelResizeInfo(conversation);
    const resizeMinimum = resizeChatPanels({ ...resizeInfo, delta: -resizeInfo.maxWidth }).width;
    const resizeMaximum = resizeChatPanels({ ...resizeInfo, delta: resizeInfo.maxWidth }).width;
    const isResizing =
      conversation.id === resizingChatPanelConversationId &&
      isResizingChatPanel;
    const contextLabel = conversation.id === activeConversation.id ? "Current document" : conversation.parentId === null ? "Main document" : "Parent document";

    return (
      <div
        className={
          isResizing
            ? "conversation-tree-expanded panel-slot is-resizable is-split-context is-resizing"
            : "conversation-tree-expanded panel-slot is-resizable is-split-context"
        }
        data-expanded-conversation-id={conversation.id}
        key={conversation.id}
        style={{ "--chat-panel-width": `${resizeInfo.width}px` } as CSSProperties}
      >
        {!contextLabel.startsWith("Current ") || (allowMinimize && conversation.parentId) ? (
          <div className="panel-context-header">
            {!contextLabel.startsWith("Current ") ? (
              <span className="panel-context-label">{contextLabel}</span>
            ) : null}
            {allowMinimize && conversation.parentId ? (
              <button
                aria-label={`Minimize ${conversation.title}`}
                className="conversation-tree-minimize"
                onClick={() => {
                  pendingTreeLaneFocusRef.current = conversation.parentId;
                  suppressNextChatAutoCenterRef.current = true;
                  handleSelectConversation(conversation.parentId!);
                }}
                type="button"
                title="Minimize this side document"
              >
                <svg
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth="1.8"
                  viewBox="0 0 24 24"
                >
                  <path d="M6 12h12" />
                </svg>
                <span>Minimize</span>
              </button>
            ) : null}
          </div>
        ) : null}
        {renderConversationChatPanel(conversation)}
        <div
          aria-label={conversation.parentId ? "Resize side chat panel width" : "Resize chat panel width"}
          aria-orientation="vertical"
          aria-valuemax={resizeMaximum}
          aria-valuemin={resizeMinimum}
          aria-valuenow={Math.round(resizeInfo.width)}
          aria-valuetext={`${Math.round(resizeInfo.width)} pixels wide`}
          className={`panel-resize-handle is-visible${resizeInfo.direction === -1 ? " is-left-edge" : ""}`}
          onDoubleClick={() => handleResetChatPanelWidth(conversation)}
          onKeyDown={(event) => handleChatPanelResizeKeyDown(conversation, event)}
          onPointerDown={(event) =>
            handleChatPanelResizePointerDown(conversation.id, event)
          }
          role="separator"
          tabIndex={0}
          title={`Drag to resize ${conversation.title}. Double-click to reset.`}
        >
          <span className="panel-resize-handle-grip" />
        </div>
      </div>
    );
  }

  function renderWorkspaceBrand() {
    return (
      <div className="workspace-session-brand">
        <button
          aria-label={leftSidebarOpen ? "Close chat sidebar" : "Open chat sidebar"}
          aria-pressed={leftSidebarOpen}
          className="workspace-menu-button"
          onClick={handleToggleLeftSidebar}
          type="button"
        >
          <SidebarPanelIcon />
        </button>
        <h1>Margin Chat</h1>
      </div>
    );
  }

  function renderChatTreeNavigation() {
    if (isMobileViewport) {
      return (
        <nav aria-label="Conversation hierarchy" className="chat-tree-navigation mobile-chat-navigation">
          {parentConversation ? (
            <button className="mobile-parent-button" onClick={() => handleSelectConversation(parentConversation.id)}
              title={`Back to ${parentConversation.title}`} type="button">
              <span aria-hidden="true">←</span> Back to parent
            </button>
          ) : null}
          <span aria-current="page" className="mobile-active-chat-title" title={activeConversation.title}>
            {activeConversation.title}
          </span>
        </nav>
      );
    }
    return (
      <div className="chat-tree-navigation">
        <nav aria-label="Conversation hierarchy" className="canvas-breadcrumb">
          {path.map((conversation, index) => (
            <span
              className={
                conversation.id === activeConversation.id
                  ? "breadcrumb-item is-active"
                  : "breadcrumb-item"
              }
              key={conversation.id}
            >
              {index > 0 ? (
                <span aria-hidden="true" className="breadcrumb-separator">
                  ›
                </span>
              ) : null}
              <button
                aria-current={
                  conversation.id === activeConversation.id ? "page" : undefined
                }
                className="breadcrumb-button"
                data-breadcrumb-conversation-id={conversation.id}
                onClick={() => handleSelectConversation(conversation.id)}
                title={conversation.title}
                type="button"
              >
                {conversation.title}
              </button>
            </span>
          ))}
        </nav>
      </div>
    );
  }

  if (!vault.ready) {
    return <div className="auth-shell"><section className="thread-dialog" role="status">
      <h2>Opening your Markdown vault</h2>
      <p>{vault.message ?? "Reading the files saved on this device…"}</p>
      {vault.message ? <button className="thread-dialog-button" onClick={() => window.location.reload()}>Try again</button> : null}
    </section></div>;
  }

  return (
    <ConversationGroupPickerContext.Provider value={{
      getSuggestion: (conversationId) => {
        const match = jev.groupSuggestions[conversationId];
        if (match && state.groups[match.groupId]) return { name: state.groups[match.groupId].name, groupId: match.groupId };
        const category = jev.categories[conversationId];
        return category ? { name: getThreadCategoryLabel(category) } : null;
      },
      isSuggesting: jev.status === "checking" || jev.status === "loading",
      status: jev.status,
      onCreateAndAssign: handleCreateAndAssignGroup,
    }}>
    <div className="app-shell">
      <div className="app-chrome">
        <div className="workspace-notifications">
          <NotificationToast
            message={billingNotice?.message ?? null}
            kind={billingNotice?.kind}
            onDismiss={onDismissBillingNotice}
          />
          <NotificationToast
            message={vault.conflicts.length ? `${vault.conflicts.length} conflicting ${vault.conflicts.length === 1 ? "edit is" : "edits are"} preserved for review.` : vault.message}
            action={{ label: "Vault settings", onClick: () => { setProfileInitialTab("storage"); setProfileModalOpen(true); } }}
          />
        </div>
        <div className="workspace-shell">


          {mobilePanelsOpen ? (
            <button
              aria-label="Close mobile navigation panels"
              className="workspace-mobile-backdrop"
              onClick={() => {
                setLeftSidebarOpen(false);
                setState((current) =>
                  current.railOpen
                    ? {
                        ...current,
                        railOpen: false,
                      }
                    : current,
                );
              }}
              type="button"
            />
          ) : null}

          <main className="workspace">
            <ResizableSidebar collapsed={!leftSidebarOpen} mobile={isMobileViewport} onResizingChange={setIsResizingSidebar}>
            {!isMobileViewport && renderWorkspaceBrand()}
            <ThreadSidebar
              mapExplorerRef={setGraphExplorerContainer}
              mapExplorerActive={mapSidebarSection === "explore"}
              onSelectSidebarSection={setMapSidebarSection}
              activeOutlineItemId={activeOutlineItemId}
              activeThreadId={activeRootConversation.id}
              collapsed={!leftSidebarOpen}
              currentChatOutline={currentChatOutline}
              currentChatTitle={activeConversation.title}
              groups={state.groups}
              mainViewMode={mainViewMode}
              onAssignGroup={handleAssignConversationGroup}
              onCreateGroup={handleCreateConversationGroup}
              onDeleteThread={handleDeleteThread}
              onNewChat={handleCreateMainConversation}
              onNewNote={handleCreateStandaloneNote}
              onOpenInbox={() => setCaptureInboxOpen(true)}
              onImportChatHistory={() => setHistoryImportOpen(true)}
              onOpenProfile={() => {
                setProfileSaveError(null);
                setProfileModalOpen(true);
              }}
              onOpenSettings={() => setAppSettingsOpen(true)}
              onOpenSearch={handleOpenSearch}
              onPinThread={handlePinThread}
              onRenameThread={handleRenameThread}
              onSelectOutlineItem={handleSelectOutlineItem}
              onSetMainViewMode={handleSetMainViewMode}
              onSelectThread={handleRevealConversation}
              onToggleCollapse={handleToggleLeftSidebar}
              onToggleGroup={handleToggleConversationGroup}
              onToggleTheme={() =>
                onSetTheme((current) => getNextTheme(current))
              }
              onUnpinThread={handleUnpinThread}
              pinnedThreads={pinnedThreadSummaries}
              streamingThreadIds={streamingThreadIds}
              theme={theme}
              threads={threadSummaries}
            />
            </ResizableSidebar>

            <div className="workspace-main-pane">
              {!isGraphView && (!isTileView || !leftSidebarOpen || isMobileViewport) && (
                <header className="workspace-session-bar workspace-content-toolbar">
                  {(!leftSidebarOpen || isMobileViewport) && renderWorkspaceBrand()}

                  {!isTileView && !isGraphView
                    ? renderChatTreeNavigation()
                    : null}

                  <div className="workspace-session-actions">
                    {!isTileView &&
                    !isGraphView &&
                    branchAccessEnabled ? (
                      <button
                        aria-controls="branch-navigation-map"
                        aria-expanded={state.railOpen}
                        className={
                          state.railOpen
                            ? "branch-drawer-trigger is-active"
                            : "branch-drawer-trigger"
                        }
                        onClick={handleToggleRail}
                        type="button"
                      >
                        <span>Branches</span>
                        <strong>{branchNavigationCount}</strong>
                      </button>
                    ) : null}
                  </div>
                </header>
              )}
              <div className="workspace-content">

            <section
              className={
                isTileView
                  ? "canvas-section is-thread-tile-view"
                  : isGraphView
                    ? "canvas-section is-graph-view"
                    : "canvas-section"
              }
            >
              {Object.values(state.conversations).every((chat) => !chat.messages.length && !chat.notes?.length && !chat.documents?.length) &&
                <aside className="history-import-welcome">
                  <div><strong>Start with your conversations</strong><p>Bring chats from ChatGPT and pick up where you left off.</p></div>
                  <button type="button" className="thread-dialog-button" onClick={() => setHistoryImportOpen(true)}>Bring your chat history</button>
                </aside>}
              <JevRelatedItems status={jev.status} related={jev.related} warning={jev.warning} conversations={state.conversations} currentId={activeConversation.id} onSelect={handleRevealConversation} />
              {isMobileViewport && !isTileView && !isGraphView ? (
                <div className="workspace-mobile-shell">
                  <div className="workspace-mobile-summary">
                    <p className="eyebrow">
                      {isMainView ? "Main chat" : "Branch chat"}
                    </p>
                    <h2>{activeConversation.title}</h2>
                    <p className="workspace-mobile-copy">
                      {mobileChatContextCopy}
                    </p>
                  </div>

                  <div
                    aria-label="Mobile workspace actions"
                    className="workspace-mobile-actions"
                    role="toolbar"
                  >
                    <button
                      aria-pressed={leftSidebarOpen}
                      className={
                        leftSidebarOpen
                          ? "workspace-mobile-button is-active"
                          : "workspace-mobile-button"
                      }
                      onClick={handleToggleLeftSidebar}
                      type="button"
                    >
                      <span>Chats {threadSummaries.length}</span>
                      <strong>{threadSummaries.length}</strong>
                    </button>
                    <button
                      aria-pressed={state.railOpen}
                      aria-controls="branch-navigation-map"
                      className={
                        state.railOpen
                          ? "workspace-mobile-button is-active"
                          : "workspace-mobile-button"
                      }
                      disabled={!branchAccessEnabled}
                      onClick={handleToggleRail}
                      type="button"
                    >
                      <span>Map {branchNavigationCount}</span>
                      <strong>{branchNavigationCount}</strong>
                    </button>
                    <button
                      className="workspace-mobile-button"
                      onClick={handleOpenSearch}
                      type="button"
                    >
                      <span>Search</span>
                    </button>
                    <button
                      className="workspace-mobile-button is-primary"
                      onClick={handleCreateMainConversation}
                      type="button"
                    >
                      <span>New chat</span>
                    </button>
                  </div>
                </div>
              ) : null}

              {isTileView ? (
                <div className="canvas-head">
                  <div className="canvas-view-intro">
                    <p className="eyebrow">Main chats</p>
                    <h2>Threads</h2>
                    <p className="canvas-hint">
                      Search or choose a thread to continue the conversation.
                    </p>
                  </div>
                </div>
              ) : null}

              {isTileView ? (
                <MainChatTileView
                  activeThreadId={activeRootConversation.id}
                  groups={state.groups}
                  onAssignGroup={handleAssignConversationGroup}
                  onCreateGroup={handleCreateConversationGroup}
                  onOpenThread={handleSelectConversation}
                  onToggleGroup={handleToggleConversationGroup}
                  threads={threadSummaries}
                />
              ) : isGraphView ? (
                <KnowledgeGraphWorkspace
                  onToggleSidebar={handleToggleLeftSidebar}
                  sidebarOpen={leftSidebarOpen}
                  onAddChildNote={handleAddMapChildNote}
                  onExpandTopicWithAI={(id) => { void topicExpansion.expand(id); }}
                  onCancelTopicExpansion={topicExpansion.cancel}
                  expandingTopicId={topicExpansion.pendingId}
                  topicExpansionProgress={topicExpansion.progress}
                  topicExpansionError={topicExpansion.error}
                  onDismissTopicExpansionError={topicExpansion.dismissError}
                  explorerContainer={graphExplorerContainer}
                  onOpenExplorer={() => { setMapSidebarSection("explore"); setLeftSidebarOpen(true); }}
                  onFocusCanvas={() => { if (isMobileViewport) setLeftSidebarOpen(false); }}
                  onSaveUrlMapNode={(graph, nodeId) => setState((current) => saveUrlMapNode(current, graph, nodeId))}
                  urlMapAIOptions={{ serviceId: state.defaultServiceId, modelId: state.defaultModelId, ai: activeConversation.ai }}
                  onSavePublicTopic={handleSavePublicTopic}
                  onCreateMapNote={handleCreateMapNote}
                  onSetMapConnection={handleSetMapConnection}
                  onRemoveMapNote={handleRemoveMapNote}
                  onUndoMapEdit={handleUndoMapEdit}
                  mapEditMessage={mapEditMessage}
                  canUndoMapEdit={Boolean(mapUndoRef.current)}
                  key={`graph-${user.id}`}
                  workspaceKey={user.id}
                  threads={threadSummaries}
                  activeConversationId={activeConversation.id}
                  conversations={state.conversations}
                  focusRequest={graphFocusRequest}
                  onFocusRequestHandled={(requestId) => setGraphFocusRequest((current) => current?.requestId === requestId ? null : current)}
                  graphLayouts={state.graphLayouts}
                  groups={state.groups}
                  relatedItems={jev.related}
                  relatedStatus={jev.status}
                  jev={{ userId: user.id, enabled: jevEnabled, ready: vault.ready }}
                  onActivateConversation={handleSelectConversation}
                  onAssignGroup={handleAssignConversationGroup}
                  onCreateChildConversation={handleAddGraphChildChat}
                  onOpenConversation={(conversationId) =>
                    handleSelectConversation(conversationId, {
                      nextViewMode: "chat",
                    })
                  }
                  onToggleGroup={handleToggleConversationGroup}
                  onUpdateGraphNodeLayouts={handleUpdateGraphNodeLayouts}
                  renderDockedConversation={(conversationId, source) => {
                    const conversation = state.conversations[conversationId];

                    return conversation
                      ? <>
                          <GraphSourceFocus
                            source={source}
                            getPanelElement={() => panelRefs.current[conversationId] ?? null}
                          />
                          {renderConversationChatPanel(conversation)}
                        </>
                      : null;
                  }}
                  renderExpandedConversation={(conversationId) => {
                    const conversation = state.conversations[conversationId];

                    return conversation
                      ? renderConversationChatPanel(conversation)
                      : null;
                  }}
                />
              ) : (
                <div className="chat-tree-workspace">
                  <div
                  className={
                    `conversation-canvas is-tree-browser${conversationTreeLanes.length ? " has-tree-context" : ""}${isResizingChatPanel ? " is-resizing-panel" : ""}`
                  }
                  ref={canvasRef}
                  style={conversationCanvasStyle}
                >
                  {renderExpandedTreeConversation(activeRootConversation, false)}

                  {conversationTreeLanes.map((lane, laneIndex) => {
                    const parentConversation =
                      state.conversations[lane.parentId];

                    if (!parentConversation) {
                      return null;
                    }

                    const marginNotes = lane.noteIds
                      .map((noteId) =>
                        (parentConversation.notes ?? []).find(
                          (note) => note.id === noteId,
                        ),
                      )
                      .filter(
                        (note): note is ConversationNote => Boolean(note),
                      );

                    return (
                      <section
                        aria-label={`Side items for ${parentConversation.title}`}
                        className={
                          lane.selectedConversationId
                            ? "conversation-tree-lane has-expanded-chat"
                            : "conversation-tree-lane"
                        }
                        data-tree-depth={laneIndex + 1}
                        data-tree-parent-id={lane.parentId}
                        key={lane.parentId}
                        style={lane.selectedConversationId ? { "--chat-panel-width": `${getRenderedPanelWidth(lane.selectedConversationId)}px` } as CSSProperties : undefined}
                      >
                        <header className="conversation-tree-lane-head">
                          <span>Depth {laneIndex + 1}</span>
                          <strong>{parentConversation.title}</strong>
                          <span>
                            {lane.conversationIds.length
                              ? `${lane.conversationIds.length} child${
                                  lane.conversationIds.length === 1
                                    ? ""
                                    : "ren"
                                }`
                              : ""}
                            {lane.conversationIds.length && marginNotes.length
                              ? " · "
                              : ""}
                            {marginNotes.length
                              ? `${marginNotes.length} note${
                                  marginNotes.length === 1 ? "" : "s"
                                }`
                              : ""}
                          </span>
                        </header>
                        <div className="conversation-tree-lane-list">
                          {lane.conversationIds.map((conversationId) => {
                            const conversation =
                              state.conversations[conversationId];

                            if (!conversation) {
                              return null;
                            }

                            if (
                              conversation.id === lane.selectedConversationId
                            ) {
                              return renderExpandedTreeConversation(
                                conversation,
                                true,
                              );
                            }

                            return (
                              <ConversationTreeNode
                                conversation={conversation}
                                key={conversation.id}
                                onExpand={(nextConversationId) =>
                                  handleSelectConversation(nextConversationId)
                                }
                                registerNodeRef={(
                                  nextConversationId,
                                  element,
                                ) => {
                                  treeNodeRefs.current[nextConversationId] =
                                    element;
                                }}
                              />
                            );
                          })}
                          {marginNotes.map((note) => (
                            <MarginNoteTreeNode
                              conversationId={parentConversation.id}
                              key={note.id}
                              note={note}
                              openRequest={noteOpenRequest?.noteId === note.id ? noteOpenRequest.sequence : undefined}
                              onDelete={handleDeleteNote}
                              onUpdate={handleUpdateNote}
                              onUse={
                                parentConversation.kind === "note"
                                  ? undefined
                                  : handleUseNote
                              }
                            />
                          ))}
                        </div>
                      </section>
                    );
                  })}
                </div>
                </div>
              )}
            </section>
            {!isTileView && !isGraphView ? (
              <BranchRail
                activeConversationId={activeConversation.id}
                conversations={state.conversations}
                onClose={handleCloseRail}
                onSelectConversation={(conversationId) => handleSelectConversation(conversationId, { preserveRail: !isMobileViewport })}
                open={state.railOpen}
                registerTabRef={(conversationId, element) => { tabRefs.current[conversationId] = element; }}
                rootId={activeRootConversation.id}
              />
            ) : null}
              </div>
            </div>

          {!isTileView && !isGraphView && connections.length ? (
            <ConnectorOverlay
              connections={connections}
              occlusionRects={connectorOcclusionRects}
            />
          ) : null}

          {!isTileView && selectionDraft ? (
            <form
              className="selection-tooltip"
              data-testid="branch-composer"
              onSubmit={(event) => {
                event.preventDefault();
                if (selectionIntent === "note") handleCreateSelectionNote();
                else handleCreateBranch();
              }}
              ref={toolbarRef}
              style={toolbarStyle}
            >
              <div className="selection-tooltip-head">
                <p className="eyebrow">
                  {selectionIntent === "note"
                    ? "New margin note"
                    : selectionDraft.sourceKind === "standalone-note"
                      ? "Selected note text"
                      : "Ask AI about this passage"}
                </p>
                <button
                  aria-label={
                    selectionIntent === "note"
                      ? "Cancel margin note"
                      : "Cancel new branch"
                  }
                  className="selection-close"
                  onClick={() => {
                    setSelectionDraft(null);
                    window.getSelection()?.removeAllRanges();
                  }}
                  type="button"
                >
                  <CloseIcon />
                </button>
              </div>
              <p className="selection-tooltip-quote">
                “{excerpt(selectionDraft.quote, 132)}”
              </p>
              <div aria-label="Selected text action" className="selection-intent-switch" role="group">
                <button
                  aria-label={
                    selectionDraft.sourceKind === "standalone-note"
                      ? "Create a side note"
                      : "Add a margin note"
                  }
                  aria-pressed={selectionIntent === "note"}
                  className={selectionIntent === "note" ? "is-active" : ""}
                  onClick={() => setSelectionIntent("note")}
                  type="button"
                >
                  {selectionDraft.sourceKind === "standalone-note"
                    ? "Side note"
                    : "Margin note"}
                </button>
                <button
                  aria-label={
                    selectionDraft.sourceKind === "standalone-note"
                      ? "Create a side chat"
                      : "Start branch"
                  }
                  aria-pressed={selectionIntent === "branch"}
                  className={selectionIntent === "branch" ? "is-active" : ""}
                  onClick={() => setSelectionIntent("branch")}
                  type="button"
                >
                  {selectionDraft.sourceKind === "standalone-note"
                    ? "Side chat"
                    : "Ask AI"}
                </button>
              </div>
              {selectionIntent === "branch" && selectionDraft.sourceBlockId ? <div className="document-ai-options">
                <div role="group" aria-label="Response destination"><button type="button" aria-pressed={selectionResponseDestination === "inline"} onClick={()=>setSelectionResponseDestination("inline")}>In this document</button><button type="button" aria-pressed={selectionResponseDestination === "side"} onClick={()=>setSelectionResponseDestination("side")}>Side document ↗</button></div>
                {selectionResponseDestination === "inline" ? <label><input type="checkbox" checked={selectionReplaceText} onChange={(event)=>setSelectionReplaceText(event.target.checked)}/>Replace selection</label> : null}
              </div> : null}
              {selectionIntent === "note" ? (
                <p className="selection-note-privacy">Margin note · Not sent to AI</p>
              ) : null}
              <div className="selection-input-row">
                <input
                  aria-label={selectionIntent === "note" ? "Margin note" : "Branch prompt"}
                  id="branch-prompt"
                  onChange={(event) =>
                    setSelectionDraft((current) =>
                      current
                        ? { ...current, prompt: event.target.value }
                        : current,
                    )
                  }
                  placeholder={selectionIntent === "note" ? NOTE_PROMPT_PLACEHOLDER : BRANCH_PROMPT_PLACEHOLDER}
                  type="text"
                  value={selectionDraft.prompt}
                />
                <button
                  aria-label={selectionIntent === "note" ? "Save margin note" : "Create branch with prompt"}
                  className="selection-send"
                  disabled={!selectionDraft.prompt.trim()}
                  type="submit"
                >
                  <SendIcon />
                </button>
              </div>
              {selectionIntent === "branch" ? <div className="selection-actions">
                <button
                  className="selection-explain"
                  onClick={handleExplainSelection}
                  type="button"
                >
                  Explain selection
                </button>
              </div> : null}
            </form>
          ) : null}

          <SearchModal
            conversations={state.conversations}
            currentConversation={activeConversation}
            groups={state.groups}
            categories={jev.categories}
            jev={{ userId: user.id, enabled: jevEnabled, ready: vault.ready, serviceStatus: jev.status }}
            onOpenSource={handleOpenSearchSource}
            isOpen={searchModalOpen}
            onClose={handleCloseSearch}
            onQueryChange={setSearchQuery}
            onSelectResult={handleSelectSearchResult}
            query={searchQuery}
            results={searchResults}
          />
          <SearchSourceFocus
            request={searchSourceRequest}
            conversations={state.conversations}
            getPanelElement={(conversationId) => panelRefs.current[conversationId] ?? null}
          />

          {captureInboxOpen ? <CaptureInbox
            onClose={() => setCaptureInboxOpen(false)}
            onOpenNote={(capture) => {
              setSelectionDraft(null);
              setMainViewMode("chat");
              setState((current) => openCaptureAsNote(current, capture));
              setCaptureInboxOpen(false);
              if (isMobileViewport) setLeftSidebarOpen(false);
            }}
          /> : null}

          {historyImportOpen && <ChatHistoryImport
            existingIds={Object.keys(state.conversations)} cloudSyncEnabled={cloudSyncEnabled}
            onImport={vault.importChatHistory} onUndo={vault.undoChatHistory}
            onOpenChat={(id) => handleSelectConversation(id, { nextViewMode: "chat" })}
            onClose={() => setHistoryImportOpen(false)}
          />}
          <ProfileModal
            initialTab={profileInitialTab}
            billingDashboard={billingDashboard}
            billingDashboardLoading={billingDashboardLoading}
            billingDashboardError={billingDashboardError}
            onRefreshBilling={onRefreshBilling}
            onAddMoney={onAddMoney}
            vault={vault}
            billingErrorMessage={billingErrorMessage}
            billingSubmitting={billingSubmitting}
            cloudBackupMatchesLocal={cloudBackupMatchesLocal}
            cloudBackupSizeBytes={cloudBackupSizeBytes}
            cloudSyncEnabled={cloudSyncEnabled}
            cloudSyncStatus={storageMode}
            errorMessage={profileSaveError}
            isOpen={profileModalOpen}
            isSaving={profileSaving}
            localDirectoryStatus={localDirectoryStatus}
            onBackupToCloud={handleManualCloudBackup}
            onChooseLocalDirectory={handleChooseLocalDirectory}
            onClearLocalDirectory={handleClearLocalDirectory}
            onClose={() => {
              if (profileSaving) {
                return;
              }

              setProfileSaveError(null);
              setProfileModalOpen(false);
            }}
            onManageBilling={onManageBilling}
            onLogout={handleWorkspaceLogout}
            onSaveApiKeys={onUpdateApiKeys}
            onStartSubscription={onStartSubscription}
            onSave={handleSaveProfile}
            user={user}
          />

          <AppSettingsModal
            jevEnabled={jevEnabled}
            jevStatus={jev.status}
            onSetJevEnabled={setJevEnabled}
            isOpen={appSettingsOpen}
            mainViewMode={mainViewMode}
            onClose={() => setAppSettingsOpen(false)}
            onSetMainViewMode={handleSetMainViewMode}
            onSetTheme={onSetTheme}
            theme={theme}
          />
          </main>
        </div>
      </div>
    </div>
    </ConversationGroupPickerContext.Provider>
  );
}
