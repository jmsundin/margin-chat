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
  useRef,
  useState,
  type CSSProperties,
} from "react";
import AppSettingsModal from "./components/AppSettingsModal";
import AuthLanding from "./components/AuthLanding";
import BillingGate from "./components/BillingGate";
import BranchRail from "./components/BranchRail";
import ChatPanel from "./components/ChatPanel";
import ConnectorOverlay from "./components/ConnectorOverlay";
import ConversationTreeNode from "./components/ConversationTreeNode";
import ConversationGraphView from "./components/ConversationGraphView";
import MainChatTileView from "./components/MainChatTileView";
import PinnedThreadTabs from "./components/PinnedThreadTabs";
import ProfileModal from "./components/ProfileModal";
import SearchModal, { type ChatSearchResult } from "./components/SearchModal";
import ThreadSidebar from "./components/ThreadSidebar";
import {
  ApiError,
  requestCreateBillingPortalSession,
  requestCreateCheckoutSession,
  persistStoredState,
  requestAuthSession,
  requestChatReply,
  requestChatTitle,
  requestLogin,
  requestLogout,
  requestPasswordReset,
  requestPasswordResetConfirm,
  requestSignup,
  requestStoredState,
  requestUpdateProfile,
} from "./lib/api";
import {
  sanitizePinnedThreadIds,
  upsertPinnedThreadIdAtIndex,
} from "./lib/pinnedThreads";
import {
  DEFAULT_BACKEND_SERVICE_ID,
  getBackendServiceLabel,
  getDefaultModelIdForService,
  isBackendServiceId,
  resolveBackendServiceModelId,
  sanitizeRecentBackendServiceSelections,
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
  excerpt,
  getBranchNavigation,
  getConversationPath,
  getConversationRootId,
  getConversationTreeLanes,
  getConversationTraversalOrder,
  getRootConversations,
} from "./lib/tree";
import { buildChatOutline } from "./lib/chatOutline";
import { categorizeThread, getThreadCategoryLabel } from "./lib/threadCategories";
import {
  DEFAULT_MAIN_CHAT_TITLE,
  createEmptyState,
  createMainConversation,
} from "./initialState";
import type {
  AppState,
  AuthenticatedUser,
  BackendServiceId,
  ConnectionLine,
  ConnectorOcclusionRect,
  Conversation,
  GraphNodeLayout,
  MainViewMode,
  Message,
  MessageAnchorLink,
  SelectionDraft,
  ThreadSummary,
} from "./types";

const STORAGE_KEY = "margin-chat-state";
const RECENT_MODEL_SELECTIONS_STORAGE_KEY = "margin-chat-recent-model-selections";
const THEME_STORAGE_KEY = "margin-chat-theme";
const PINNED_TABS_LAYOUT_STORAGE_KEY = "margin-chat-pinned-tabs-layout";
const LEFT_SIDEBAR_STORAGE_KEY = "margin-chat-left-sidebar-open";
const CHAT_PANEL_WIDTH_STORAGE_KEY = "margin-chat-panel-width";
const BRANCH_PROMPT_PLACEHOLDER = "Ask about the selected text...";
const EXPLAIN_SELECTION_PROMPT = "Explain the selected text.";
const TOOLTIP_VIEWPORT_MARGIN = 16;
const CHAT_PANEL_DEFAULT_WIDTH_PX = 630;
const CHAT_PANEL_KEYBOARD_STEP_PX = 24;
const CHAT_PANEL_MAX_WIDTH_PX = 980;
const CHAT_PANEL_MIN_WIDTH_PX = 320;
const CHAT_PANEL_VIEWPORT_MARGIN_PX = 180;
const CHAT_SCROLL_SELECTION_DELAY_MS = 140;
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
  height: 208,
  width: 360,
};
const CONNECTOR_CONTENT_GUTTER_PX = 8;
type ThemeMode = "light" | "dark";
type AuthStatus = "checking" | "authenticated" | "unauthenticated";
type StorageMode = "loading" | "fallback" | "server";
type MainThreadDragMode =
  | "idle"
  | "pinning-main-thread"
  | "reordering-pinned-tab";
type PinnedTabsLayoutMode = "strip" | "tray";
type ChatTraversalDirection = "left" | "right";

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

function resolvePersistedDefaultSelection(args: {
  activeConversationId?: string;
  conversations: Record<string, Conversation>;
  defaultModelId?: unknown;
  defaultServiceId?: unknown;
  rootId?: string;
}): Pick<AppState, "defaultModelId" | "defaultServiceId"> {
  const fallbackConversation =
    (typeof args.activeConversationId === "string"
      ? args.conversations[args.activeConversationId]
      : null) ??
    (typeof args.rootId === "string" ? args.conversations[args.rootId] : null) ??
    getRootConversations(args.conversations)[0] ??
    Object.values(args.conversations)[0] ??
    null;
  const defaultServiceId = isBackendServiceId(args.defaultServiceId)
    ? args.defaultServiceId
    : fallbackConversation?.serviceId ?? DEFAULT_BACKEND_SERVICE_ID;
  const fallbackModelId =
    fallbackConversation?.serviceId === defaultServiceId
      ? fallbackConversation.modelId
      : getDefaultModelIdForService(defaultServiceId);
  const requestedModelId =
    typeof args.defaultModelId === "string" && args.defaultModelId.trim()
      ? args.defaultModelId
      : fallbackModelId;

  return {
    defaultModelId: resolveBackendServiceModelId(
      defaultServiceId,
      requestedModelId,
    ),
    defaultServiceId,
  };
}

function hydratePersistedState(input: unknown): AppState | null {
  try {
    if (!input || typeof input !== "object" || !("conversations" in input)) {
      return null;
    }

    const parsed = input as Partial<AppState> & {
      conversations: Record<string, Conversation>;
    };

    if (
      !parsed.conversations ||
      typeof parsed.conversations !== "object" ||
      Array.isArray(parsed.conversations)
    ) {
      return null;
    }

    const conversations = deriveChildIds(
      Object.fromEntries(
        Object.entries(parsed.conversations).map(
          ([conversationId, conversation]) => [
            conversationId,
            (() => {
              const serviceId = isBackendServiceId(conversation.serviceId)
                ? conversation.serviceId
                : DEFAULT_BACKEND_SERVICE_ID;

              return {
                ...conversation,
                modelId: resolveBackendServiceModelId(
                  serviceId,
                  conversation.modelId,
                ),
                serviceId,
              };
            })(),
          ],
        ),
      ),
    );
    const rootConversations = getRootConversations(conversations);

    if (!rootConversations.length) {
      return null;
    }

    const nextActiveConversationId =
      parsed.activeConversationId &&
      conversations[parsed.activeConversationId]
        ? parsed.activeConversationId
        : rootConversations[0].id;
    const nextRootId =
      getConversationRootId(conversations, nextActiveConversationId) ??
      rootConversations[0].id;
    const { defaultModelId, defaultServiceId } =
      resolvePersistedDefaultSelection({
        activeConversationId: nextActiveConversationId,
        conversations,
        defaultModelId: parsed.defaultModelId,
        defaultServiceId: parsed.defaultServiceId,
        rootId: nextRootId,
      });

    return {
      activeConversationId: nextActiveConversationId,
      conversations,
      defaultModelId,
      defaultServiceId,
      graphLayouts: normalizeGraphLayouts(
        conversations,
        parsed.graphLayouts,
      ),
      pinnedThreadIds: sanitizePinnedThreadIds(
        parsed.pinnedThreadIds,
        conversations,
      ),
      railOpen: false,
      rootId: nextRootId,
    };
  } catch {
    return null;
  }
}

function getStateStorageKey(userId: string) {
  return `${STORAGE_KEY}:${userId}`;
}

function getRecentModelSelectionsStorageKey(userId: string) {
  return `${RECENT_MODEL_SELECTIONS_STORAGE_KEY}:${userId}`;
}

function loadStoredState(storageKey: string): AppState {
  const fallback = createEmptyState();

  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const storedValue = window.localStorage.getItem(storageKey);

    if (!storedValue) {
      return fallback;
    }

    return hydratePersistedState(JSON.parse(storedValue)) ?? fallback;
  } catch {
    return fallback;
  }
}

function loadRecentModelSelections(
  storageKey: string,
): RecentBackendServiceSelection[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const storedValue = window.localStorage.getItem(storageKey);

    if (!storedValue) {
      return [];
    }

    return sanitizeRecentBackendServiceSelections(JSON.parse(storedValue));
  } catch {
    return [];
  }
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

function loadInitialPinnedTabsLayoutMode(): PinnedTabsLayoutMode {
  if (typeof window === "undefined") {
    return "tray";
  }

  try {
    const storedValue = window.localStorage.getItem(
      PINNED_TABS_LAYOUT_STORAGE_KEY,
    );

    if (storedValue === "strip" || storedValue === "tray") {
      return storedValue;
    }
  } catch {
    return "tray";
  }

  return "tray";
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
    const storedValue = Number(
      window.localStorage.getItem(CHAT_PANEL_WIDTH_STORAGE_KEY),
    );

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

function getErrorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

const INITIAL_THEME = loadInitialTheme();
const INITIAL_PINNED_TABS_LAYOUT_MODE = loadInitialPinnedTabsLayoutMode();
const INITIAL_LEFT_SIDEBAR_OPEN = loadInitialLeftSidebarOpen();
const INITIAL_CHAT_PANEL_WIDTH = loadInitialChatPanelWidth();

if (typeof document !== "undefined") {
  syncTheme(INITIAL_THEME);
}

interface WorkspaceAppProps {
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
  theme: ThemeMode;
  user: AuthenticatedUser;
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function areThreadIdListsEqual(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((threadId, index) => threadId === right[index])
  );
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
      leftLayout.height === rightLayout.height
    );
  });
}

function mergeGraphLayouts(
  currentLayouts: Record<string, GraphNodeLayout>,
  nextLayouts: Record<string, GraphNodeLayout>,
) {
  let didChange = false;
  const mergedLayouts = { ...currentLayouts };

  for (const [conversationId, nextLayout] of Object.entries(nextLayouts)) {
    const currentLayout =
      currentLayouts[conversationId] ?? createDefaultGraphNodeLayout();
    const normalizedLayout = createDefaultGraphNodeLayout({
      ...currentLayout,
      ...nextLayout,
    });

    if (
      currentLayout.x === normalizedLayout.x &&
      currentLayout.y === normalizedLayout.y &&
      currentLayout.width === normalizedLayout.width &&
      currentLayout.height === normalizedLayout.height
    ) {
      continue;
    }

    mergedLayouts[conversationId] = normalizedLayout;
    didChange = true;
  }

  return didChange ? mergedLayouts : null;
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

function hasAnotherAnchorOnSameLine(args: {
  anchorRefs: Record<string, HTMLSpanElement | null>;
  conversations: Record<string, Conversation>;
  conversationId: string;
}): boolean {
  const conversation = args.conversations[args.conversationId];

  if (!conversation?.branchAnchor || !conversation.parentId) {
    return false;
  }

  const parentConversation = args.conversations[conversation.parentId];
  const currentAnchorRect = getLineRect(args.anchorRefs[conversation.id]);

  if (!parentConversation || !currentAnchorRect) {
    return false;
  }

  const currentCenterY =
    currentAnchorRect.top + currentAnchorRect.height / 2;

  let sameLineCount = 0;

  for (const childConversationId of parentConversation.childIds) {
    const siblingConversation = args.conversations[childConversationId];

    if (
      !siblingConversation?.branchAnchor ||
      siblingConversation.branchAnchor.sourceMessageId !==
        conversation.branchAnchor.sourceMessageId
    ) {
      continue;
    }

    const siblingAnchorRect = getLineRect(args.anchorRefs[childConversationId]);

    if (!siblingAnchorRect) {
      continue;
    }

    const siblingCenterY =
      siblingAnchorRect.top + siblingAnchorRect.height / 2;
    const tolerance = Math.max(
      4,
      Math.min(currentAnchorRect.height, siblingAnchorRect.height) * 0.4,
    );

    if (Math.abs(siblingCenterY - currentCenterY) <= tolerance) {
      sameLineCount += 1;
    }

    if (sameLineCount > 1) {
      return true;
    }
  }

  return false;
}

function getMessageBubbleElement(node: Node | null): HTMLDivElement | null {
  if (!node) {
    return null;
  }

  if (node instanceof HTMLDivElement) {
    return node.closest("[data-message-bubble='true']");
  }

  if (node instanceof HTMLElement) {
    return node.closest("[data-message-bubble='true']");
  }

  return node.parentElement?.closest("[data-message-bubble='true']") ?? null;
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

function deriveChildIds(
  conversations: Record<string, Conversation>,
): Record<string, Conversation> {
  const nextConversations = Object.fromEntries(
    Object.values(conversations).map((conversation) => [
      conversation.id,
      {
        ...conversation,
        childIds: [],
      },
    ]),
  ) as Record<string, Conversation>;

  for (const conversation of Object.values(nextConversations)) {
    if (conversation.parentId && nextConversations[conversation.parentId]) {
      nextConversations[conversation.parentId].childIds.push(conversation.id);
    }
  }

  for (const conversation of Object.values(nextConversations)) {
    conversation.childIds.sort((left, right) =>
      nextConversations[left].createdAt.localeCompare(
        nextConversations[right].createdAt,
      ),
    );
  }

  return nextConversations;
}

function getThreadConversations(
  conversations: Record<string, Conversation>,
  rootConversationId: string,
) {
  return Object.values(conversations)
    .filter(
      (conversation) =>
        getConversationRootId(conversations, conversation.id) === rootConversationId,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function collectConversationTreeIds(
  conversations: Record<string, Conversation>,
  rootConversationId: string,
) {
  const visited = new Set<string>();
  const stack = [rootConversationId];

  while (stack.length) {
    const conversationId = stack.pop();

    if (!conversationId || visited.has(conversationId) || !conversations[conversationId]) {
      continue;
    }

    visited.add(conversationId);

    for (const childConversationId of conversations[conversationId].childIds) {
      stack.push(childConversationId);
    }
  }

  return Array.from(visited);
}

function getThreadPreviewFromConversations(threadConversations: Conversation[]) {
  for (const conversation of threadConversations) {
    const latestMessage = conversation.messages[conversation.messages.length - 1];

    if (latestMessage?.content.trim()) {
      return excerpt(latestMessage.content, 92);
    }
  }

  return "No messages yet.";
}

function getThreadCategoryContext(threadConversations: Conversation[]) {
  const snippets: string[] = [];
  let remainingCharacters = 2200;

  for (const conversation of threadConversations) {
    if (remainingCharacters <= 0) {
      break;
    }

    const titleSnippet = conversation.title.replace(/\s+/g, " ").trim();

    if (titleSnippet) {
      const nextSnippet = titleSnippet.slice(0, remainingCharacters);
      snippets.push(nextSnippet);
      remainingCharacters -= nextSnippet.length + 1;
    }

    for (const message of conversation.messages.slice(-3).reverse()) {
      if (remainingCharacters <= 0) {
        break;
      }

      const contentSnippet = message.content.replace(/\s+/g, " ").trim();

      if (!contentSnippet) {
        continue;
      }

      const nextSnippet = `${message.role} ${contentSnippet}`.slice(
        0,
        remainingCharacters,
      );
      snippets.push(nextSnippet);
      remainingCharacters -= nextSnippet.length + 1;
    }
  }

  return snippets.join(" ");
}

function getThreadPreview(
  conversations: Record<string, Conversation>,
  rootConversationId: string,
) {
  const rootConversation = conversations[rootConversationId];

  if (!rootConversation) {
    return "No messages yet.";
  }

  return getThreadPreviewFromConversations([rootConversation]);
}

function formatRelativeTime(value: string) {
  const elapsedMs = Date.now() - new Date(value).getTime();
  const elapsedMinutes = Math.max(0, Math.round(elapsedMs / 60000));

  if (elapsedMinutes < 1) {
    return "just now";
  }

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.round(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.round(elapsedHours / 24);

  if (elapsedDays < 7) {
    return `${elapsedDays}d ago`;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function getMatchPreview(content: string, query: string) {
  const normalizedContent = content.replace(/\s+/g, " ").trim();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedContent) {
    return "";
  }

  const matchIndex = normalizedContent.toLowerCase().indexOf(normalizedQuery);

  if (matchIndex === -1) {
    return excerpt(normalizedContent, 108);
  }

  const startIndex = Math.max(0, matchIndex - 42);
  const endIndex = Math.min(
    normalizedContent.length,
    matchIndex + normalizedQuery.length + 52,
  );
  const prefix = startIndex > 0 ? "..." : "";
  const suffix = endIndex < normalizedContent.length ? "..." : "";

  return `${prefix}${normalizedContent.slice(startIndex, endIndex)}${suffix}`;
}

function buildThreadSummaries(
  conversations: Record<string, Conversation>,
): ThreadSummary[] {
  return getRootConversations(conversations)
    .map((rootConversation) => {
      const threadConversations = getThreadConversations(
        conversations,
        rootConversation.id,
      );
      const latestConversation = threadConversations[0] ?? rootConversation;
      const preview = getThreadPreviewFromConversations(threadConversations);
      const categoryId = categorizeThread({
        context: getThreadCategoryContext(threadConversations),
        preview,
        title: rootConversation.title,
      });

      return {
        categoryId,
        categoryLabel: getThreadCategoryLabel(categoryId),
        conversationCount: threadConversations.length,
        id: rootConversation.id,
        preview,
        title: rootConversation.title,
        updatedAt: latestConversation.updatedAt,
        updatedLabel: formatRelativeTime(latestConversation.updatedAt),
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function buildSearchResults(
  conversations: Record<string, Conversation>,
  query: string,
): ChatSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return buildThreadSummaries(conversations).map((thread) => ({
      conversationId: thread.id,
      locationLabel: thread.title,
      matchLabel: "Recent chat",
      preview: thread.preview,
      rootTitle: thread.title,
      title: thread.title,
      updatedLabel: thread.updatedLabel,
    }));
  }

  return Object.values(conversations)
    .map((conversation) => {
      const rootId = getConversationRootId(conversations, conversation.id);

      if (!rootId) {
        return null;
      }

      const rootConversation = conversations[rootId];

      if (!rootConversation) {
        return null;
      }

      const lowerTitle = conversation.title.toLowerCase();

      if (lowerTitle.includes(normalizedQuery)) {
        return {
          conversationId: conversation.id,
          locationLabel:
            conversation.parentId === null ? "Main chat" : "Branch conversation",
          matchLabel:
            conversation.parentId === null ? "Thread title" : "Branch title",
          preview: conversation.parentId
            ? `Inside "${rootConversation.title}"`
            : getThreadPreview(conversations, rootConversation.id),
          rootTitle: rootConversation.title,
          title: conversation.title,
          updatedAt: conversation.updatedAt,
          updatedLabel: formatRelativeTime(conversation.updatedAt),
        };
      }

      const matchingMessage = conversation.messages.find((message) =>
        message.content.toLowerCase().includes(normalizedQuery),
      );

      if (!matchingMessage) {
        return null;
      }

      return {
        conversationId: conversation.id,
        locationLabel:
          conversation.parentId === null ? "Main chat" : "Branch conversation",
        matchLabel: `${matchingMessage.role} message`,
        preview: getMatchPreview(matchingMessage.content, normalizedQuery),
        rootTitle: rootConversation.title,
        title: conversation.title,
        updatedAt: matchingMessage.createdAt,
        updatedLabel: formatRelativeTime(matchingMessage.createdAt),
      };
    })
    .filter(
      (
        result,
      ): result is ChatSearchResult & {
        updatedAt: string;
      } => Boolean(result),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 40)
    .map(({ updatedAt: _updatedAt, ...result }) => result);
}

function WorkspaceApp({
  onAuthExpired,
  onBillingRequired,
  billingErrorMessage,
  billingSubmitting,
  onLogout,
  onManageBilling,
  onStartSubscription,
  onSetTheme,
  onUpdateProfile,
  theme,
  user,
}: WorkspaceAppProps) {
  const stateStorageKey = getStateStorageKey(user.id);
  const recentModelSelectionsStorageKey = getRecentModelSelectionsStorageKey(
    user.id,
  );
  const [state, setState] = useState<AppState>(() => loadStoredState(stateStorageKey));
  const [recentModelSelections, setRecentModelSelections] = useState<
    RecentBackendServiceSelection[]
  >(() => loadRecentModelSelections(recentModelSelectionsStorageKey));
  const [storageMode, setStorageMode] = useState<StorageMode>("loading");
  const [mainViewMode, setMainViewMode] = useState<MainViewMode>("chat");
  const [leftSidebarOpen, setLeftSidebarOpen] =
    useState(INITIAL_LEFT_SIDEBAR_OPEN);
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    getIsMobileViewport(),
  );
  const [chatPanelWidth, setChatPanelWidth] = useState(INITIAL_CHAT_PANEL_WIDTH);
  const [isResizingChatPanel, setIsResizingChatPanel] = useState(false);
  const [resizingChatPanelConversationId, setResizingChatPanelConversationId] =
    useState<string | null>(null);
  const [pinnedTabsLayoutMode, setPinnedTabsLayoutMode] =
    useState<PinnedTabsLayoutMode>(INITIAL_PINNED_TABS_LAYOUT_MODE);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingConversationIds, setPendingConversationIds] = useState<
    Record<string, boolean>
  >({});
  const [typingMessageIds, setTypingMessageIds] = useState<Record<string, boolean>>(
    {},
  );
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(
    null,
  );
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
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
  const [mainThreadDragMode, setMainThreadDragMode] =
    useState<MainThreadDragMode>("idle");
  const canvasRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLFormElement>(null);
  const panelRefs = useRef<Record<string, HTMLElement | null>>({});
  const anchorRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const branchOriginRefs = useRef<Record<string, HTMLElement | null>>({});
  const composerSurfaceRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const treeNodeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const panelScrollPositionsRef = useRef<Record<string, number>>({});
  const chatScrollSelectionTimerRef = useRef(0);
  const suppressNextChatAutoCenterRef = useRef(false);
  const pendingTreeLaneFocusRef = useRef<string | null>(null);
  const typingProgressByMessageIdRef = useRef<Record<string, number>>({});
  const pendingPersistStateRef = useRef<AppState | null>(null);
  const persistenceInFlightRef = useRef(false);
  const selectionSyncFrameRef = useRef(0);
  const panelResizeStateRef = useRef<{
    conversationId: string;
    originWidth: number;
    startClientX: number;
  } | null>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery);

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
  const visibleConversationStrip = getConversationTraversalOrder(
    state.conversations,
    activeRootConversation.id,
  );
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
  const threadSummaries = buildThreadSummaries(state.conversations);
  const threadSummaryById = new Map(
    threadSummaries.map((thread) => [thread.id, thread] as const),
  );
  const pinnedThreadSummaries = state.pinnedThreadIds
    .map((threadId) => threadSummaryById.get(threadId))
    .filter((thread): thread is ThreadSummary => Boolean(thread));
  const effectivePinnedTabsLayoutMode = isMobileViewport
    ? "strip"
    : pinnedTabsLayoutMode;
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
  const searchResults = buildSearchResults(
    state.conversations,
    deferredSearchQuery,
  );

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
    window.localStorage.setItem(stateStorageKey, JSON.stringify(state));
  }, [state, stateStorageKey]);

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
    let cancelled = false;

    async function hydrateState() {
      try {
        const persistedState = await requestStoredState();

        if (cancelled) {
          return;
        }

        if (persistedState) {
          const hydratedState = hydratePersistedState(persistedState);

          if (hydratedState) {
            setState(hydratedState);
          }
        }

        setStorageMode("server");
      } catch (error) {
        if (isApiErrorStatus(error, 401)) {
          onAuthExpired();
          return;
        }

        console.warn("Falling back to local state storage.", error);

        if (!cancelled) {
          setStorageMode("fallback");
        }
      }
    }

    void hydrateState();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PINNED_TABS_LAYOUT_STORAGE_KEY,
        pinnedTabsLayoutMode,
      );
    } catch {
      return;
    }
  }, [pinnedTabsLayoutMode]);

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

  const persistLatestState = useEffectEvent(async () => {
    if (persistenceInFlightRef.current) {
      return;
    }

    persistenceInFlightRef.current = true;

    try {
      while (pendingPersistStateRef.current) {
        const nextState = pendingPersistStateRef.current;
        pendingPersistStateRef.current = null;

        try {
          await persistStoredState(nextState);
        } catch (error) {
          pendingPersistStateRef.current = null;

          if (isApiErrorStatus(error, 401)) {
            onAuthExpired();
            return;
          }

          console.warn("Unable to persist app state to Postgres.", error);
          setStorageMode("fallback");
          return;
        }
      }
    } finally {
      persistenceInFlightRef.current = false;
    }
  });

  useEffect(() => {
    if (storageMode !== "server") {
      pendingPersistStateRef.current = null;
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      pendingPersistStateRef.current = state;
      void persistLatestState();
    }, 240);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [persistLatestState, state, storageMode]);

  useEffect(() => {
    if (mainThreadDragMode === "idle") {
      return undefined;
    }

    function resetDragMode() {
      setMainThreadDragMode("idle");
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        resetDragMode();
      }
    }

    document.addEventListener("dragend", resetDragMode);
    document.addEventListener("drop", resetDragMode);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("dragend", resetDragMode);
      document.removeEventListener("drop", resetDragMode);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [mainThreadDragMode]);

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

  const selectClosestChatColumn = useEffectEvent(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const canvasRect = canvas.getBoundingClientRect();
    const canvasCenterX = canvasRect.left + canvasRect.width / 2;
    const closestConversationId = visibleConversationStrip.reduce(
      (closest, conversation) => {
        const panel = panelRefs.current[conversation.id];

        if (!panel) {
          return closest;
        }

        const rect = panel.getBoundingClientRect();
        const distance = Math.abs(rect.left + rect.width / 2 - canvasCenterX);

        return distance < closest.distance
          ? { distance, id: conversation.id }
          : closest;
      },
      { distance: Number.POSITIVE_INFINITY, id: state.activeConversationId },
    ).id;

    if (closestConversationId === state.activeConversationId) {
      return;
    }

    suppressNextChatAutoCenterRef.current = true;
    handleSelectConversation(closestConversationId);
  });

  function handleChatStripScroll() {
    window.clearTimeout(chatScrollSelectionTimerRef.current);
    chatScrollSelectionTimerRef.current = window.setTimeout(() => {
      selectClosestChatColumn();
    }, CHAT_SCROLL_SELECTION_DELAY_MS);
  }

  const handleConversationCanvasWheel = useEffectEvent((event: WheelEvent) => {
    const canvas = canvasRef.current;

    if (!canvas || event.ctrlKey || event.defaultPrevented) {
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
    const horizontalDelta =
      Math.abs(deltaX) > Math.abs(deltaY) * 0.8
        ? deltaX
        : event.shiftKey
          ? deltaY
          : 0;

    if (Math.abs(horizontalDelta) < 0.5) {
      return;
    }

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

    event.preventDefault();
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

    canvas.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      canvas.removeEventListener("wheel", handleWheel);
    };
  }, [handleConversationCanvasWheel, mainViewMode]);

  useEffect(() => {
    return () => {
      window.clearTimeout(chatScrollSelectionTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!selectionDraft) {
      return undefined;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement;

      if (toolbarRef.current?.contains(target)) {
        return;
      }

      if (target.closest("[data-message-bubble='true']")) {
        return;
      }

      setSelectionDraft(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectionDraft(null);
        window.getSelection()?.removeAllRanges();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectionDraft]);

  useLayoutEffect(() => {
    if (!selectionDraft || !toolbarRef.current) {
      return;
    }

    const nextSize = {
      width: toolbarRef.current.offsetWidth,
      height: toolbarRef.current.offsetHeight,
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
    let frameId = 0;

    const flush = () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
        frameId = 0;
      }

      if (!bufferedDelta) {
        return;
      }

      const delta = bufferedDelta;
      bufferedDelta = "";
      appendAssistantDelta(conversationId, messageId, delta, createdAt);
    };

    return {
      flush,
      write(delta: string) {
        bufferedDelta += delta;

        if (!frameId) {
          frameId = window.requestAnimationFrame(flush);
        }
      },
    };
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

  function getConversationRequestPayload(conversation: Conversation) {
    const contextPath = conversation.parentId
      ? [
          ...getConversationPath(state.conversations, conversation.parentId),
          conversation,
        ]
      : [conversation];
    const ancestorContext = contextPath.slice(0, -1).map((ancestor, index) => {
      const descendant = contextPath[index + 1];
      const sourceMessageId =
        descendant?.branchAnchor?.sourceConversationId === ancestor.id
          ? descendant.branchAnchor.sourceMessageId
          : null;
      const sourceMessageIndex = sourceMessageId
        ? ancestor.messages.findIndex((message) => message.id === sourceMessageId)
        : -1;

      return {
        branchAnchor: ancestor.branchAnchor,
        id: ancestor.id,
        messages:
          sourceMessageIndex >= 0
            ? ancestor.messages.slice(0, sourceMessageIndex + 1)
            : ancestor.messages,
        title: ancestor.title,
      };
    });

    return {
      ancestorContext,
      branchAnchor: conversation.branchAnchor,
      id: conversation.id,
      parentId: conversation.parentId,
      title: conversation.title,
    };
  }

  async function handleSubmit(conversationId: string, value: string) {
    const trimmed = value.trim();

    if (!trimmed || pendingConversationIds[conversationId]) {
      return;
    }

    const conversation = state.conversations[conversationId];

    if (!conversation) {
      return;
    }

    const nextConversationTitle =
      conversation.parentId === null && conversation.messages.length === 0
      && conversation.title === DEFAULT_MAIN_CHAT_TITLE
        ? excerpt(trimmed, 34)
        : conversation.title;
    const shouldGenerateTitle =
      conversation.parentId === null &&
      conversation.messages.length === 0 &&
      conversation.title === DEFAULT_MAIN_CHAT_TITLE;
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

    setPendingConversationIds((current) => ({
      ...current,
      [conversationId]: true,
    }));

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

    const assistantMessageId = createId("message");
    const assistantStream = createAssistantStreamWriter(
      conversationId,
      assistantMessageId,
      new Date().toISOString(),
    );

    try {
      await requestChatReply({
        conversation: getConversationRequestPayload({
          ...conversation,
          title: nextConversationTitle,
        }),
        messages: [...conversation.messages, userMessage],
        modelId: conversation.modelId,
        onDelta: assistantStream.write,
        serviceId: conversation.serviceId,
      });
      assistantStream.flush();
    } catch (error) {
      assistantStream.flush();

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
    } finally {
      setPendingConversationIds((current) => ({
        ...current,
        [conversationId]: false,
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
    const startBubble = getMessageBubbleElement(range.startContainer);
    const endBubble = getMessageBubbleElement(range.endContainer);

    if (!startBubble || !endBubble || startBubble !== endBubble) {
      setSelectionDraft(null);
      return;
    }

    const conversationId = startBubble.dataset.conversationId;
    const messageId = startBubble.dataset.messageId;

    if (!conversationId || !messageId) {
      setSelectionDraft(null);
      return;
    }

    const conversation = state.conversations[conversationId];
    const message = conversation?.messages.find(
      (candidate) => candidate.id === messageId,
    );

    if (!conversation || !message) {
      setSelectionDraft(null);
      return;
    }

    const quote = selection.toString().trim();

    if (!quote) {
      return;
    }

    const startRange = range.cloneRange();
    startRange.selectNodeContents(startBubble);
    startRange.setEnd(range.startContainer, range.startOffset);

    const endRange = range.cloneRange();
    endRange.selectNodeContents(startBubble);
    endRange.setEnd(range.endContainer, range.endOffset);

    const rect = range.getBoundingClientRect();

    setSelectionDraft({
      conversationId,
      messageId: message.id,
      quote,
      startOffset: startRange.toString().length,
      endOffset: endRange.toString().length,
      prompt: "",
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
    });

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

  function handleUpdateGraphNodeLayout(
    conversationId: string,
    nextLayout: Partial<GraphNodeLayout>,
  ) {
    setState((current) => {
      if (!current.conversations[conversationId]) {
        return current;
      }

      const currentLayout =
        current.graphLayouts[conversationId] ?? createDefaultGraphNodeLayout();
      const mergedLayout = createDefaultGraphNodeLayout({
        ...currentLayout,
        ...nextLayout,
      });

      if (
        currentLayout.x === mergedLayout.x &&
        currentLayout.y === mergedLayout.y &&
        currentLayout.width === mergedLayout.width &&
        currentLayout.height === mergedLayout.height
      ) {
        return current;
      }

      return {
        ...current,
        graphLayouts: {
          ...current.graphLayouts,
          [conversationId]: mergedLayout,
        },
      };
    });
  }

  function handleApplyGraphLayouts(nextLayouts: Record<string, GraphNodeLayout>) {
    setState((current) => {
      const scopedLayouts = Object.fromEntries(
        Object.entries(nextLayouts).filter(([conversationId]) =>
          Boolean(current.conversations[conversationId]),
        ),
      );
      const mergedLayouts = mergeGraphLayouts(
        current.graphLayouts,
        scopedLayouts,
      );

      if (!mergedLayouts) {
        return current;
      }

      return {
        ...current,
        graphLayouts: mergedLayouts,
      };
    });
  }

  async function handleCreateBranch(promptOverride?: string) {
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
      createdAt: now,
      updatedAt: now,
      messages: [userMessage],
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
            updatedAt: now,
          },
          [branchId]: branchConversation,
        },
        graphLayouts: {
          ...current.graphLayouts,
          [branchId]: branchGraphLayout,
        },
      };
    });

    setDrafts((current) => ({
      ...current,
      [branchId]: "",
    }));
    setPendingConversationIds((current) => ({
      ...current,
      [branchId]: true,
    }));
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();

    const assistantMessageId = createId("message");
    const assistantStream = createAssistantStreamWriter(
      branchId,
      assistantMessageId,
      new Date().toISOString(),
    );

    try {
      await requestChatReply({
        conversation: getConversationRequestPayload(branchConversation),
        messages: branchConversation.messages,
        modelId: branchConversation.modelId,
        onDelta: assistantStream.write,
        serviceId: branchConversation.serviceId,
      });
      assistantStream.flush();
    } catch (error) {
      assistantStream.flush();

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
        branchId,
        buildBackendErrorReply(branchConversation.serviceId, error),
      );
    } finally {
      setPendingConversationIds((current) => ({
        ...current,
        [branchId]: false,
      }));
    }
  }

  function handleExplainSelection() {
    handleCreateBranch(EXPLAIN_SELECTION_PROMPT);
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
    setMainViewMode(options.nextViewMode ?? (mainViewMode === "tiles" ? "chat" : mainViewMode));

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

  function navigateChatInDirection(direction: ChatTraversalDirection) {
    const activeIndex = visibleConversationStrip.findIndex(
      (conversation) => conversation.id === activeConversation.id,
    );
    const targetIndex = activeIndex + (direction === "right" ? 1 : -1);
    const targetConversation = visibleConversationStrip[targetIndex];

    if (!targetConversation) {
      return;
    }

    handleSelectConversation(targetConversation.id);
  }

  function handleChatTraversalKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) {
      return;
    }

    event.preventDefault();
    navigateChatInDirection(event.key === "ArrowLeft" ? "left" : "right");
  }

  function handlePinThread(conversationId: string, index: number | null) {
    setState((current) => {
      const conversation = current.conversations[conversationId];

      if (!conversation || conversation.parentId !== null) {
        return current;
      }

      const targetIndex =
        index === null ? current.pinnedThreadIds.length : index;
      const nextPinnedThreadIds = upsertPinnedThreadIdAtIndex(
        current.pinnedThreadIds,
        conversationId,
        targetIndex,
      );

      if (areThreadIdListsEqual(current.pinnedThreadIds, nextPinnedThreadIds)) {
        return current;
      }

      return {
        ...current,
        pinnedThreadIds: nextPinnedThreadIds,
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

  const toolbarCenterX =
    selectionDraft && typeof window !== "undefined"
      ? clamp(
          selectionDraft.rect.left + selectionDraft.rect.width / 2,
          toolbarSize.width / 2 + TOOLTIP_VIEWPORT_MARGIN,
          window.innerWidth - toolbarSize.width / 2 - TOOLTIP_VIEWPORT_MARGIN,
        )
      : 0;
  const toolbarTop =
    selectionDraft && typeof window !== "undefined"
      ? clamp(
          selectionDraft.rect.top - 18,
          toolbarSize.height + TOOLTIP_VIEWPORT_MARGIN,
          window.innerHeight - TOOLTIP_VIEWPORT_MARGIN,
        )
      : 0;
  const toolbarStyle = {
    left: `${toolbarCenterX}px`,
    top: `${toolbarTop}px`,
  } as CSSProperties;
  const conversationCanvasStyle = {
    "--chat-panel-width": `${chatPanelWidth}px`,
  } as CSSProperties;
  const chatPanelWidthBounds = getChatPanelWidthBounds();
  const activeTraversalIndex = visibleConversationStrip.findIndex(
    (conversation) => conversation.id === activeConversation.id,
  );
  const previousTraversalConversation =
    visibleConversationStrip[activeTraversalIndex - 1] ?? null;
  const nextTraversalConversation =
    visibleConversationStrip[activeTraversalIndex + 1] ?? null;

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
        <span className="panel-context-label">{contextLabel}</span>
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
          onActivate={() => handleSelectConversation(conversation.id)}
          onDraftChange={(value) => handleDraftChange(conversation.id, value)}
          onModelChange={handleModelChange}
          onOpenBranch={handleSelectConversation}
          onScrollPositionChange={(conversationId, scrollTop) => {
            panelScrollPositionsRef.current[conversationId] = scrollTop;
          }}
          onStopTypewriter={handleStopTypewriter}
          onSubmit={handleSubmit}
          onTypewriterComplete={handleTypewriterComplete}
          onTypewriterProgress={handleTypewriterProgress}
          onVisibleOutlineChange={
            conversation.id === activeConversation.id
              ? handleVisibleOutlineChange
              : undefined
          }
          recentModelSelections={recentModelSelections}
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

  return (
    <div className="app-shell">
      <div className="app-chrome">
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

            <div className="workspace-session-pins">
              <PinnedThreadTabs
                activeThreadId={activeRootConversation.id}
                layoutMode={effectivePinnedTabsLayoutMode}
                onLayoutModeChange={setPinnedTabsLayoutMode}
                onOpenThread={handleSelectConversation}
                onPinThread={handlePinThread}
                onReorderDragEnd={() => setMainThreadDragMode("idle")}
                onReorderDragStart={() =>
                  setMainThreadDragMode("reordering-pinned-tab")
                }
                onUnpinThread={handleUnpinThread}
                pinnedThreads={pinnedThreadSummaries}
                showHint={mainThreadDragMode === "pinning-main-thread"}
              />
            </div>

            <div className="workspace-session-actions">
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
              mainViewMode={mainViewMode}
              onDeleteThread={handleDeleteThread}
              onMainThreadDragEnd={() => setMainThreadDragMode("idle")}
              onMainThreadDragStart={() =>
                setMainThreadDragMode("pinning-main-thread")
              }
              onNewChat={handleCreateMainConversation}
              onOpenProfile={() => {
                setProfileSaveError(null);
                setProfileModalOpen(true);
              }}
              onOpenSettings={() => setAppSettingsOpen(true)}
              onOpenSearch={handleOpenSearch}
              onRenameThread={handleRenameThread}
              onSelectOutlineItem={handleSelectOutlineItem}
              onSetMainViewMode={handleSetMainViewMode}
              onSelectThread={handleSelectConversation}
              onToggleCollapse={handleToggleLeftSidebar}
              onToggleTheme={() =>
                onSetTheme((current) => getNextTheme(current))
              }
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
                  onMainThreadDragEnd={() => setMainThreadDragMode("idle")}
                  onMainThreadDragStart={() =>
                    setMainThreadDragMode("pinning-main-thread")
                  }
                  onOpenThread={handleSelectConversation}
                  threads={threadSummaries}
                />
              ) : isGraphView ? (
                <ConversationGraphView
                  activeConversationId={activeConversation.id}
                  conversations={state.conversations}
                  drafts={drafts}
                  getAnchorsByMessageId={(conversationId) =>
                    getAnchorsByMessageId(state.conversations, conversationId)
                  }
                  graphLayouts={state.graphLayouts}
                  pendingConversationIds={pendingConversationIds}
                  recentModelSelections={recentModelSelections}
                  selectionPreview={selectionDraft}
                  theme={theme}
                  threads={threadSummaries}
                  typingMessageIds={typingMessageIds}
                  typingProgressByMessageId={typingProgressByMessageIdRef.current}
                  onApplyGraphLayouts={handleApplyGraphLayouts}
                  onActivateConversation={handleSelectConversation}
                  onDraftChange={handleDraftChange}
                  onModelChange={handleModelChange}
                  onStopTypewriter={handleStopTypewriter}
                  onSubmit={handleSubmit}
                  onTypewriterComplete={handleTypewriterComplete}
                  onTypewriterProgress={handleTypewriterProgress}
                  onUpdateGraphNodeLayout={handleUpdateGraphNodeLayout}
                />
              ) : (
                <div
                  className="chat-tree-workspace"
                  onKeyDown={handleChatTraversalKeyDown}
                >
                  <div className="chat-tree-navigation">
                    <nav
                      aria-label="Conversation hierarchy"
                      className="canvas-breadcrumb"
                    >
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
                            <span
                              aria-hidden="true"
                              className="breadcrumb-separator"
                            >
                              ›
                            </span>
                          ) : null}
                          <button
                            aria-current={
                              conversation.id === activeConversation.id
                                ? "page"
                                : undefined
                            }
                            className="breadcrumb-button"
                            onClick={() =>
                              handleSelectConversation(conversation.id)
                            }
                            type="button"
                          >
                            {conversation.title}
                          </button>
                        </span>
                      ))}
                    </nav>

                    <div
                      aria-label="Nearby chats"
                      className="chat-neighbor-controls"
                      role="group"
                    >
                      <button
                        aria-keyshortcuts="Alt+ArrowLeft"
                        className="chat-neighbor-button is-previous"
                        disabled={!previousTraversalConversation}
                        onClick={() => navigateChatInDirection("left")}
                        title="Previous nearby chat (Alt + Left Arrow)"
                        type="button"
                      >
                        <span aria-hidden="true">←</span>
                        <span>
                          {previousTraversalConversation?.title ?? "Start"}
                        </span>
                      </button>
                      <span className="chat-navigation-hint">
                        Two-finger scroll to explore
                      </span>
                      <button
                        aria-keyshortcuts="Alt+ArrowRight"
                        className="chat-neighbor-button is-next"
                        disabled={!nextTraversalConversation}
                        onClick={() => navigateChatInDirection("right")}
                        title="Next nearby chat (Alt + Right Arrow)"
                        type="button"
                      >
                        <span>
                          {nextTraversalConversation?.title ?? "End"}
                        </span>
                        <span aria-hidden="true">→</span>
                      </button>
                    </div>
                  </div>

                <div
                  className={
                    isResizingChatPanel
                      ? "conversation-canvas is-tree-browser is-resizing-panel"
                      : "conversation-canvas is-tree-browser"
                  }
                  onScroll={handleChatStripScroll}
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

                    return (
                      <section
                        aria-label={`Children of ${parentConversation.title}`}
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
                            {lane.conversationIds.length} child
                            {lane.conversationIds.length === 1 ? "" : "ren"}
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
                handleCreateBranch();
              }}
              ref={toolbarRef}
              style={toolbarStyle}
            >
              <div className="selection-tooltip-head">
                <p className="eyebrow">New branch</p>
                <button
                  aria-label="Cancel new branch"
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
              <div className="selection-input-row">
                <input
                  autoFocus={!isMobileViewport}
                  aria-label="Branch prompt"
                  id="branch-prompt"
                  onChange={(event) =>
                    setSelectionDraft((current) =>
                      current
                        ? { ...current, prompt: event.target.value }
                        : current,
                    )
                  }
                  placeholder={BRANCH_PROMPT_PLACEHOLDER}
                  type="text"
                  value={selectionDraft.prompt}
                />
                <button
                  aria-label="Create branch with prompt"
                  className="selection-send"
                  disabled={!selectionDraft.prompt.trim()}
                  type="submit"
                >
                  <SendIcon />
                </button>
              </div>
              <div className="selection-actions">
                <button
                  className="selection-explain"
                  onClick={handleExplainSelection}
                  type="button"
                >
                  Explain selection
                </button>
              </div>
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

          <ProfileModal
            billingErrorMessage={billingErrorMessage}
            billingSubmitting={billingSubmitting}
            errorMessage={profileSaveError}
            isOpen={profileModalOpen}
            isSaving={profileSaving}
            onClose={() => {
              if (profileSaving) {
                return;
              }

              setProfileSaveError(null);
              setProfileModalOpen(false);
            }}
            onManageBilling={onManageBilling}
            onLogout={onLogout}
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
        const user = await requestAuthSession();

        if (cancelled) {
          return;
        }

        setAuthUser(user);
        setAuthStatus(user ? "authenticated" : "unauthenticated");
        setAuthError(null);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setAuthUser(null);
        setAuthStatus("unauthenticated");
        setAuthError(getErrorText(error, "Unable to verify your session."));
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
    setAuthUser(null);
    setAuthStatus("unauthenticated");
    setAuthSubmitting(false);
    setAuthError(message);
    setBillingError(null);
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
    }
  }

  async function handleUpdateProfile(args: {
    displayName: string;
    email: string;
  }) {
    const user = await requestUpdateProfile(args);
    setAuthUser(user);
    setAuthStatus("authenticated");
    return user;
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

  if (!authUser.billing.hasAccess) {
    return (
      <div className="app-shell">
        <div className="app-chrome auth-chrome">
          <BillingGate
            errorMessage={billingError}
            isSubmitting={billingSubmitting}
            onLogout={() => {
              void handleLogout();
            }}
            onManageBilling={handleManageBilling}
            onStartSubscription={handleStartSubscription}
            onToggleTheme={() => setTheme((current) => getNextTheme(current))}
            theme={theme}
            user={authUser}
          />
        </div>
      </div>
    );
  }

  return (
    <WorkspaceApp
      billingErrorMessage={billingError}
      billingSubmitting={billingSubmitting}
      key={authUser.id}
      onAuthExpired={handleAuthExpired}
      onBillingRequired={handleBillingRequired}
      onLogout={() => {
        void handleLogout();
      }}
      onManageBilling={handleManageBilling}
      onStartSubscription={handleStartSubscription}
      onSetTheme={setTheme}
      onUpdateProfile={handleUpdateProfile}
      theme={theme}
      user={authUser}
    />
  );
}
