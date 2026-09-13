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
import AuthLanding from "./components/AuthLanding";
import BranchRail from "./components/BranchRail";
import ChatPanel from "./components/ChatPanel";
import ConnectorOverlay from "./components/ConnectorOverlay";
import ConversationTreeNode from "./components/ConversationTreeNode";
import ConversationGraphView from "./components/ConversationGraphView";
import { ConversationGroupSelect } from "./components/ConversationGroupControls";
import MainChatTileView from "./components/MainChatTileView";
import MarginNoteTreeNode from "./components/MarginNoteTreeNode";
import ProfileModal from "./components/ProfileModal";
import CaptureInbox from "./components/CaptureInbox";
import { openCaptureAsNote } from "./lib/captures";
import SearchModal from "./components/SearchModal";
import StandaloneNotePanel from "./components/StandaloneNotePanel";
import ThreadSidebar from "./components/ThreadSidebar";
import {
  ApiError,
  requestCreateBillingPortalSession,
  requestCreateCheckoutSession,
  requestConfirmCheckoutSession,
  requestDeleteDocument,
  requestAuthSession,
  requestChatReply,
  requestChatTitle,
  requestLogin,
  requestLogout,
  requestPasswordReset,
  requestPasswordResetConfirm,
  requestSignup,
  requestUploadDocument,
  requestUpdateProfile,
  requestUpdateApiKeys,
} from "./lib/api";
import {
  getRecentModelSelectionsStorageKey,
  getStateSavedAtStorageKey,
  getStateStorageKey,
  hydratePersistedState,
  loadRecentModelSelections,
  loadStoredState,
} from "./lib/appState";
import { getConversationRequestPayload } from "./lib/chatContext";
import { buildSearchResults, buildThreadSummaries } from "./lib/conversationSearch";
import {
  CONVERSATION_GROUP_COLORS,
  assignConversationToGroup,
  getConversationGroupId,
  removeConversationsFromGroups,
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
import { rememberOfflineUser, loadOfflineUser, forgetOfflineUser } from "./lib/offlineSession";
import {
  getBackendServiceLabel,
  resolveBackendServiceModelId,
  type RecentBackendServiceSelection,
  upsertRecentBackendServiceSelection,
} from "./lib/services";
import {
  buildBranchGraphNodeLayout,
  buildRootGraphNodeLayout,
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
import { buildChatOutline } from "./lib/chatOutline";
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

const THEME_STORAGE_KEY = "margin-chat-theme";
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
const CHAT_PANEL_VIEWPORT_MARGIN_PX = 180;
const MOBILE_PANEL_RESIZE_BREAKPOINT_PX = 900;
const ASSISTANT_STREAM_FLUSH_INTERVAL_MS = 32;
const CLOUD_RECONCILIATION_INTERVAL_MS = 30_000;

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
type ThemeMode = "light" | "dark";
type AuthStatus = "checking" | "authenticated" | "unauthenticated";
type StorageMode = "loading" | "fallback" | "local" | "server";

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

function MenuIcon() {
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
      <path d="M5 7h14" />
      <path d="M5 12h14" />
      <path d="M5 17h14" />
    </svg>
  );
}

function getNextTheme(theme: ThemeMode): ThemeMode {
  return theme === "dark" ? "light" : "dark";
}

function getIsMobileViewport() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.matchMedia(
    `(max-width: ${MOBILE_PANEL_RESIZE_BREAKPOINT_PX}px)`,
  ).matches;
}

function loadInitialTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "dark";
  }

  try {
    const storedValue = window.localStorage.getItem(THEME_STORAGE_KEY);

    if (storedValue === "light" || storedValue === "dark") {
      return storedValue;
    }
  } catch {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }

  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
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
  if (typeof window === "undefined") {
    return {
      max: CHAT_PANEL_MAX_WIDTH_PX,
      min: CHAT_PANEL_MIN_WIDTH_PX,
    };
  }

  return {
    max: clamp(
      window.innerWidth - CHAT_PANEL_VIEWPORT_MARGIN_PX,
      CHAT_PANEL_MIN_WIDTH_PX,
      CHAT_PANEL_MAX_WIDTH_PX,
    ),
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

function syncTheme(theme: ThemeMode) {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.theme = theme;
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

const INITIAL_THEME = loadInitialTheme();
const INITIAL_LEFT_SIDEBAR_OPEN = loadInitialLeftSidebarOpen();
const INITIAL_CHAT_PANEL_WIDTH = loadInitialChatPanelWidth();

if (typeof document !== "undefined") {
  syncTheme(INITIAL_THEME);
}

interface WorkspaceAppProps {
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

interface ActiveChatStream {
  assistantMessageId: string;
  controller: AbortController;
  discard: () => void;
  flush: () => void;
  requestId: string;
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
    });

    links[messageId] = bucket;
  }

  return links;
}

function hasOverlappingAnchor(
  conversations: Record<string, Conversation>,
  selectionDraft: SelectionDraft,
): boolean {
  return Object.values(conversations).some((conversation) => {
    const anchor = conversation.branchAnchor;

    if (
      !anchor ||
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

function WorkspaceApp({
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
  const [graphFocusRequest, setGraphFocusRequest] = useState<{
    conversationId: string;
    requestId: number;
  } | null>(null);
  const [leftSidebarOpen, setLeftSidebarOpen] =
    useState(INITIAL_LEFT_SIDEBAR_OPEN);
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    getIsMobileViewport(),
  );
  const [chatPanelWidth, setChatPanelWidth] = useState(INITIAL_CHAT_PANEL_WIDTH);
  const [isResizingChatPanel, setIsResizingChatPanel] = useState(false);
  const [resizingChatPanelConversationId, setResizingChatPanelConversationId] =
    useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingConversationIds, setPendingConversationIds] = useState<
    Record<string, boolean>
  >({});
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
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileInitialTab, setProfileInitialTab] = useState<"account" | "storage">("account");
  const [captureInboxOpen, setCaptureInboxOpen] = useState(() => new URLSearchParams(window.location.search).has("inbox"));
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeOutlineItemId, setActiveOutlineItemId] = useState<string | null>(
    null,
  );
  const [toolbarSize, setToolbarSize] = useState(FALLBACK_TOOLTIP_SIZE);
  const [connections, setConnections] = useState<ConnectionLine[]>([]);
  const [connectorOcclusionRects, setConnectorOcclusionRects] = useState<
    ConnectorOcclusionRect[]
  >([]);
  const canvasRef = useRef<HTMLDivElement>(null);
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
  const activeChatStreamsRef = useRef<Map<string, ActiveChatStream>>(new Map());
  const workspaceMountedRef = useRef(true);
  const selectionSyncFrameRef = useRef(0);
  const panelResizeStateRef = useRef<{
    conversationId: string;
    originWidth: number;
    startClientX: number;
  } | null>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const cloudSyncEnabled = canSyncWorkspaceToCloud(user);
  const cloudBackupSizeBytes = useMemo(
    () => new TextEncoder().encode(JSON.stringify(state)).byteLength,
    [state],
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
  const currentChatOutline = buildChatOutline(activeConversation);
  const currentChatOutlineKey = currentChatOutline
    .map((item) => item.id)
    .join("|");
  const isTileView = mainViewMode === "tiles";
  const isGraphView = mainViewMode === "graph";
  const threadSummaries = buildThreadSummaries(state.conversations).map(
    (thread) => ({
      ...thread,
      groupId: getConversationGroupId(state.groups, thread.id),
    }),
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
    function syncChatPanelWidthToViewport() {
      setChatPanelWidth((current) => {
        const bounds = getChatPanelWidthBounds();
        const nextWidth = clamp(current, bounds.min, bounds.max);
        return nextWidth === current ? current : nextWidth;
      });
    }

    syncChatPanelWidthToViewport();
    window.addEventListener("resize", syncChatPanelWidthToViewport);

    return () => {
      window.removeEventListener("resize", syncChatPanelWidthToViewport);
    };
  }, []);

  useEffect(() => {
    function stopChatPanelResize() {
      const resizeState = panelResizeStateRef.current;

      if (!resizeState) {
        return;
      }

      panelResizeStateRef.current = null;
      setIsResizingChatPanel(false);
      setResizingChatPanelConversationId(null);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");

      panelRefs.current[resizeState.conversationId]?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }

    function handleChatPanelResizePointerMove(event: PointerEvent) {
      const resizeState = panelResizeStateRef.current;

      if (!resizeState) {
        return;
      }

      event.preventDefault();
      const bounds = getChatPanelWidthBounds();
      const nextWidth = clamp(
        resizeState.originWidth + (event.clientX - resizeState.startClientX),
        bounds.min,
        bounds.max,
      );

      setChatPanelWidth((current) =>
        current === nextWidth ? current : nextWidth,
      );
    }

    window.addEventListener("pointermove", handleChatPanelResizePointerMove);
    window.addEventListener("pointerup", stopChatPanelResize);
    window.addEventListener("pointercancel", stopChatPanelResize);
    window.addEventListener("blur", stopChatPanelResize);

    return () => {
      window.removeEventListener("pointermove", handleChatPanelResizePointerMove);
      window.removeEventListener("pointerup", stopChatPanelResize);
      window.removeEventListener("pointercancel", stopChatPanelResize);
      window.removeEventListener("blur", stopChatPanelResize);
    };
  }, []);

  useEffect(() => {
    if (mainViewMode === "chat" || !panelResizeStateRef.current) {
      return;
    }

    panelResizeStateRef.current = null;
    setIsResizingChatPanel(false);
    setResizingChatPanelConversationId(null);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
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

  useEffect(() => {
    workspaceMountedRef.current = true;

    return () => {
      workspaceMountedRef.current = false;

      for (const stream of activeChatStreamsRef.current.values()) {
        stream.discard();
        stream.controller.abort();
      }

      activeChatStreamsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (mainViewMode !== "chat") {
      return;
    }

    if (suppressNextChatAutoCenterRef.current) {
      suppressNextChatAutoCenterRef.current = false;
      return;
    }

    const panel = panelRefs.current[state.activeConversationId];
    panel?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [mainViewMode, state.activeConversationId]);

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
    isMobileViewport,
    leftSidebarOpen,
    mainViewMode,
    state.activeConversationId,
    state.conversations,
    state.railOpen,
  ]);

  function handleSetChatPanelWidth(nextWidth: number) {
    const bounds = getChatPanelWidthBounds();

    setChatPanelWidth((current) => {
      const clampedWidth = clamp(nextWidth, bounds.min, bounds.max);
      return current === clampedWidth ? current : clampedWidth;
    });
  }

  function handleResetChatPanelWidth() {
    const bounds = getChatPanelWidthBounds();

    handleSetChatPanelWidth(
      clamp(CHAT_PANEL_DEFAULT_WIDTH_PX, bounds.min, bounds.max),
    );
  }

  function handleChatPanelResizePointerDown(
    conversationId: string,
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (
      event.button !== 0 ||
      window.matchMedia(
        `(max-width: ${MOBILE_PANEL_RESIZE_BREAKPOINT_PX}px)`,
      ).matches
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    panelResizeStateRef.current = {
      conversationId,
      originWidth: chatPanelWidth,
      startClientX: event.clientX,
    };
    setIsResizingChatPanel(true);
    setResizingChatPanelConversationId(conversationId);
    document.body.style.setProperty("cursor", "col-resize");
    document.body.style.setProperty("user-select", "none");
  }

  function handleChatPanelResizeKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    const bounds = getChatPanelWidthBounds();

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      handleSetChatPanelWidth(chatPanelWidth - CHAT_PANEL_KEYBOARD_STEP_PX);
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      handleSetChatPanelWidth(chatPanelWidth + CHAT_PANEL_KEYBOARD_STEP_PX);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      handleSetChatPanelWidth(bounds.min);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      handleSetChatPanelWidth(bounds.max);
    }
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

    setState((current) => {
      const conversation = current.conversations[conversationId];

      if (!conversation) {
        return current;
      }

      return {
        ...current,
        conversations: {
          ...current.conversations,
          [conversationId]: {
            ...conversation,
            messages: [...conversation.messages, assistantMessage],
            updatedAt: assistantMessage.createdAt,
          },
        },
      };
    });

  }

  function appendAssistantDelta(
    conversationId: string,
    messageId: string,
    contentDelta: string,
    createdAt: string,
  ) {
    if (!contentDelta) {
      return;
    }

    setState((current) => {
      const conversation = current.conversations[conversationId];

      if (!conversation) {
        return current;
      }

      const messageIndex = conversation.messages.findIndex(
        (message) => message.id === messageId,
      );
      const messages = [...conversation.messages];

      if (messageIndex >= 0) {
        messages[messageIndex] = {
          ...messages[messageIndex],
          content: `${messages[messageIndex].content}${contentDelta}`,
        };
      } else {
        messages.push({
          id: messageId,
          role: "assistant",
          content: contentDelta,
          createdAt,
        });
      }

      return {
        ...current,
        conversations: {
          ...current.conversations,
          [conversationId]: {
            ...conversation,
            messages,
            updatedAt: createdAt,
          },
        },
      };
    });
  }

  function createAssistantStreamWriter(
    conversationId: string,
    messageId: string,
    createdAt: string,
  ) {
    let bufferedDelta = "";
    let flushTimerId = 0;

    const flush = () => {
      if (flushTimerId) {
        window.clearTimeout(flushTimerId);
        flushTimerId = 0;
      }

      if (!bufferedDelta) {
        return;
      }

      const delta = bufferedDelta;
      bufferedDelta = "";
      appendAssistantDelta(conversationId, messageId, delta, createdAt);
    };

    return {
      discard() {
        if (flushTimerId) {
          window.clearTimeout(flushTimerId);
          flushTimerId = 0;
        }

        bufferedDelta = "";
      },
      flush,
      write(delta: string) {
        bufferedDelta += delta;

        if (!flushTimerId) {
          flushTimerId = window.setTimeout(
            flush,
            ASSISTANT_STREAM_FLUSH_INTERVAL_MS,
          );
        }
      },
    };
  }

  function stopChatStream(conversationId: string) {
    const stream = activeChatStreamsRef.current.get(conversationId);

    if (!stream) {
      return;
    }

    stream.flush();
    activeChatStreamsRef.current.delete(conversationId);
    stream.controller.abort();
    setPendingConversationIds((current) => {
      if (!current[conversationId]) {
        return current;
      }

      const next = { ...current };
      delete next[conversationId];
      return next;
    });
  }

  function abortChatStreams(conversationIds: Iterable<string>) {
    for (const conversationId of conversationIds) {
      const stream = activeChatStreamsRef.current.get(conversationId);

      if (!stream) {
        continue;
      }

      activeChatStreamsRef.current.delete(conversationId);
      stream.discard();
      stream.controller.abort();
    }
  }

  function abortAllChatStreams() {
    abortChatStreams([...activeChatStreamsRef.current.keys()]);
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

  function startAssistantStream(
    conversation: Conversation,
    messages: Message[],
  ) {
    const conversationId = conversation.id;

    if (activeChatStreamsRef.current.has(conversationId)) {
      return false;
    }

    const assistantMessageId = createId("message");
    const requestId = createId("request");
    const controller = new AbortController();
    const assistantStream = createAssistantStreamWriter(
      conversationId,
      assistantMessageId,
      new Date().toISOString(),
    );
    const activeStream: ActiveChatStream = {
      assistantMessageId,
      controller,
      discard: assistantStream.discard,
      flush: assistantStream.flush,
      requestId,
    };

    activeChatStreamsRef.current.set(conversationId, activeStream);
    setPendingConversationIds((current) => ({
      ...current,
      [conversationId]: true,
    }));

    void requestChatReply({
      conversation: getConversationRequestPayload(state.conversations, conversation),
      messages,
      modelId: conversation.modelId,
      onDelta(delta) {
        const currentStream = activeChatStreamsRef.current.get(conversationId);

        if (
          currentStream?.requestId === requestId &&
          currentStream.assistantMessageId === assistantMessageId
        ) {
          assistantStream.write(delta);
        }
      },
      serviceId: conversation.serviceId,
      signal: controller.signal,
    })
      .then(() => {
        if (
          activeChatStreamsRef.current.get(conversationId)?.requestId ===
          requestId
        ) {
          assistantStream.flush();
        } else {
          assistantStream.discard();
        }
      })
      .catch((error) => {
        if (
          activeChatStreamsRef.current.get(conversationId)?.requestId !==
          requestId
        ) {
          assistantStream.discard();
          return;
        }

        assistantStream.flush();

        if (isAbortError(error)) {
          return;
        }

        if (isApiErrorStatus(error, 401)) {
          onAuthExpired();
          return;
        }

        if (isApiErrorStatus(error, 402)) {
          onBillingRequired(getErrorText(
            error,
            "An active paid plan is required before you can chat with the models.",
          ));
          return;
        }

        appendAssistantMessage(
          conversationId,
          buildBackendErrorReply(conversation.serviceId, error),
        );
      })
      .finally(() => {
        const currentStream = activeChatStreamsRef.current.get(conversationId);

        if (currentStream?.requestId !== requestId) {
          return;
        }

        activeChatStreamsRef.current.delete(conversationId);

        if (!workspaceMountedRef.current) {
          return;
        }

        setPendingConversationIds((current) => {
          if (!current[conversationId]) {
            return current;
          }

          const next = { ...current };
          delete next[conversationId];
          return next;
        });
      });

    return true;
  }

  function handleSubmit(conversationId: string, value: string) {
    const trimmed = value.trim();

    if (
      !trimmed ||
      pendingConversationIds[conversationId] ||
      activeChatStreamsRef.current.has(conversationId)
    ) {
      return;
    }

    const conversation = state.conversations[conversationId];

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

    setDrafts((current) => ({
      ...current,
      [conversationId]: "",
    }));

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
        });
    }

    startAssistantStream(
      {
        ...conversation,
        title: nextConversationTitle,
      },
      [...conversation.messages, userMessage],
    );
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

    try {
      for (const file of selectedFiles) {
        const document = await requestUploadDocument(file);

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
        [conversationId]: { error: null, uploading: false },
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
    }
  }

  async function handleDeleteDocument(documentId: string) {
    try {
      await requestDeleteDocument(documentId);
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
    const rootConversationId =
      getConversationRootId(state.conversations, parentConversation.id) ??
      parentConversation.id;
    const branchGraphLayout = buildBranchGraphNodeLayout({
      conversations: state.conversations,
      graphLayouts: normalizeGraphLayouts(
        state.conversations,
        state.graphLayouts,
      ),
      parentConversationId: parentConversation.id,
    });

    setState((current) => {
      const currentParent = current.conversations[draft.conversationId];

      if (!currentParent) {
        return current;
      }

      const sourceNote = draft.sourceNoteId
        ? (currentParent.notes ?? []).find(
            (note) =>
              note.id === draft.sourceNoteId && note.kind === "standalone",
          )
        : null;
      const parentMessages = sourceNote
        ? upsertStandaloneNoteContextMessage(
            currentParent.messages,
            sourceNote,
            now,
          )
        : currentParent.messages;

      return {
        ...current,
        activeConversationId: branchId,
        railOpen: false,
        rootId: rootConversationId,
        conversations: {
          ...current.conversations,
          [currentParent.id]: {
            ...currentParent,
            childIds: [...currentParent.childIds, branchId],
            messages: parentMessages,
            updatedAt: now,
          },
          [branchId]: branchConversation,
        },
        graphLayouts: {
          ...current.graphLayouts,
          [branchId]: branchGraphLayout,
        },
        groups: (() => {
          const parentGroupId = getConversationGroupId(
            current.groups,
            currentParent.id,
          );

          return parentGroupId
            ? assignConversationToGroup(current.groups, branchId, parentGroupId)
            : current.groups;
        })(),
      };
    });

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
            messages: sourceNote
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
    setDrafts((current) => ({
      ...current,
      [conversationId]: `${current[conversationId]?.trim() ? `${current[conversationId].trim()}\n\n` : ""}[From my margin note]\n${content}`,
    }));
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
    const nextGraphLayout = buildRootGraphNodeLayout(
      state.conversations,
      normalizeGraphLayouts(state.conversations, state.graphLayouts),
    );

    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
    setSearchModalOpen(false);
    setSearchQuery("");

    if (mainViewMode === "tiles") {
      setMainViewMode("chat");
    }

    startTransition(() => {
      setState((current) => ({
        ...current,
        activeConversationId: conversationId,
        rootId: conversationId,
        conversations: {
          ...current.conversations,
          [conversationId]: mainConversation,
        },
        graphLayouts: {
          ...current.graphLayouts,
          [conversationId]: nextGraphLayout,
        },
      }));
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
    const nextGraphLayout = buildRootGraphNodeLayout(
      state.conversations,
      normalizeGraphLayouts(state.conversations, state.graphLayouts),
    );

    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
    setSearchModalOpen(false);
    setSearchQuery("");
    setMainViewMode("chat");

    startTransition(() => {
      setState((current) => ({
        ...current,
        activeConversationId: conversationId,
        rootId: conversationId,
        conversations: {
          ...current.conversations,
          [conversationId]: noteConversation,
        },
        graphLayouts: {
          ...current.graphLayouts,
          [conversationId]: nextGraphLayout,
        },
      }));
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
        const parentConversation =
          current.conversations[sideConversation.parentId!];

        if (!parentConversation) {
          return current;
        }

        const sideGraphLayout = buildBranchGraphNodeLayout({
          conversations: current.conversations,
          graphLayouts: normalizeGraphLayouts(
            current.conversations,
            current.graphLayouts,
          ),
          parentConversationId: parentConversation.id,
        });

        return {
          ...current,
          activeConversationId: sideConversation.id,
          railOpen: false,
          rootId:
            getConversationRootId(
              current.conversations,
              parentConversation.id,
            ) ?? current.rootId,
          conversations: {
            ...current.conversations,
            [parentConversation.id]: {
              ...parentConversation,
              childIds: [...parentConversation.childIds, sideConversation.id],
              updatedAt: now,
            },
            [sideConversation.id]: sideConversation,
          },
          graphLayouts: {
            ...current.graphLayouts,
            [sideConversation.id]: sideGraphLayout,
          },
          groups: (() => {
            const sourceGroupId = getConversationGroupId(
              current.groups,
              sourceConversation.id,
            );

            return sourceGroupId
              ? assignConversationToGroup(
                  current.groups,
                  sideConversation.id,
                  sourceGroupId,
                )
              : current.groups;
          })(),
        };
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
      const childGraphLayout = buildBranchGraphNodeLayout({
        conversations: current.conversations,
        graphLayouts: normalizeGraphLayouts(
          current.conversations,
          current.graphLayouts,
        ),
        parentConversationId,
      });

      return {
        ...current,
        conversations: {
          ...current.conversations,
          [parentConversationId]: {
            ...parentConversation,
            childIds: [
              ...parentConversation.childIds,
              childConversationId,
            ],
            updatedAt: now,
          },
          [childConversationId]: childConversation,
        },
        graphLayouts: {
          ...current.graphLayouts,
          [childConversationId]: childGraphLayout,
        },
        groups: (() => {
          const parentGroupId = getConversationGroupId(
            current.groups,
            parentConversationId,
          );

          return parentGroupId
            ? assignConversationToGroup(
                current.groups,
                childConversationId,
                parentGroupId,
              )
            : current.groups;
        })(),
      };
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
    setSearchQuery("");
  }

  function handleSelectSearchResult(conversationId: string) {
    handleCloseSearch();
    handleSelectConversation(conversationId);
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

  function handleSelectSidebarConversation(conversationId: string) {
    if (mainViewMode === "graph") {
      setGraphFocusRequest((current) => ({
        conversationId,
        requestId: (current?.requestId ?? 0) + 1,
      }));
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

    setActiveOutlineItemId((current) =>
      current === outlineItemId ? current : outlineItemId,
    );
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

      return groups === current.groups ? current : { ...current, groups };
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
        conversation.parentId !== null ||
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
    const replacementConversation = deleteAllThreads
      ? createMainConversation({
          createdAt: new Date().toISOString(),
          id: createId("conversation"),
          modelId: state.defaultModelId,
          serviceId: state.defaultServiceId,
        })
      : null;

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

      if (replacementConversation && next[replacementConversation.id] !== "") {
        next[replacementConversation.id] = "";
        changed = true;
      }

      return changed ? next : current;
    });

    setPendingConversationIds((current) => {
      let changed = false;
      const next = { ...current };

      for (const deletedConversationId of deletedConversationIds) {
        if (!Object.hasOwn(next, deletedConversationId)) {
          continue;
        }

        delete next[deletedConversationId];
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
      setState((current) => {
        if (!current.conversations[conversationId]) {
          return current;
        }

        const nextConversations = Object.fromEntries(
          Object.entries(current.conversations).filter(
            ([currentConversationId]) =>
              !deletedConversationIdSet.has(currentConversationId),
          ),
        ) as Record<string, Conversation>;

        if (replacementConversation) {
          nextConversations[replacementConversation.id] = replacementConversation;
        }

        const nextGraphLayouts = Object.fromEntries(
          Object.entries(current.graphLayouts).filter(
            ([currentConversationId]) =>
              !deletedConversationIdSet.has(currentConversationId),
          ),
        ) as Record<string, GraphNodeLayout>;

        if (replacementConversation) {
          nextGraphLayouts[replacementConversation.id] = buildRootGraphNodeLayout(
            nextConversations,
            nextGraphLayouts,
          );
        }

        const fallbackRootId =
          buildThreadSummaries(nextConversations)[0]?.id ??
          replacementConversation?.id ??
          null;

        if (!fallbackRootId) {
          return current;
        }

        const nextActiveConversationId = deletedConversationIdSet.has(
          current.activeConversationId,
        )
          ? fallbackRootId
          : current.activeConversationId;
        const nextRootId = deletedConversationIdSet.has(current.rootId)
          ? fallbackRootId
          : current.rootId;

        return {
          ...current,
          activeConversationId: nextActiveConversationId,
          pinnedThreadIds: current.pinnedThreadIds.filter(
            (threadId) => !deletedConversationIdSet.has(threadId),
          ),
          rootId: nextRootId,
          conversations: nextConversations,
          graphLayouts: nextGraphLayouts,
          groups: removeConversationsFromGroups(
            current.groups,
            deletedConversationIdSet,
          ),
        };
      });
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
    "--chat-panel-width": `${chatPanelWidth}px`,
  } as CSSProperties;
  const chatPanelWidthBounds = getChatPanelWidthBounds();

  function renderConversationChatPanel(conversation: Conversation) {
    if (conversation.kind === "note") {
      return (
        <StandaloneNotePanel
          conversation={conversation}
          isActive={conversation.id === activeConversation.id}
          onActivate={() => handleSelectConversation(conversation.id)}
          onRename={handleRenameThread}
          onUpdate={handleUpdateStandaloneNote}
          registerPanelRef={(conversationId, element) => {
            panelRefs.current[conversationId] = element;
          }}
        />
      );
    }

    return (
      <ChatPanel
        anchorsByMessageId={getAnchorsByMessageId(
          state.conversations,
          conversation.id,
        )}
        conversation={conversation}
        draft={drafts[conversation.id] ?? ""}
        initialScrollTop={panelScrollPositionsRef.current[conversation.id]}
        isActive={conversation.id === activeConversation.id}
        isSubmitting={Boolean(pendingConversationIds[conversation.id])}
        key={conversation.id}
        onActivate={() => handleSelectConversation(conversation.id)}
        onAddSideChat={
          conversation.id === activeConversation.id
            ? handleAddSideChat
            : undefined
        }
        onCreateNote={handleCreateNote}
        onDeleteNote={handleDeleteNote}
        onDeleteDocument={handleDeleteDocument}
        onDraftChange={(value) => handleDraftChange(conversation.id, value)}
        onModelChange={handleModelChange}
        onOpenBranch={handleSelectConversation}
        onScrollPositionChange={(conversationId, scrollTop) => {
          panelScrollPositionsRef.current[conversationId] = scrollTop;
        }}
        onStopStreaming={stopChatStream}
        onStopTypewriter={handleStopTypewriter}
        onSubmit={handleSubmit}
        onUploadDocuments={handleUploadDocuments}
        onTypewriterComplete={handleTypewriterComplete}
        onTypewriterProgress={handleTypewriterProgress}
        onUpdateNote={handleUpdateNote}
        onUseNote={handleUseNote}
        onVisibleOutlineChange={
          conversation.id === activeConversation.id
            ? handleVisibleOutlineChange
            : undefined
        }
        recentModelSelections={recentModelSelections}
        documentUploadState={
          documentUploadByConversationId[conversation.id] ?? {
            error: null,
            uploading: false,
          }
        }
        registerAnchorRef={(branchConversationId, element) => {
          anchorRefs.current[branchConversationId] = element;
        }}
        registerBranchOriginRef={(conversationId, element) => {
          branchOriginRefs.current[conversationId] = element;
        }}
        registerComposerSurfaceRef={(conversationId, element) => {
          composerSurfaceRefs.current[conversationId] = element;
        }}
        registerPanelRef={(conversationId, element) => {
          panelRefs.current[conversationId] = element;
        }}
        selectionPreview={
          selectionDraft?.conversationId === conversation.id
            ? selectionDraft
            : null
        }
        showBranchMargin={false}
        theme={theme}
        typingMessageIds={typingMessageIds}
        typingProgressByMessageId={typingProgressByMessageIdRef.current}
      />
    );
  }

  function renderExpandedTreeConversation(
    conversation: Conversation,
    allowMinimize: boolean,
  ) {
    const isResizing =
      conversation.id === resizingChatPanelConversationId &&
      isResizingChatPanel;
    const contextLabel =
      conversation.id === activeConversation.id
        ? "Current chat"
        : conversation.parentId === null
          ? "Main chat"
          : "Ancestor chat";

    return (
      <div
        className={
          isResizing
            ? "conversation-tree-expanded panel-slot is-resizable is-split-context is-resizing"
            : "conversation-tree-expanded panel-slot is-resizable is-split-context"
        }
        data-expanded-conversation-id={conversation.id}
        key={conversation.id}
      >
        {contextLabel !== "Current chat" || (allowMinimize && conversation.parentId) ? (
          <div className="panel-context-header">
            {contextLabel !== "Current chat" ? (
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
              </button>
            ) : null}
          </div>
        ) : null}
        {renderConversationChatPanel(conversation)}
        <div
          aria-label="Resize chat panel width"
          aria-orientation="vertical"
          aria-valuemax={chatPanelWidthBounds.max}
          aria-valuemin={chatPanelWidthBounds.min}
          aria-valuenow={Math.round(chatPanelWidth)}
          aria-valuetext={`${Math.round(chatPanelWidth)} pixels wide`}
          className="panel-resize-handle"
          onDoubleClick={handleResetChatPanelWidth}
          onKeyDown={handleChatPanelResizeKeyDown}
          onPointerDown={(event) =>
            handleChatPanelResizePointerDown(conversation.id, event)
          }
          role="separator"
          tabIndex={0}
        >
          <span className="panel-resize-handle-grip" />
        </div>
      </div>
    );
  }

  function renderChatTreeNavigation() {
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
        {activeConversation.kind !== "note" ? (
          <span className="panel-context-label workspace-current-chat-label">Current chat</span>
        ) : null}
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
    <div className="app-shell">
      <div className="app-chrome">
        {billingNotice ? (
          <div
            className={`billing-return-notice is-${billingNotice.kind}`}
            role={billingNotice.kind === "error" ? "alert" : "status"}
          >
            <span>{billingNotice.message}</span>
            <button onClick={onDismissBillingNotice} type="button">
              Dismiss
            </button>
          </div>
        ) : null}
        {(vault.message || vault.conflicts.length > 0) ? <div className="billing-return-notice is-info" role="status">
          <span>{vault.conflicts.length ? `${vault.conflicts.length} conflicting ${vault.conflicts.length === 1 ? "edit is" : "edits are"} preserved for review.` : vault.message}</span>
          <button type="button" onClick={() => { setProfileInitialTab("storage"); setProfileModalOpen(true); }}>Vault settings</button>
        </div> : null}
        <div className="workspace-shell">
          <header className="workspace-session-bar">
            <div className="workspace-session-brand">
              <button
                aria-label={leftSidebarOpen ? "Close chat sidebar" : "Open chat sidebar"}
                aria-pressed={leftSidebarOpen}
                className="workspace-menu-button"
                onClick={handleToggleLeftSidebar}
                type="button"
              >
                <MenuIcon />
              </button>
              <h1>Margin Chat</h1>
            </div>

            {!isTileView && !isGraphView
              ? renderChatTreeNavigation()
              : null}

            <div className="workspace-session-actions">
              {!isTileView && !isGraphView ? (
                <ConversationGroupSelect
                  className="is-chat-header"
                  conversationId={activeConversation.id}
                  groups={state.groups}
                  onAssign={handleAssignConversationGroup}
                />
              ) : null}
              {!isMobileViewport &&
              !isTileView &&
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
                  <span>Map</span>
                  <strong>{branchNavigationCount}</strong>
                </button>
              ) : null}
            </div>
          </header>

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
            <ThreadSidebar
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
              onSelectThread={handleSelectSidebarConversation}
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

            <section
              className={
                isTileView
                  ? "canvas-section is-thread-tile-view"
                  : isGraphView
                    ? "canvas-section is-graph-view"
                    : "canvas-section"
              }
            >
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
                <ConversationGraphView
                  activeConversationId={activeConversation.id}
                  conversations={state.conversations}
                  focusRequest={graphFocusRequest}
                  graphLayouts={state.graphLayouts}
                  groups={state.groups}
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
                  renderDockedConversation={(conversationId) => {
                    const conversation = state.conversations[conversationId];

                    return conversation
                      ? renderConversationChatPanel(conversation)
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
                    isResizingChatPanel
                      ? "conversation-canvas is-tree-browser is-resizing-panel"
                      : "conversation-canvas is-tree-browser"
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
              onSelectConversation={(conversationId) =>
                handleSelectConversation(conversationId, {
                  preserveRail: !isMobileViewport,
                })
              }
              open={state.railOpen}
              registerTabRef={(conversationId, element) => {
                tabRefs.current[conversationId] = element;
              }}
              rootId={activeRootConversation.id}
            />
          ) : null}

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
                      : "New branch"}
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
                    : "Start branch"}
                </button>
              </div>
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
            isOpen={searchModalOpen}
            onClose={handleCloseSearch}
            onQueryChange={setSearchQuery}
            onSelectResult={handleSelectSearchResult}
            query={searchQuery}
            results={searchResults}
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

          <ProfileModal
            initialTab={profileInitialTab}
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
  );
}

export default function App() {
  const hasPasswordResetToken = new URLSearchParams(window.location.search).has(
    "reset_token",
  );
  const [theme, setTheme] = useState<ThemeMode>(INITIAL_THEME);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");
  const [authUser, setAuthUser] = useState<AuthenticatedUser | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [billingSubmitting, setBillingSubmitting] = useState(false);
  const [billingNotice, setBillingNotice] = useState<{
    kind: "error" | "info" | "success";
    message: string;
  } | null>(null);

  useEffect(() => {
    syncTheme(theme);

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      return;
    }
  }, [theme]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateAuthSession() {
      if (hasPasswordResetToken) {
        setAuthUser(null);
        setAuthStatus("unauthenticated");
        setAuthError(null);
        return;
      }

      try {
        if (!navigator.onLine) throw new Error("You are offline. Opening the files saved on this device.");
        let user = await requestAuthSession();
        const checkoutParams = new URLSearchParams(window.location.search);
        const checkoutResult = checkoutParams.get("checkout");
        const checkoutSessionId = checkoutParams.get("session_id");

        if (user && checkoutResult === "subscription_success") {
          try {
            if (!checkoutSessionId) {
              throw new Error("Stripe returned without a Checkout Session ID.");
            }

            const confirmation = await requestConfirmCheckoutSession(
              checkoutSessionId,
            );
            user = await requestAuthSession();
            setBillingNotice(
              confirmation.confirmed
                ? {
                    kind: "success",
                    message: "Your Margin Chat subscription is active.",
                  }
                : {
                    kind: "error",
                    message: `Stripe completed Checkout, but the subscription is ${confirmation.status}. Manage billing to finish activation.`,
                  },
            );
          } catch (error) {
            setBillingNotice({
              kind: "error",
              message: getErrorText(
                error,
                "Your payment completed, but Margin Chat could not confirm the subscription yet. Refresh shortly or manage billing.",
              ),
            });
          }
        } else if (checkoutResult === "subscription_canceled") {
          setBillingNotice({
            kind: "info",
            message: "Stripe Checkout was canceled. You were not charged.",
          });
        }

        if (
          checkoutResult === "subscription_success" ||
          checkoutResult === "subscription_canceled"
        ) {
          const cleanUrl = new URL(window.location.href);
          cleanUrl.searchParams.delete("checkout");
          cleanUrl.searchParams.delete("session_id");
          window.history.replaceState(
            {},
            "",
            `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`,
          );
        }

        if (cancelled) {
          return;
        }

        if (user) rememberOfflineUser(user); else forgetOfflineUser();
        setAuthUser(user);
        setAuthStatus(user ? "authenticated" : "unauthenticated");
        setAuthError(null);
      } catch (error) {
        if (cancelled) {
          return;
        }

        const offlineUser = loadOfflineUser();
        setAuthUser(offlineUser);
        setAuthStatus(offlineUser ? "authenticated" : "unauthenticated");
        setAuthError(offlineUser ? null : getErrorText(error, "Unable to verify your session."));
      }
    }

    void hydrateAuthSession();

    return () => {
      cancelled = true;
    };
  }, [hasPasswordResetToken]);

  function handleAuthExpired(
    message = "Your session expired. Sign in again to continue.",
  ) {
    forgetOfflineUser();
    setAuthUser(null);
    setAuthStatus("unauthenticated");
    setAuthSubmitting(false);
    setAuthError(message);
    setBillingError(null);
    setBillingNotice(null);
  }

  async function handleBillingRequired(
    message = "An active paid plan is required before this account can use the hosted models.",
  ) {
    try {
      const user = await requestAuthSession();

      setAuthUser(user);
      setAuthStatus(user ? "authenticated" : "unauthenticated");
      setAuthError(null);
      setBillingError(message);
    } catch {
      handleAuthExpired(message);
    }
  }

  async function handleLogin(args: { email: string; password: string }) {
    setAuthSubmitting(true);
    setAuthError(null);
    setBillingError(null);

    try {
      const user = await requestLogin(args);
      rememberOfflineUser(user);
      setAuthUser(user);
      setAuthStatus("authenticated");
    } catch (error) {
      setAuthError(getErrorText(error, "Login failed."));
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleSignup(args: {
    displayName: string;
    email: string;
    password: string;
  }) {
    setAuthSubmitting(true);
    setAuthError(null);
    setBillingError(null);

    try {
      const user = await requestSignup(args);
      rememberOfflineUser(user);
      setAuthUser(user);
      setAuthStatus("authenticated");
    } catch (error) {
      setAuthError(getErrorText(error, "Signup failed."));
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleRequestPasswordReset(args: { email: string }) {
    setAuthSubmitting(true);
    setAuthError(null);

    try {
      return await requestPasswordReset(args);
    } catch (error) {
      setAuthError(getErrorText(error, "Unable to request a password reset."));
      return null;
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleResetPassword(args: { password: string; token: string }) {
    setAuthSubmitting(true);
    setAuthError(null);

    try {
      await requestPasswordResetConfirm(args);
      return true;
    } catch (error) {
      setAuthError(getErrorText(error, "Unable to reset the password."));
      return false;
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleLogout() {
    forgetOfflineUser();
    try {
      await requestLogout();
    } catch (error) {
      console.warn("Unable to clear the server session.", error);
    } finally {
      setAuthUser(null);
      setAuthStatus("unauthenticated");
      setAuthError(null);
      setAuthSubmitting(false);
      setBillingError(null);
      setBillingSubmitting(false);
      setBillingNotice(null);
    }
  }

  async function handleUpdateProfile(args: {
    displayName: string;
    email: string;
  }) {
    const user = await requestUpdateProfile(args);
    rememberOfflineUser(user);
    setAuthUser(user);
    setAuthStatus("authenticated");
    return user;
  }

  async function handleUpdateApiKeys(args: {
    keys: Partial<Record<ApiKeyProvider, string | null>>;
  }) {
    const apiKeys = await requestUpdateApiKeys(args);
    setAuthUser((current) => (current ? { ...current, apiKeys } : current));
    return apiKeys;
  }

  async function redirectToStripe(
    callback: () => Promise<string>,
    fallbackMessage: string,
  ) {
    setBillingSubmitting(true);
    setBillingError(null);

    try {
      const url = await callback();
      window.location.assign(url);
    } catch (error) {
      setBillingError(getErrorText(error, fallbackMessage));
    } finally {
      setBillingSubmitting(false);
    }
  }

  async function handleStartSubscription() {
    await redirectToStripe(
      requestCreateCheckoutSession,
      "Unable to start the Stripe checkout flow.",
    );
  }

  async function handleManageBilling() {
    await redirectToStripe(
      requestCreateBillingPortalSession,
      "Unable to open the Stripe billing portal.",
    );
  }

  if (authStatus === "checking") {
    return (
      <div className="app-shell">
        <div className="app-chrome auth-chrome">
          <div className="auth-loading-card">
            <p className="eyebrow">Margin Chat</p>
            <h1>Checking your session...</h1>
            <p className="auth-copy">
              We&apos;re loading your workspace and verifying whether there&apos;s
              an active sign-in cookie.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (authStatus !== "authenticated" || !authUser) {
    return (
      <div className="app-shell">
        <div className="app-chrome auth-chrome">
          <AuthLanding
            errorMessage={authError}
            isSubmitting={authSubmitting}
            onLogin={handleLogin}
            onRequestPasswordReset={handleRequestPasswordReset}
            onResetPassword={handleResetPassword}
            onSignup={handleSignup}
            onToggleTheme={() => setTheme((current) => getNextTheme(current))}
            theme={theme}
          />
        </div>
      </div>
    );
  }

  return (
    <WorkspaceApp
      billingNotice={billingNotice}
      billingErrorMessage={billingError}
      billingSubmitting={billingSubmitting}
      key={authUser.id}
      onAuthExpired={handleAuthExpired}
      onDismissBillingNotice={() => setBillingNotice(null)}
      onBillingRequired={handleBillingRequired}
      onLogout={() => {
        void handleLogout();
      }}
      onManageBilling={handleManageBilling}
      onStartSubscription={handleStartSubscription}
      onSetTheme={setTheme}
      onUpdateProfile={handleUpdateProfile}
      onUpdateApiKeys={handleUpdateApiKeys}
      theme={theme}
      user={authUser}
    />
  );
}
