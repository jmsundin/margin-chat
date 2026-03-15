import {
  startTransition,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import BranchRail from "./components/BranchRail";
import ChatPanel from "./components/ChatPanel";
import ConnectorOverlay from "./components/ConnectorOverlay";
import MainChatTileView from "./components/MainChatTileView";
import PinnedThreadTabs from "./components/PinnedThreadTabs";
import SearchModal, { type ChatSearchResult } from "./components/SearchModal";
import ThreadSidebar from "./components/ThreadSidebar";
import { persistStoredState, requestChatReply, requestStoredState } from "./lib/api";
import {
  sanitizePinnedThreadIds,
  upsertPinnedThreadIdAtIndex,
} from "./lib/pinnedThreads";
import {
  DEFAULT_BACKEND_SERVICE_ID,
  getBackendServiceLabel,
  isBackendServiceId,
} from "./lib/services";
import {
  buildConversationTitle,
  excerpt,
  getConversationPath,
  getConversationRootId,
  getRootConversations,
} from "./lib/tree";
import { categorizeThread, getThreadCategoryLabel } from "./lib/threadCategories";
import {
  DEFAULT_MAIN_CHAT_TITLE,
  createEmptyState,
  createMainConversation,
} from "./initialState";
import type {
  AppState,
  BackendServiceId,
  ConnectionLine,
  Conversation,
  Message,
  MessageAnchorLink,
  SelectionDraft,
  ThreadSummary,
} from "./types";

const STORAGE_KEY = "margin-chat-state";
const THEME_STORAGE_KEY = "margin-chat-theme";
const BRANCH_PROMPT_PLACEHOLDER = "Ask about the selected text...";
const EXPLAIN_SELECTION_PROMPT = "Explain the selected text.";
const TOOLTIP_VIEWPORT_MARGIN = 16;
const FALLBACK_TOOLTIP_SIZE = {
  height: 208,
  width: 360,
};
const CONNECTOR_CONTENT_GUTTER_PX = 8;
type ThemeMode = "light" | "dark";
type StorageMode = "loading" | "fallback" | "server";
type MainViewMode = "chat" | "tiles";

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

function ThemeIcon({ theme }: { theme: ThemeMode }) {
  if (theme === "dark") {
    return (
      <svg
        aria-hidden="true"
        className="theme-toggle-glyph"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      >
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      className="theme-toggle-glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.5" />
      <path d="M12 19v2.5" />
      <path d="m4.9 4.9 1.8 1.8" />
      <path d="m17.3 17.3 1.8 1.8" />
      <path d="M2.5 12H5" />
      <path d="M19 12h2.5" />
      <path d="m4.9 19.1 1.8-1.8" />
      <path d="m17.3 6.7 1.8-1.8" />
    </svg>
  );
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
            {
              ...conversation,
              serviceId: isBackendServiceId(conversation.serviceId)
                ? conversation.serviceId
                : DEFAULT_BACKEND_SERVICE_ID,
            },
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

    return {
      activeConversationId: nextActiveConversationId,
      conversations,
      pinnedThreadIds: sanitizePinnedThreadIds(
        parsed.pinnedThreadIds,
        conversations,
      ),
      railOpen: Boolean(parsed.railOpen),
      rootId: nextRootId,
    };
  } catch {
    return null;
  }
}

function loadInitialState(): AppState {
  const fallback = createEmptyState();

  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const storedValue = window.localStorage.getItem(STORAGE_KEY);

    if (!storedValue) {
      return fallback;
    }

    return hydratePersistedState(JSON.parse(storedValue)) ?? fallback;
  } catch {
    return fallback;
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
    return "dark";
  }

  return "dark";
}

function syncTheme(theme: ThemeMode) {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.theme = theme;
}

const INITIAL_THEME = loadInitialTheme();

if (typeof document !== "undefined") {
  syncTheme(INITIAL_THEME);
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

  const clientRect = Array.from(element.getClientRects()).find(
    (rect) => rect.width > 0 && rect.height > 0,
  );

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

export default function App() {
  const [state, setState] = useState<AppState>(() => loadInitialState());
  const [theme, setTheme] = useState<ThemeMode>(INITIAL_THEME);
  const [storageMode, setStorageMode] = useState<StorageMode>("loading");
  const [mainViewMode, setMainViewMode] = useState<MainViewMode>("chat");
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
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [toolbarSize, setToolbarSize] = useState(FALLBACK_TOOLTIP_SIZE);
  const [connections, setConnections] = useState<ConnectionLine[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLFormElement>(null);
  const panelRefs = useRef<Record<string, HTMLElement | null>>({});
  const anchorRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const typingProgressByMessageIdRef = useRef<Record<string, number>>({});
  const selectionSyncFrameRef = useRef(0);
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const activeConversation =
    state.conversations[state.activeConversationId] ??
    state.conversations[state.rootId];
  const path = getConversationPath(state.conversations, activeConversation.id);
  const activeRootConversation = path[0] ?? activeConversation;
  const focusedBranches = activeConversation.childIds
    .map((conversationId) => state.conversations[conversationId])
    .filter((conversation): conversation is Conversation => Boolean(conversation))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const isMainView = activeConversation.parentId === null;
  const isTileView = mainViewMode === "tiles";
  const threadSummaries = buildThreadSummaries(state.conversations);
  const threadSummaryById = new Map(
    threadSummaries.map((thread) => [thread.id, thread] as const),
  );
  const pinnedThreadSummaries = state.pinnedThreadIds
    .map((threadId) => threadSummaryById.get(threadId))
    .filter((thread): thread is ThreadSummary => Boolean(thread));
  const searchResults = buildSearchResults(
    state.conversations,
    deferredSearchQuery,
  );

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

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
    syncTheme(theme);

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      return;
    }
  }, [theme]);

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
    if (storageMode !== "server") {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      void persistStoredState(state).catch((error) => {
        console.warn("Unable to persist app state to Postgres.", error);
        setStorageMode("fallback");
      });
    }, 240);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [state, storageMode]);

  useEffect(() => {
    if (mainViewMode !== "chat") {
      return;
    }

    const panel = panelRefs.current[state.activeConversationId];
    panel?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [mainViewMode, state.activeConversationId]);

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
    if (mainViewMode !== "chat") {
      setConnections([]);
      return;
    }

    let frame = 0;

    const requestUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const nextConnections: ConnectionLine[] = [];
        const focusedConversation =
          state.conversations[state.activeConversationId];

        if (!focusedConversation) {
          setConnections(nextConnections);
          return;
        }

        for (const conversation of getConversationPath(
          state.conversations,
          focusedConversation.id,
        ).slice(1)) {
          if (!conversation.parentId || !conversation.branchAnchor) {
            continue;
          }

          const parentPanel = panelRefs.current[conversation.parentId];
          const childPanel = panelRefs.current[conversation.id];
          const anchorElement = anchorRefs.current[conversation.id];
          const anchorRect = getLineRect(anchorElement);

          if (!parentPanel || !childPanel || !anchorRect) {
            continue;
          }

          const childPanelRect = childPanel.getBoundingClientRect();
          const sourceContentRect = getElementRect(
            getMessageBubbleElement(anchorElement),
          );
          const startY = anchorRect.top + anchorRect.height / 2;
          const useAnchorEdge = hasAnotherAnchorOnSameLine({
            anchorRefs: anchorRefs.current,
            conversations: state.conversations,
            conversationId: conversation.id,
          });
          const startX = useAnchorEdge
            ? anchorRect.right
            : Math.max(
                anchorRect.right,
                (sourceContentRect?.right ?? anchorRect.right) +
                  CONNECTOR_CONTENT_GUTTER_PX,
              );

          nextConnections.push({
            id: `path-${conversation.id}`,
            start: {
              x: startX,
              y: startY,
            },
            end: {
              x: childPanelRect.left,
              y: startY,
            },
            active: conversation.id === state.activeConversationId,
            variant: "straight",
          });
        }

        for (const childConversationId of focusedConversation.childIds) {
          const conversation = state.conversations[childConversationId];

          if (!conversation?.branchAnchor) {
            continue;
          }

          const anchorElement = anchorRefs.current[conversation.id];
          const anchorRect = getLineRect(anchorElement);
          const tabElement = tabRefs.current[conversation.id];

          if (!anchorRect || !tabElement) {
            continue;
          }

          const tabRect = tabElement.getBoundingClientRect();
          const sourceContentRect = getElementRect(
            getMessageBubbleElement(anchorElement),
          );
          const useAnchorEdge = hasAnotherAnchorOnSameLine({
            anchorRefs: anchorRefs.current,
            conversations: state.conversations,
            conversationId: conversation.id,
          });
          const startX = useAnchorEdge
            ? anchorRect.right
            : Math.max(
                anchorRect.right,
                (sourceContentRect?.right ?? anchorRect.right) +
                  CONNECTOR_CONTENT_GUTTER_PX,
              );

          nextConnections.push({
            id: `rail-${conversation.id}`,
            start: {
              x: startX,
              y: anchorRect.top + anchorRect.height / 2,
            },
            end: {
              x: tabRect.left,
              y: tabRect.top + tabRect.height / 2,
            },
            active: conversation.id === state.activeConversationId,
            variant: "curve",
          });
        }

        setConnections(nextConnections);
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
  }, [mainViewMode, state.activeConversationId, state.conversations, state.railOpen]);

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
    return {
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

    try {
      const response = await requestChatReply({
        conversation: getConversationRequestPayload({
          ...conversation,
          title: nextConversationTitle,
        }),
        messages: [...conversation.messages, userMessage],
        serviceId: conversation.serviceId,
      });

      appendAssistantMessage(conversationId, response.reply);
    } catch (error) {
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

  function handleServiceChange(
    conversationId: string,
    serviceId: BackendServiceId,
  ) {
    setState((current) => {
      const conversation = current.conversations[conversationId];

      if (!conversation || conversation.serviceId === serviceId) {
        return current;
      }

      return {
        ...current,
        conversations: {
          ...current.conversations,
          [conversationId]: {
            ...conversation,
            serviceId,
          },
        },
      };
    });
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

    setState((current) =>
      current.railOpen ? current : { ...current, railOpen: true },
    );
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
  }, [state.conversations]);

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

    setState((current) => {
      const currentParent = current.conversations[draft.conversationId];

      if (!currentParent) {
        return current;
      }

      return {
        ...current,
        activeConversationId: branchId,
        railOpen: true,
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

    try {
      const response = await requestChatReply({
        conversation: getConversationRequestPayload(branchConversation),
        messages: branchConversation.messages,
        serviceId: branchConversation.serviceId,
      });

      appendAssistantMessage(branchId, response.reply);
    } catch (error) {
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
    });

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
          [conversationId]: mainConversation,
        },
      }));
    });
    setDrafts((current) => ({
      ...current,
      [conversationId]: "",
    }));
  }

  function handleOpenSearch() {
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

  function handleSelectConversation(conversationId: string) {
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
    setMainViewMode("chat");

    startTransition(() => {
      setState((current) => {
        if (!current.conversations[conversationId]) {
          return current;
        }

        return {
          ...current,
          activeConversationId: conversationId,
          railOpen: true,
          rootId:
            getConversationRootId(current.conversations, conversationId) ??
            current.rootId,
        };
      });
    });
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
      delete tabRefs.current[deletedConversationId];
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
        };
      });
    });
  }

  function handleToggleMainViewMode() {
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
    setSearchModalOpen(false);
    setSearchQuery("");
    setMainViewMode((current) => (current === "chat" ? "tiles" : "chat"));
  }

  function handleToggleRail() {
    startTransition(() => {
      setState((current) => ({
        ...current,
        railOpen: !current.railOpen,
      }));
    });
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

  return (
    <div className="app-shell">
      <div className="app-chrome">
        <main className="workspace">
          <ThreadSidebar
            activeThreadId={activeRootConversation.id}
            mainViewMode={mainViewMode}
            onDeleteThread={handleDeleteThread}
            onNewChat={handleCreateMainConversation}
            onOpenSearch={handleOpenSearch}
            onRenameThread={handleRenameThread}
            onSelectThread={handleSelectConversation}
            onToggleMainViewMode={handleToggleMainViewMode}
            threads={threadSummaries}
          />

          <section
            className={
              isTileView ? "canvas-section is-thread-tile-view" : "canvas-section"
            }
          >
            <div className="canvas-head">
              {isTileView ? (
                <div className="canvas-view-intro">
                  <p className="eyebrow">Main chats</p>
                  <h2>Thread tile view</h2>
                  <p className="canvas-hint">
                    Browse threads by auto-detected category, then search, sort,
                    and jump back into the conversation.
                  </p>
                </div>
              ) : (
                <nav aria-label="Conversation path" className="canvas-breadcrumb">
                  {path.map((conversation, index) => (
                    <span
                      key={conversation.id}
                      className={
                        conversation.id === activeConversation.id
                          ? "breadcrumb-item is-active"
                          : "breadcrumb-item"
                      }
                    >
                      {index > 0 ? (
                        <span aria-hidden="true" className="breadcrumb-separator">
                          &gt;
                        </span>
                      ) : null}
                      <button
                        className="breadcrumb-button"
                        onClick={() => handleSelectConversation(conversation.id)}
                        type="button"
                      >
                        {conversation.title}
                      </button>
                    </span>
                  ))}
                </nav>
              )}

              <div className="canvas-tools">
                <button
                  aria-label={`Switch to ${
                    theme === "dark" ? "light" : "dark"
                  } theme`}
                  className="theme-toggle"
                  onClick={() =>
                    setTheme((current) =>
                      current === "dark" ? "light" : "dark",
                    )
                  }
                  type="button"
                >
                  <span aria-hidden="true" className="theme-toggle-icon">
                    <ThemeIcon theme={theme} />
                  </span>
                  <span className="theme-toggle-label">
                    {theme === "dark" ? "Dark theme" : "Light theme"}
                  </span>
                </button>
              </div>
            </div>

            <PinnedThreadTabs
              activeThreadId={activeRootConversation.id}
              onOpenThread={handleSelectConversation}
              onPinThread={handlePinThread}
              onUnpinThread={handleUnpinThread}
              pinnedThreads={pinnedThreadSummaries}
            />

            {isTileView ? (
              <MainChatTileView
                activeThreadId={activeRootConversation.id}
                onOpenThread={handleSelectConversation}
                threads={threadSummaries}
              />
            ) : (
              <div
                className={
                  isMainView
                    ? "conversation-canvas is-main-view"
                    : "conversation-canvas"
                }
                ref={canvasRef}
              >
                {path.map((conversation) => (
                  <div
                    key={conversation.id}
                    className={
                      isMainView ? "panel-slot is-main-view" : "panel-slot"
                    }
                  >
                    <ChatPanel
                      anchorsByMessageId={getAnchorsByMessageId(
                        state.conversations,
                        conversation.id,
                      )}
                      conversation={conversation}
                      draft={drafts[conversation.id] ?? ""}
                      isActive={conversation.id === activeConversation.id}
                      isSubmitting={Boolean(
                        pendingConversationIds[conversation.id],
                      )}
                      typingProgressByMessageId={
                        typingProgressByMessageIdRef.current
                      }
                      typingMessageIds={typingMessageIds}
                      selectionPreview={
                        selectionDraft?.conversationId === conversation.id
                          ? selectionDraft
                          : null
                      }
                      onActivate={() => handleSelectConversation(conversation.id)}
                      onDraftChange={(value) =>
                        handleDraftChange(conversation.id, value)
                      }
                      onServiceChange={handleServiceChange}
                      onStopTypewriter={handleStopTypewriter}
                      onSubmit={handleSubmit}
                      onTypewriterProgress={handleTypewriterProgress}
                      onTypewriterComplete={handleTypewriterComplete}
                      registerPanelRef={(conversationId, element) => {
                        panelRefs.current[conversationId] = element;
                      }}
                      registerAnchorRef={(branchConversationId, element) => {
                        anchorRefs.current[branchConversationId] = element;
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>

          {!isTileView ? (
            <BranchRail
              branches={focusedBranches}
              isRootActive={isMainView}
              onSelectConversation={handleSelectConversation}
              onSelectRoot={() => handleSelectConversation(activeRootConversation.id)}
              onToggle={handleToggleRail}
              open={state.railOpen}
              rootTitle={activeRootConversation.title}
              registerTabRef={(conversationId, element) => {
                tabRefs.current[conversationId] = element;
              }}
            />
          ) : null}

          {!isTileView ? <ConnectorOverlay connections={connections} /> : null}

          {!isTileView && selectionDraft ? (
            <form
              className="selection-tooltip"
              onSubmit={(event) => {
                event.preventDefault();
                handleCreateBranch();
              }}
              ref={toolbarRef}
              style={toolbarStyle}
            >
              <p className="eyebrow">New branch</p>
              <p className="selection-tooltip-quote">
                “{excerpt(selectionDraft.quote, 132)}”
              </p>
              <div className="selection-input-row">
                <input
                  autoFocus
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
        </main>
      </div>
    </div>
  );
}
