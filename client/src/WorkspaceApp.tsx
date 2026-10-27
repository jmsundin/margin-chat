import { useVisualViewport } from "./lib/useVisualViewport";
import { getGraphPinchZoomFactor } from "./lib/graphInteractions";
import { pinchOutStep, ZOOM_THROUGH_IDLE_MS } from "./lib/zoomThrough";
import { useAppUpdateGuard } from "./lib/appUpdateSafety";
import { MobileKeyboardProvider, MobileComposerViewport, useMobileKeyboard } from "./components/MobileKeyboard";
import MobileAIComposer from "./components/MobileAIComposer";
import { MobileSelectionActions } from "./components/MobileSelectionActions";
import { pdfPageFromSourceId } from "./lib/vaultFileDocuments";
import { SelectionToolbarRow } from "./components/SelectionToolbar";
import { CaretActions } from "./components/CaretActions";
import { MobileCreateMenu, type MobileCreateTarget } from "./components/MobileCreateMenu";
import { caretParagraphIn } from "./components/LiveDocumentEditor";
import { useMobileDockSlot } from "./lib/mobileDock";
import type { DocumentCaretMenu } from "./components/DocumentPanel";
import { isMarkdownHighlighted, toggleMarkdownHighlight } from "./lib/selectionHighlight";
import { copySelection, hideNativeSelectionMenu, isReselectingSelection } from "./lib/selectionMenu";
import { apiStorageNamespace } from "./lib/apiTransport";
import { openThreadAsChat, useBrowserThreadImports, useBrowserWorkspaceCapture, type BrowserCaptureRequest, type BrowserThreadRequest } from "./lib/browserWorkspace";
import { createMarginDocument, isCompactDocument, marginNoteToSideDocument, isHiddenFromAI } from "@margin-chat/workspace-contracts";
import { getNextTheme, type ThemeMode } from "./lib/appearance";
import "./workspace-improvements.css";
import "./document-workspace.css";
import { getChatPanelLayout, resizeChatPanel } from "./lib/chatPanelLayout";
import { getConversationAnnotationPreview, summarizeAnnotationText } from "./lib/annotationPreview";
import { getAnchorsByMessageId } from "./lib/documentAnchorLinks";
import {
  Fragment,
  lazy,
  startTransition,
  Suspense,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import BranchRail from "./components/BranchRail";
import ServicePickerModal from "./components/ServicePickerModal";
import DocumentPanel from "./components/DocumentPanel";
import MarginDocumentFrame, { getMarginDocumentSize, type MarginDocumentSize } from "./components/MarginDocumentFrame";
import DocumentLinkPicker from "./components/DocumentLinkPicker";
import { SessionChips, SessionsPanel } from "./components/Sessions";
import DocumentTabs from "./components/DocumentTabs";
import { DocumentCompass, DocumentKeepReading, DocumentMapHeader, DocumentNavigationSwitcher, DocumentTopicOutline, type NeighborRelation } from "./components/DocumentNavigator";
import { getDocumentNeighbors, loadDocumentNavigationStyle, saveDocumentNavigationStyle, type DocumentNavigationStyle } from "./lib/documentNeighbors";
import { loadDocumentHeaderOpen, saveDocumentHeaderOpen, useScrollAwayHeader } from "./lib/documentHeader";
import { getDocumentGraphEdges } from "./lib/documentRelations";
import { useSessionAutoNames } from "./lib/useSessionAutoNames";
import {
  applySessionAutoName, createSession, deleteSession, duplicateSession, ensureSessions, getActiveSession,
  recordSessionDocument, removeDocumentFromSession, renameSession, sortSessions, switchSession,
} from "./lib/workspaceSessions";
import DocumentChildrenMenu from "./components/DocumentChildrenMenu";
import { DOCUMENT_MARGIN_GUTTER, type DocumentMarginItem } from "./components/DocumentMargin";
import MinimizedChildNodes, { getMinimizedChildNodesWidth, type MinimizedChildNode } from "./components/MinimizedChildNodes";
import DocumentBreadcrumbs from "./components/DocumentBreadcrumbs";
import type { GraphDockControls } from "./components/ConversationGraphView";
import DocumentMenu from "./components/DocumentMenu";
import DocumentViewsMenu from "./components/DocumentViewsMenu";
import WorkspaceModeToggle from "./components/WorkspaceModeToggle";
import { viewForShortcut } from "./lib/workspaceViewShortcuts";
import WorkspaceView from "./components/WorkspaceView";
import DocumentDock from "./components/DocumentDock";
import DocumentWorkspaceLayout from "./components/DocumentWorkspaceLayout";
import { addPinnedDocument, listPinnedDocumentIds, removePinnedDocument } from "./lib/documentDock";
import { closeDocument, focusDocument, getDocumentChildrenByParent, getDocumentWidth, getDocumentWorkspace, getMarginHostPath, minimizeDocument, openDocumentBeside, placeDocumentAfterParent, reorderDocument, replaceDocument, setDocumentWidth, showDocument } from "./lib/documentWorkspace";
import { loadOpenedDocuments } from "./lib/vaultWorkingSet";
import { getDocumentBackTarget, getDocumentKind, getPresentedParentId, recordDocumentNavigation, takeDocumentBack, type DocumentHistory } from "./lib/documentBreadcrumbs";
import { joinDocumentBlocks } from "./lib/continuousDocument";
import { defaultSelectionDestination } from "./lib/selectionDestination";
import { getEditableDocument, getEditableDocumentText, insertDocumentBlock, remapDocumentRange, splitDocumentMarkdown, type EditableDocument, type DocumentGeneration } from "./lib/editableDocument";
import { buildDiagramAIMessage, buildDocumentAIMessage, type DiagramAIRequest, type DocumentAIRequest } from "./lib/documentAI";
import { findMermaidFences, hasSelectedDiagramInFocus, isMermaidDiagramPassage, mermaidDiagramReply } from "./lib/mermaidDiagrams";
import { acceptDocumentVersion, undoDocumentInsertion, remapDocumentReplacement } from "./lib/documentVersions";
import { remapDocumentAnchor } from "./lib/documentAnchors";
import { addDocumentLink, createDocumentLink, getDocumentLinkTarget, remapDocumentLinks, removeDocumentLink } from "./lib/documentLinks";
import { transferDocumentBlock } from "./lib/documentBlockTransfer";
import NotificationToast from "./components/NotificationToast";
import FolderDeletionPrompt from "./components/FolderDeletionPrompt";
import OnlyCopyPrompt from "./components/OnlyCopyPrompt";
import VaultFolderGate from "./components/VaultFolderGate";
import AIControls from "./components/AIControls";
import JevRelatedItems from "./components/JevRelatedItems";
import { useJevAssistance, useJevPreference } from "./lib/useJevAssistance";
import { useVaultPassageIndex } from "./lib/useVaultPassageIndex";
import { applyJevCategories, withJevConsent } from "./lib/jevAssistance";
import { applyJevGroupSuggestions } from "./lib/jevGrouping";
import { getThreadCategoryLabel } from "./lib/threadCategories";
import { getDocumentBlockAuthorship, normalizeAISettings, normalizeDocumentDock, type DocumentDockNode } from "@margin-chat/workspace-contracts";
import { prepareAIContext } from "./lib/aiContext";
import ConnectorOverlay from "./components/ConnectorOverlay";
import { buildConnectorOcclusions, buildDocumentConnector, intersectConnectorRects, type ConnectorRect, type DocumentConnectorEndpoint } from "./lib/documentConnectors";
import { keepExploredItems } from "./lib/keepExplored";
import type { MapExploration } from "./lib/mapExploration";
import { connectPublicTopics, findSavedPublicTopic, savePublicTopic, wikipediaConnectionKind } from "./lib/publicTopicWorkspace";
import { wikidataStatement, type PublicExpansion } from "./lib/publicKnowledge";
import { wikipediaArticleUrl } from "./lib/wikipedia";
import type { PrivateAnswer } from "./lib/publicMapApi";
import type { PublicTopic } from "./lib/publicKnowledge";
import { addMapChildNote, createMapNote, getRemovableMapNote, removeMapNote, restoreMapNote, setPersonalMapConnection } from "./lib/graphWorkspaceEdits";
import { getDocumentRelationType, restoreDocumentConnections, setDocumentRelation } from "./lib/documentRelations";
import type { DocumentRelationTypeId } from "./types";
import { useTopicExpansion } from "./lib/useTopicExpansion";
import GraphSourceFocus from "./components/GraphSourceFocus";
import { ConversationGroupPickerContext } from "./components/ConversationGroupControls";
import MainChatTileView from "./components/MainChatTileView";
import SettingsPage, { type SettingsSection } from "./components/SettingsPage";
import ChatHistoryImport from "./components/ChatHistoryImport";
import ViewIntro from "./components/ViewIntro";
import AIAccessDialog from "./components/AIAccessDialog";
import GuidedTour, { DESKTOP_TOUR, PHONE_TOUR, TourPill } from "./components/GuidedTour";
import { chatImportReminderDue, finishChatImportReminder } from "./lib/chatImportReminder";
import { NEW_DEVICE_NOTICE, loggedInThisTab } from "./lib/newDeviceNotice";
import { completedStarterTasks, isPristineWorkspace, seedStarterDocument, tickStarterTasks } from "./lib/starterDocument";
import { loadOnboarding, saveOnboarding, type OnboardingRecord } from "./lib/onboarding";
import { addExampleVault } from "./lib/exampleVault";
import CaptureInbox from "./components/CaptureInbox";
import { createCaptureAIRequest, openCaptureAsNote, readCaptureHandoff } from "./lib/captures";
import SearchModal from "./components/SearchModal";
import VaultSearchPalette, { type VaultSearchOpenMode } from "./components/VaultSearchPalette";
import SearchResultsPanel from "./components/SearchResultsPanel";
import { cacheVaultCloudSearch, createVaultSearchProvider, type VaultSearchDocumentHit, type VaultSearchPassageHit, type VaultSearchScope } from "./lib/vaultSearch";
import SearchSourceFocus from "./components/SearchSourceFocus";
import { resolveSearchSource } from "./lib/searchSource";
import type { SearchEvidenceRef } from "./lib/conversationSearch";
import ThreadSidebar from "./components/ThreadSidebar";
import ResizableSidebar from "./components/ResizableSidebar";
import MobileEdgeSwipe from "./components/MobileEdgeSwipe";
import CloudVaultIndex, { VaultFetchIndicator } from "./components/CloudVaultIndex";
import VaultSwitcher from "./components/VaultSwitcher";
import VaultFileDrop from "./components/VaultFileDrop";
import { loadSidebarDocumentSort, saveSidebarDocumentSort, type SidebarDocumentSort } from "./lib/sidebarDocumentOrder";
import { useSidebarDocumentOrder } from "./lib/useSidebarDocumentOrder";
import {
  ApiError,
  requestDeleteDocument,
  requestChatReply,
  requestChatTitle,
  requestDocumentTitle,
  requestUploadDocument,
} from "./lib/api";
import { DOCUMENT_TITLE_IDLE_MS, MAX_DOCUMENT_TITLE_CONTENT_LENGTH, getDocumentTitleSource, isPlaceholderDocumentTitle } from "./lib/documentTitle";
import { DocumentTitleSuggestionContext, suggestLocalDocumentTitle, toPlainDocumentTitle, type SuggestDocumentTitle } from "./lib/documentTitleSuggestion";
import {
  getRecentModelSelectionsStorageKey,
  getStateSavedAtStorageKey,
  getStateStorageKey,
  loadRecentModelSelections,
  loadStoredState,
} from "./lib/appState";
import { getConversationRequestPayload } from "./lib/chatContext";
import { loadVaultFileContext, nearestVaultFile } from "./lib/vaultFileContext";
import { useChatStreams } from "./lib/useChatStreams";
import { addAIChildNodes, type AIChildNodeProposal } from "./lib/aiChildNodes";
import { applyTextEdit, canUndoProposal, undoEditArguments, withProposalUpdate } from "./lib/agentProposals";
import { addImportedWebDocuments } from "./lib/webImportDocuments";
import { addChildConversation, addRootConversation, appendMessage, appendMessageDelta, deleteThread, removeConversationDocument, retractMessageText } from "./lib/workspaceCommands";
import { buildDocumentSummaries, buildSearchResults, buildThreadSummaries } from "./lib/conversationSearch";
import {
  CONVERSATION_GROUP_COLORS,
  assignConversationToGroup,
  getConversationGroupId,
} from "./lib/conversationGroups";
import {
  getSelectionTooltipLayout,
  isNativeSelectionInteraction,
  writeSelectedQuoteToClipboard,
} from "./lib/selectionTooltip";
import {
  getHorizontalWheelDelta,
  isProfileDialogWheelTarget,
} from "./lib/wheelGestures";
import { canSyncWorkspaceToCloud } from "./lib/workspaceStorage";
import { useMarkdownVault } from "./lib/useMarkdownVault";
import { VaultMediaContext } from "./lib/vaultMedia";
import {
  getBackendServiceLabel,
  getBackendServiceModel,
  resolveBackendServiceModelId,
  supportsAgentMode,
  type RecentBackendServiceSelection,
  upsertRecentBackendServiceSelection,
} from "./lib/services";
import AgentModeToggle, { type AgentModeControls } from "./components/AgentModeToggle";
import {
  mergeGraphNodeLayouts,
  normalizeGraphLayouts,
} from "./lib/graphLayout";
import {
  buildConversationTitle,
  collectConversationTreeIds,
  excerpt,
  getBranchNavigation,
  getConversationPath,
  getConversationRootId,
} from "./lib/tree";
import { buildEditableDocumentOutline } from "./lib/chatOutline";
import { getConversationSelectionViewMode } from "./lib/conversationNavigation";
import { lockPageZoom } from "./lib/pageZoomLock";
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
  BillingPlan,
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

// Map View pulls in the graph canvases and ELK layout; load it on first visit.
const KnowledgeGraphWorkspace = lazy(() => import("./components/KnowledgeGraphWorkspace"));

const EMPTY_SET: ReadonlySet<string> = new Set();
const LEFT_SIDEBAR_STORAGE_KEY = "margin-chat-left-sidebar-open";
const CHAT_PANEL_WIDTH_STORAGE_KEY = "margin-chat-panel-width";
const HIDDEN_FROM_AI_MESSAGE = "This document is hidden from AI, so nothing in it was sent. To ask AI about it, turn off “Hide from AI” in its menu.";
const BRANCH_PROMPT_PLACEHOLDER = "Ask about the selected text...";
const EXPLAIN_SELECTION_PROMPT = "Explain the selected text.";
const REWRITE_SELECTION_PROMPT = "Rewrite the selected text for clarity and flow, preserving its meaning and tone. Return only the rewritten passage.";
const SIMPLIFY_DIAGRAM_PROMPT = "Simplify this diagram without losing a step or decision that matters.";
const MATCH_DIAGRAM_PROMPT = "Update this diagram so it matches what the rest of the document says.";
const DIAGRAM_PROMPT_PLACEHOLDER = "Describe the change, e.g. add a step after…";
const TOOLTIP_VIEWPORT_MARGIN = 16;
const CHAT_PANEL_DEFAULT_WIDTH_PX = 760;
const CHAT_PANEL_KEYBOARD_STEP_PX = 24;
const CHAT_PANEL_MAX_WIDTH_PX = 980;
const CHAT_PANEL_MIN_WIDTH_PX = 320;
/** A document and its open side document may each narrow this far so both fit on screen. */
const PAIRED_PANEL_MIN_WIDTH_PX = 280;
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
  storageNamespace?: string;
  browserCaptureRequest?: BrowserCaptureRequest | null;
  onBrowserCaptureHandled?: (id: string) => void;
  browserThreadRequests?: readonly BrowserThreadRequest[] | null;
  onBrowserThreadHandled?: (request: BrowserThreadRequest) => void;
  onOpenWebsiteSettings?: (tab: "account" | "billing" | "api-keys" | "agents") => void;
  /** True inside the browser extension, whose document tabs get their own close buttons. */
  inExtension?: boolean;
  /** The free trial at /try: no account, an example vault, and nothing that needs one. */
  guest?: boolean;
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
  onStartSubscription: (plan?: BillingPlan) => void | Promise<void>;
  onUpgradeToPlus?: () => void | Promise<void>;
  onSetTheme: Dispatch<SetStateAction<ThemeMode>>;
  onUpdateProfile: (args: {
    displayName: string;
    email: string;
    currentPassword?: string;
  }) => Promise<AuthenticatedUser>;
  onChangePassword: (args: { currentPassword: string; password: string }) => Promise<void>;
  onDeleteAccount: (args: { password: string; confirmation: string }) => Promise<void>;
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

/** The same passage, re-read after the selection settles or the editor reports it again. */
function isSameSelectedPassage(current: SelectionDraft | null, next: SelectionDraft) {
  return Boolean(current && current.conversationId === next.conversationId && current.messageId === next.messageId
    && current.sourceBlockId === next.sourceBlockId && current.startOffset === next.startOffset && current.endOffset === next.endOffset);
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

export default function WorkspaceApp(props: WorkspaceAppProps) {
  return <MobileKeyboardProvider><WorkspaceAppContent {...props} /></MobileKeyboardProvider>;
}

function WorkspaceAppContent({
  storageNamespace, browserCaptureRequest, onBrowserCaptureHandled, browserThreadRequests, onBrowserThreadHandled, onOpenWebsiteSettings, inExtension = false, guest = false,
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
  onUpgradeToPlus,
  onSetTheme,
  onUpdateProfile,
  onChangePassword,
  onDeleteAccount,
  onUpdateApiKeys,
  theme,
  user,
}: WorkspaceAppProps) {
  const mobileKeyboard = useMobileKeyboard();
  const storageUserId = storageNamespace ?? apiStorageNamespace(user.id);
  const stateStorageKey = getStateStorageKey(storageUserId);
  const stateSavedAtStorageKey = getStateSavedAtStorageKey(storageUserId);
  const recentModelSelectionsStorageKey = getRecentModelSelectionsStorageKey(
    storageUserId,
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
  const [scrollingDocumentId, setScrollingDocumentId] = useState(state.activeConversationId);
  // Back history per tab for breadcrumb navigation; it lasts for the session only.
  const [documentHistory, setDocumentHistory] = useState<DocumentHistory>({});
  const [besideRequest, setBesideRequest] = useState<{ id: string; sequence: number } | null>(null);
  const [recentModelSelections, setRecentModelSelections] = useState<
    RecentBackendServiceSelection[]
  >(() => loadRecentModelSelections(recentModelSelectionsStorageKey));
  const vault = useMarkdownVault({ user, storageUserId, state, setState, legacyHasState: initialStoredStateRef.current.hasStoredState });
  // The vault folder screen stays up while it copies the vault into the chosen folder.
  const [vaultFolderGateBusy, setVaultFolderGateBusy] = useState(false);
  const storageMode = vault.storageMode;
  const cloudBackupMatchesLocal = vault.matchesCloud;
  const localDirectoryStatus = vault.localDirectoryStatus;
  const [mainViewMode, setMainViewMode] = useState<MainViewMode>("chat");
  const [closedMarginNotes, setClosedMarginNotes] = useState<Record<string, boolean>>({});
  // One document filling the window; everything else stays mounted underneath so restoring is exact.
  const [maximizedDocumentId, setMaximizedDocumentId] = useState<string | null>(null);
  const [marginResizePreviews, setMarginResizePreviews] = useState<Record<string, MarginDocumentSize | undefined>>({});
  const [graphFocusRequest, setGraphFocusRequest] = useState<{
    conversationId: string;
    requestId: number;
    openReader?: boolean;
    neighborhoodDepth?: number;
    preserveMapMode?: boolean;
  } | null>(null);
  const graphFocusRequestCounterRef = useRef(0);
  // The Map view floating over the document ("Around this document"), not a switch to Map view.
  const [mapModalOpen, setMapModalOpen] = useState(false);
  const [mapModalBounds, setMapModalBounds] = useState<CSSProperties | null>(null);
  const canvasSectionRef = useRef<HTMLElement | null>(null);
  const documentAreaRef = useRef<HTMLDivElement | null>(null);
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
  const [selectionResponseDestination, setSelectionResponseDestination] = useState<"inline" | "side">("side");
  const [selectionReplaceText, setSelectionReplaceText] = useState(false);
  const [documentErrors, setDocumentErrors] = useState<Record<string, string>>({});
  const { executions: chatExecutions, pendingConversationIds, agentProgress } = useChatStreams(appendAssistantDelta, saveExecutionDetails, retractAssistantText);
  const [documentUploadByConversationId, setDocumentUploadByConversationId] =
    useState<Record<string, { error: string | null; uploading: boolean }>>({});
  const [typingMessageIds, setTypingMessageIds] = useState<Record<string, boolean>>(
    {},
  );
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(
    null,
  );
  const [caretMenu, setCaretMenu] = useState<DocumentCaretMenu | null>(null);
  // The passage the phone's + menu was opened on.
  const createMenuPassage = useRef<SelectionDraft | null>(null);
  const closeCaretMenu = useRef(() => setCaretMenu(null)).current;
  // Selecting text swaps the caret menu for the selection toolbar.
  useEffect(() => { if (selectionDraft) setCaretMenu(null); }, [selectionDraft]);
  const selectionDraftRef = useRef(selectionDraft);
  selectionDraftRef.current = selectionDraft;
  const selectionViewport = useVisualViewport(Boolean(selectionDraft) && !mobileKeyboard.mobile);
  const [selectionActionsExpanded, setSelectionActionsExpanded] = useState(false);
  const [selectionOptionsInitiallyOpen, setSelectionOptionsInitiallyOpen] = useState(false);
  const [selectionIntent, setSelectionIntent] = useState<"actions" | "branch" | "link">("actions");
  const [selectionModelOpen, setSelectionModelOpen] = useState(false);
  const [selectionLinkError, setSelectionLinkError] = useState<string | null>(null);
  const [documentLinkNotice, setDocumentLinkNotice] = useState<{ message: string; conversationId?: string; blockId?: string } | null>(null);
  const [uploadNotice, setUploadNotice] = useState<{ message: string; kind: "info" | "success" | "error" } | null>(null);
  const [jevEnabled, setJevEnabled] = useJevPreference(storageUserId);
  const [profileModalOpen, setProfileModalOpen] = useState(() => ["account", "billing", "api-keys", "agents", "appearance", "voice", "storage"].includes(new URLSearchParams(window.location.search).get("settings") ?? ""));
  const [historyImportOpen, setHistoryImportOpen] = useState(false);
  const [chatImportReminder, setChatImportReminder] = useState(false);
  // Days after the first visit, someone who never brought in old chats is offered it once.
  useEffect(() => {
    if (vault.ready && !inExtension && chatImportReminderDue(storageUserId)) setChatImportReminder(true);
  }, [vault.ready, inExtension, storageUserId]);
  const [profileInitialTab, setProfileInitialTab] = useState<SettingsSection | null>(() => {
    const tab = new URLSearchParams(window.location.search).get("settings");
    return tab === "account" || tab === "billing" || tab === "api-keys" || tab === "agents" || tab === "appearance" || tab === "voice" || tab === "storage" ? tab : null;
  });
  const previousPendingChats = useRef(pendingConversationIds);
  const refreshBillingAfterChat = useEffectEvent(() => { void onRefreshBilling(); });
  useEffect(() => {
    const completed = Object.keys(previousPendingChats.current).some((id) => !pendingConversationIds[id]);
    previousPendingChats.current = pendingConversationIds;
    if (completed) refreshBillingAfterChat();
  }, [pendingConversationIds]);
  // An account with no plan, credit or admin role gets the ways to turn AI on, not Billing with an error.
  const [aiAccessOpen, setAIAccessOpen] = useState(false);
  useEffect(() => {
    if (!billingOpenRequest) return;
    if (user.billing.accessKind === "none") { setAIAccessOpen(true); return; }
    setProfileInitialTab("billing");
    setProfileModalOpen(true);
  }, [billingOpenRequest]);
  function openApiKeySettings() {
    if (onOpenWebsiteSettings) { onOpenWebsiteSettings("api-keys"); return; }
    setProfileInitialTab("api-keys");
    setProfileModalOpen(true);
  }
  const [captureHandoff, setCaptureHandoff] = useState(() => readCaptureHandoff(window.location.search));
  const [captureInboxOpen, setCaptureInboxOpen] = useState(() => new URLSearchParams(window.location.search).has("inbox") || !!readCaptureHandoff(window.location.search));
  const [captureAIRequest, setCaptureAIRequest] = useState<{ conversationId: string; prompt: string } | null>(null);
  function closeCaptureInbox() {
    setCaptureInboxOpen(false);
    setCaptureHandoff(null);
    const url = new URL(window.location.href);
    for (const key of ["capture", "intent", "inbox"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", url);
  }
  const submitCaptureAI = useEffectEvent((conversationId: string, prompt: string) => {
    const source = currentStateRef.current.conversations[conversationId];
    const request = source && createCaptureAIRequest(source, prompt);
    if (request) handleDocumentSubmit(conversationId, request);
  });
  useEffect(() => {
    if (!captureAIRequest || !state.conversations[captureAIRequest.conversationId]) return;
    setCaptureAIRequest(null);
    submitCaptureAI(captureAIRequest.conversationId, captureAIRequest.prompt);
  }, [captureAIRequest, state.conversations]);
  useBrowserWorkspaceCapture(vault.ready, browserCaptureRequest, (request) => {
    setSelectionDraft(null);
    setMainViewMode("chat");
    setState((current) => {
      const next = openCaptureAsNote(current, request.capture);
      currentStateRef.current = next;
      return next;
    });
    if (request.prompt?.trim()) {
      setCaptureAIRequest({ conversationId: `web-capture-${request.capture.id}`, prompt: request.prompt.trim() });
    }
    if (isMobileViewport) setLeftSidebarOpen(false);
  }, onBrowserCaptureHandled);
  useBrowserThreadImports(vault.ready, browserThreadRequests, (request) => {
    if (request.focus) { setSelectionDraft(null); setMainViewMode("chat"); if (isMobileViewport) setLeftSidebarOpen(false); }
    setState((current) => {
      const next = openThreadAsChat(current, request.thread, request.focus);
      currentStateRef.current = next;
      return next;
    });
  }, onBrowserThreadHandled);
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  useAppUpdateGuard("workspace", {
    busy: () => Object.values(pendingConversationIds).some(Boolean) || !!topicExpansion.pendingId || Object.values(documentUploadByConversationId).some((item) => item.uploading) || profileSaving,
    check: () => {
      if (Object.values(pendingConversationIds).some(Boolean) || topicExpansion.pendingId) return "A response is still running in a tab. Let it finish or stop it, then try again.";
      if (Object.values(documentUploadByConversationId).some((item) => item.uploading)) return "An attachment is still uploading in a tab. Wait for it to finish, then try again.";
      if (profileSaving || historyImportOpen || captureInboxOpen) return "Finish the open import, capture, or settings operation in each tab, then try again.";
      if (Object.values(drafts).some((draft) => draft.trim()) || selectionDraft?.prompt.trim()) return "An unsent draft is open in a tab. Send or clear it before restarting.";
      return null;
    },
  });
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  /** The older filters-and-connections view, reached from the search box. */
  const [searchExploreOpen, setSearchExploreOpen] = useState(false);
  /** Search results kept open beside the documents. */
  const [searchPanel, setSearchPanel] = useState<{ query: string; scope: VaultSearchScope } | null>(null);
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
  // Keep this session's explicit sizes separate from streamed/synchronized
  // conversation snapshots. Persist them too, but don't discard them on release.
  const [resizedPanelWidths, setResizedPanelWidths] = useState<Record<string, number>>({});
  const toolbarRef = useRef<HTMLFormElement>(null);
  const documentPanelRefs = useRef<Record<string, HTMLElement | null>>({});
  const graphPanelRefs = useRef<Record<string, HTMLElement | null>>({});
  const panelRefs = useRef(documentPanelRefs.current);
  // A map reader and the document workspace may retain the same document.
  // Navigation must always target the panel in the currently visible mode.
  panelRefs.current = mainViewMode === "graph" ? graphPanelRefs.current : documentPanelRefs.current;
  const anchorRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const branchOriginRefs = useRef<Record<string, HTMLElement | null>>({});
  const composerSurfaceRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const panelScrollPositionsRef = useRef<Record<string, number>>({});
  const suppressNextChatAutoCenterRef = useRef(false);
  const [documentFocusSequence, setDocumentFocusSequence] = useState(0);
  const typingProgressByMessageIdRef = useRef<Record<string, number>>({});
  const currentStateRef = useRef(state);
  currentStateRef.current = state;
  const documentTitleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const documentTitleRequests = useRef(new Set<string>());
  // Prompt excerpts the app used as a stand-in title; a generated title may replace these.
  const provisionalDocumentTitles = useRef(new Map<string, string>());
  useEffect(() => () => { for (const timer of documentTitleTimers.current.values()) clearTimeout(timer); }, []);
  // AI names suggested in rename fields, by document and the text they came from, so reopening doesn't ask again.
  const suggestedDocumentTitles = useRef(new Map<string, { content: string; title: Promise<string> }>());
  const suggestDocumentTitleRef = useRef<SuggestDocumentTitle>(() => null);
  // Stable, so an open rename field isn't refilled when the workspace re-renders.
  const suggestDocumentTitle = useRef<SuggestDocumentTitle>((conversationId) => suggestDocumentTitleRef.current(conversationId)).current;
  const pendingMovedBlockFocus = useRef<{ conversationId: string; blockId: string } | null>(null);
  useLayoutEffect(() => {
    const request = pendingMovedBlockFocus.current;
    if (!request) return;
    pendingMovedBlockFocus.current = null;
    let attempts = 0;
    const focusMovedBlock = () => {
      const panel = panelRefs.current[request.conversationId];
      const block = [...(panel?.querySelectorAll<HTMLElement>("[data-document-block-id]") ?? [])]
        .find((element) => element.dataset.documentBlockId === request.blockId);
      const grip = block?.querySelector<HTMLElement>(".rich-document-grip");
      // A block's controls mount a frame after the editor shows the block.
      if (!grip && attempts++ < 10) { requestAnimationFrame(focusMovedBlock); return; }
      grip?.focus({ preventScroll: true });
      block?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    };
    focusMovedBlock();
  }, [state]);
  const selectionSyncFrameRef = useRef(0);
  const panelResizeStateRef = useRef<{
    conversationId: string;
    originWidth: number;
    previousWidthOverride: number | undefined;
    latestWidth: number;
    startClientX: number;
    direction: 1 | -1;
    startScrollLeft: number;
    maxWidth: number;
    pointerId: number;
    handle: HTMLDivElement;
    previousCursor: string;
    previousUserSelect: string;
  } | null>(null);
  const pendingPanelResizeScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingPanelResizeScroll.current === null) return;
    if (canvasRef.current) canvasRef.current.scrollLeft = pendingPanelResizeScroll.current;
    pendingPanelResizeScroll.current = null;
  }, [resizedPanelWidths, state.conversations]);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const cloudSyncEnabled = canSyncWorkspaceToCloud(user);
  const cloudBackupSizeBytes = useMemo(
    () => profileModalOpen ? new TextEncoder().encode(JSON.stringify(state)).byteLength : 0,
    [state, profileModalOpen],
  );

  const activeConversation =
    state.conversations[state.activeConversationId] ??
    state.conversations[state.rootId];
  const activeMarginNotesVisible = !closedMarginNotes[activeConversation.id]
    && activeConversation.childIds.some((id) => isCompactDocument(state.conversations[id]));
  const documentAnchorLinks = useMemo(() => {
    const cache = new Map<string, MessageAnchorLink[]>();
    return (conversationId: string) => {
      if (!cache.has(conversationId)) cache.set(conversationId, Object.values(getAnchorsByMessageId(state.conversations, conversationId)).flat());
      return cache.get(conversationId)!;
    };
  }, [state.conversations]);
  const {
    children: focusedBranches,
    path,
    siblings: siblingBranches,
  } = getBranchNavigation(state.conversations, activeConversation.id);
  const activeRootConversation = path[0] ?? activeConversation;
  const documentDock = normalizeDocumentDock(state.documentDock, state.conversations);
  const pinnedDocumentIds = listPinnedDocumentIds(documentDock?.tree ?? null);
  const workspaceFocusId = pinnedDocumentIds.includes(activeConversation.id) && state.conversations[scrollingDocumentId]
    ? scrollingDocumentId : activeConversation.id;
  const documentWorkspace = getDocumentWorkspace(state.conversations, workspaceFocusId);
  const documentChildrenByParent = useMemo(() => getDocumentChildrenByParent(state.conversations), [state.conversations]);
  const minimizedSideDocumentsByParent = useMemo(() => {
    const children = new Map<string, Conversation[]>();
    for (const root of Object.values(state.conversations)) {
      const layout = root.documentLayout;
      if (root.parentId !== null || !layout) continue;
      const minimized = new Set(layout.minimizedIds);
      for (const id of new Set([...layout.order, ...layout.minimizedIds])) {
        const child = state.conversations[id];
        if (!minimized.has(id) || !child?.parentId) continue;
        const siblings = children.get(child.parentId) ?? [];
        siblings.push(child);
        children.set(child.parentId, siblings);
      }
    }
    return children;
  }, [state.conversations]);
  const familyDocumentIds = new Set(documentWorkspace.documents.map((document) => document.id));
  const familyPinnedDocumentIds: string[] = [];
  function collectFamilyPins(node: DocumentDockNode | null) {
    if (!node) return;
    if (node.type === "pane") { if (node.scope === "family") familyPinnedDocumentIds.push(node.documentId); }
    else { collectFamilyPins(node.first); collectFamilyPins(node.second); }
  }
  collectFamilyPins(documentDock?.tree ?? null);
  const visiblePinnedDocumentIds = pinnedDocumentIds.filter((id) => !familyPinnedDocumentIds.includes(id) || familyDocumentIds.has(id));
  const scrollingDocuments = documentWorkspace.visibleDocuments.filter((document) => !pinnedDocumentIds.includes(document.id)
    && (!isCompactDocument(document) || !document.parentId));
  // When each document was last opened on this device; the path follows the latest child below the focused one.
  const documentOpenedAt = useMemo(() => loadOpenedDocuments(storageUserId), [storageUserId, activeConversation.id]);
  const tabDocuments = [
    ...visiblePinnedDocumentIds.filter((id) => !familyDocumentIds.has(id)).map((id) => state.conversations[id]),
    ...documentWorkspace.openDocuments,
  ];
  // Tabs hold main and side documents only; margin notes and branches stay in the breadcrumbs and navigator.
  const peerTabDocuments = tabDocuments.filter((document) => getPresentedParentId(state.conversations, document.id) === null);
  let activePeerTabId = activeConversation.id;
  for (const seen = new Set<string>(); !seen.has(activePeerTabId);) {
    seen.add(activePeerTabId);
    const parentId = getPresentedParentId(state.conversations, activePeerTabId);
    if (!parentId) break;
    activePeerTabId = parentId;
  }
  // A workspace without sessions starts with one holding the documents already open.
  const hasActiveSession = Boolean(getActiveSession(state));
  useEffect(() => {
    if (!vault.ready || hasActiveSession) return;
    const openIds = tabDocuments.map((document) => document.id);
    setState((current) => ensureSessions(current, openIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.ready, hasActiveSession]);
  // A document you focus joins the active session. Switching sessions alone records nothing.
  useEffect(() => {
    setState((current) => recordSessionDocument(current, current.activeConversationId));
  }, [activeConversation.id]);
  useEffect(() => {
    if (!pinnedDocumentIds.includes(activeConversation.id)) setScrollingDocumentId(activeConversation.id);
  }, [activeConversation.id, pinnedDocumentIds.join("|")]);
  useLayoutEffect(() => {
    for (const [id, scrollTop] of Object.entries(panelScrollPositionsRef.current)) {
      const body = panelRefs.current[id]?.querySelector<HTMLElement>(".document-body");
      if (!body) continue;
      body.scrollTop = scrollTop;
      delete panelScrollPositionsRef.current[id];
    }
  });
  const currentChatOutline = useMemo(() => buildEditableDocumentOutline(activeConversation), [activeConversation]);
  const currentChatOutlineKey = currentChatOutline
    .map((item) => item.id)
    .join("|");
  const isTileView = mainViewMode === "tiles";
  const createSlot = useMobileDockSlot("create");
  const isGraphView = mainViewMode === "graph";
  const visibleDocumentIds = new Set([...visiblePinnedDocumentIds, ...scrollingDocuments.map((document) => document.id)]);
  const maximizedDocument = !isTileView && !isGraphView && maximizedDocumentId && visibleDocumentIds.has(maximizedDocumentId)
    ? state.conversations[maximizedDocumentId] : undefined;
  const maximizedIsPinned = Boolean(maximizedDocument && pinnedDocumentIds.includes(maximizedDocument.id));
  useEffect(() => {
    if (!maximizedDocumentId) return;
    // Leaving Document view or closing the document ends maximize; opening another
    // full document (a child tab, search) moves maximize to it.
    if (isTileView || isGraphView || !state.conversations[maximizedDocumentId]) { setMaximizedDocumentId(null); return; }
    if (activeConversation.id !== maximizedDocumentId && !isCompactDocument(activeConversation) && visibleDocumentIds.has(activeConversation.id)) {
      setMaximizedDocumentId(activeConversation.id);
    } else if (!visibleDocumentIds.has(maximizedDocumentId)) setMaximizedDocumentId(null);
  });
  // Maximize starts with the side panels tucked away (⌘B and the rail still open them)
  // and reopens the ones that were open before.
  const panelsBeforeMaximize = useRef<{ sidebar: boolean; rail: boolean } | null>(null);
  useEffect(() => {
    if (maximizedDocumentId && !panelsBeforeMaximize.current) {
      panelsBeforeMaximize.current = { sidebar: leftSidebarOpen, rail: state.railOpen };
      setLeftSidebarOpen(false);
      setState((current) => current.railOpen ? { ...current, railOpen: false } : current);
    } else if (!maximizedDocumentId && panelsBeforeMaximize.current) {
      const before = panelsBeforeMaximize.current;
      panelsBeforeMaximize.current = null;
      if (before.sidebar) setLeftSidebarOpen(true);
      if (before.rail) setState((current) => current.railOpen ? current : { ...current, railOpen: true });
    }
  }, [maximizedDocumentId]);
  const toggleMaximizedDocument = useEffectEvent((id: string) => {
    setMaximizedDocumentId((current) => current === id ? null : id);
    if (state.activeConversationId !== id) handleFocusVisibleDocument(id);
  });
  useEffect(() => {
    if (!maximizedDocument) return;
    function restoreWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      // Escape belongs to whatever popup, dialog or selection composer is open first.
      if (document.querySelector('[role="menu"], [role="dialog"], [aria-modal="true"], .selection-tooltip, .selection-mobile-composer')) return;
      setMaximizedDocumentId(null);
    }
    window.addEventListener("keydown", restoreWithEscape);
    return () => window.removeEventListener("keydown", restoreWithEscape);
  }, [maximizedDocument?.id]);
  // A document opened by zooming through its map card. Pinching out (or Back
  // to map) returns to the map, which kept its place.
  const [mapReturnId, setMapReturnId] = useState<string | null>(null);
  useEffect(() => { if (mainViewMode !== "chat") setMapReturnId(null); }, [mainViewMode]);
  const returnToMap = useEffectEvent(() => handleSetMainViewMode("graph"));
  useEffect(() => {
    if (!mapReturnId || mainViewMode !== "chat") return;
    let pinch: { travel: number; at: number } | null = null;
    // The pinch that opened the document may still be going; it must not zoom the page.
    let quietUntil = performance.now() + ZOOM_THROUGH_IDLE_MS;
    function handleWheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      const now = performance.now();
      const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      if (deltaY <= 0) {
        pinch = null;
        if (now < quietUntil) { event.preventDefault(); quietUntil = now + 300; }
        return;
      }
      event.preventDefault();
      pinch = pinchOutStep(pinch, getGraphPinchZoomFactor(deltaY), now);
      if (!pinch) returnToMap();
    }
    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, [mapReturnId, mainViewMode]);
  const chatPanelLayout = getChatPanelLayout({
    availableWidth: canvasWidth,
    preferredWidth: chatPanelWidth,
    hasParent: scrollingDocuments.length > 1,
    hasSideItems: scrollingDocuments.length > 1,
    mobile: isMobileViewport,
  });
  const panelMaximumWidth = Math.max(CHAT_PANEL_MIN_WIDTH_PX, Math.min(CHAT_PANEL_MAX_WIDTH_PX, canvasWidth - 48));
  function getRenderedPanelWidth(conversationId: string) {
    if (isMobileViewport) return chatPanelLayout.width;
    const chosen = resizedPanelWidths[conversationId] ?? getDocumentWidth(state.conversations, conversationId);
    if (chosen !== undefined) return Math.min(chosen, panelMaximumWidth);
    // A document and its side document share the canvas frame by frame: margin notes and
    // minimized side documents beside either one come out of both text columns, so the
    // source isn't pushed off screen when a side document opens.
    if (chatPanelLayout.fitsPair && scrollingDocuments.length === 2 && scrollingDocuments.some((document) => document.id === conversationId)) {
      const lanes = scrollingDocuments.reduce((total, document) => total + getPanelLaneWidth(document), 0);
      const shared = (canvasWidth - 80 - lanes) / 2;
      return Math.min(panelMaximumWidth, Math.max(PAIRED_PANEL_MIN_WIDTH_PX, Math.min(chatPanelLayout.width, shared)));
    }
    return Math.min(chatPanelLayout.width, panelMaximumWidth);
  }
  /** Width a document's frame adds beside its text: its margin notes and minimized side documents. */
  function getPanelLaneWidth(conversation: Conversation) {
    const nodes = getMinimizedChildNodes(conversation);
    return getDocumentMarginSpace(conversation) + (nodes ? getMinimizedChildNodesWidth(nodes.nodes, nodes.compact) : 0);
  }
  function getPanelResizeInfo(conversation: Conversation) {
    return {
      width: getRenderedPanelWidth(conversation.id),
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
  const vaultIndex = useVaultPassageIndex({ userId: user.id, active: vault.ready && vault.storageMode === "server", uploads: vault.uploads });
  const jevCategoryKey = JSON.stringify(jev.categories);
  const jevGroupSuggestionKey = JSON.stringify(jev.groupSuggestions);
  useEffect(() => {
    if (jev.status !== "ready") return;
    setState((current) => applyJevGroupSuggestions(current, jev.categories, jev.groupSuggestions));
  }, [jev.status, jevCategoryKey, jevGroupSuggestionKey]);
  const [newDeviceNotice, setNewDeviceNotice] = useState(false);
  const [onboarding, setOnboardingRecord] = useState<OnboardingRecord>(() => loadOnboarding(storageUserId));
  const updateOnboarding = useCallback((change: Partial<OnboardingRecord>) => setOnboardingRecord((current) => {
    const next = { ...current, ...change };
    saveOnboarding(storageUserId, next);
    return next;
  }), [storageUserId]);
  // A brand-new, empty workspace becomes "Start here" and the tour begins, once per device.
  // Waiting for the cloud list keeps a new device from treating a full vault as empty.
  const vaultSettled = vault.ready && !vault.fetchStatus && !(vault.cloudDocuments?.length);
  useEffect(() => {
    if (!vaultSettled || inExtension || onboarding.checked) return;
    if (isPristineWorkspace(state)) {
      setState((current) => seedStarterDocument(current));
      updateOnboarding({ checked: true, tour: "active", step: 0 });
      // An existing Free account on an empty browser has its documents on another device.
      if (!canSyncWorkspaceToCloud(user) && loggedInThisTab(user.id)) setNewDeviceNotice(true);
    } else updateOnboarding({ checked: true });
  }, [vaultSettled, inExtension, onboarding.checked]);
  // A trial visitor also gets the example vault, once, so the Map and search have something to show.
  useEffect(() => {
    if (!guest || !vaultSettled || onboarding.examples) return;
    setState((current) => addExampleVault(current));
    updateOnboarding({ examples: true });
  }, [guest, vaultSettled, onboarding.examples]);
  useEffect(() => { if (isGraphView && !onboarding.mapSeen) updateOnboarding({ mapSeen: true }); }, [isGraphView, onboarding.mapSeen]);
  const starterTasksDone = useMemo(() => completedStarterTasks(state, { map: onboarding.mapSeen }),
    [state.conversations, state.sessions, onboarding.mapSeen]);
  const tourSteps = isMobileViewport ? PHONE_TOUR : DESKTOP_TOUR;
  const starterTasksKey = [...starterTasksDone].sort().join(",");
  useEffect(() => {
    if (starterTasksDone.size) setState((current) => tickStarterTasks(current, starterTasksDone));
  }, [starterTasksKey]);
  // A vault this small belongs to someone new, so the views say what they are for.
  const newVault = guest || Object.keys(state.conversations).length <= 8;
  const threadSummaries = useMemo(
    () => applyJevCategories(buildThreadSummaries(state.conversations), jev.categories).map((thread) => ({
        ...thread,
        groupId: getConversationGroupId(state.groups, thread.id),
      })),
    [state.conversations, state.groups, summaryMinute, jevCategoryKey],
  );
  const documentSummaries = useMemo(
    () => buildDocumentSummaries(state.conversations).map((document) => ({
      ...document, groupId: getConversationGroupId(state.groups, document.id),
    })),
    [state.conversations, state.groups, summaryMinute],
  );
  const [documentSort, setDocumentSort] = useState<SidebarDocumentSort>(() => loadSidebarDocumentSort(storageUserId));
  const documentOrder = useSidebarDocumentOrder({
    userId: user.id, storageUserId, jevEnabled, cloudSync: canSyncWorkspaceToCloud(user), sort: documentSort,
    threads: documentSummaries, conversations: state.conversations, activeId: state.activeConversationId, ready: vault.ready,
  });
  const threadSummaryById = new Map(
    documentSummaries.map((thread) => [thread.id, thread] as const),
  );
  const sessions = state.sessions;
  const orderedDocumentIds = useMemo(() => documentOrder.threads.map((thread) => thread.id), [documentOrder.threads]);
  const sortedSessions = useMemo(() => sortSessions(Object.values(sessions?.items ?? {}), documentSort, orderedDocumentIds),
    [sessions?.items, documentSort, orderedDocumentIds]);
  const [sessionsRequest, setSessionsRequest] = useState(0);
  useSessionAutoNames({ userId: user.id, enabled: jevEnabled, sessions, conversations: state.conversations,
    onName: (sessionId, nameKey, name) => setState((current) => applySessionAutoName(current, sessionId, nameKey, name)) });
  const [navigationStyle, setNavigationStyle] = useState<DocumentNavigationStyle>(loadDocumentNavigationStyle);
  // A computer keeps the path row open unless it was put away; a phone shows one row and drops the rest down on a tap.
  const [desktopHeaderOpen, setDesktopHeaderOpen] = useState(loadDocumentHeaderOpen);
  const [mobileHeaderOpen, setMobileHeaderOpen] = useState(false);
  const headerOpen = isMobileViewport ? mobileHeaderOpen : desktopHeaderOpen;
  // On a phone the one-row header slides away while you read down a document and returns when you scroll up.
  const headerScrolledAway = useScrollAwayHeader(documentAreaRef, isMobileViewport && !mobileHeaderOpen && !isTileView && !isGraphView);
  useEffect(() => { setMobileHeaderOpen(false); }, [state.activeConversationId, isMobileViewport, mainViewMode]);
  // Links in text change as you type; the navigator can catch up a moment later.
  const deferredConversations = useDeferredValue(state.conversations);
  const documentGraphEdges = useMemo(() => getDocumentGraphEdges(deferredConversations), [deferredConversations]);
  const documentNeighbors = useMemo(() => getDocumentNeighbors(state.conversations, state.activeConversationId, documentGraphEdges),
    [state.conversations, state.activeConversationId, documentGraphEdges]);
  const blockMoveTargets = useMemo(
    () => documentSummaries.map(({ id, title }) => ({ id, title: title || "Untitled document" })),
    [documentSummaries],
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

    streamingThreadIds.add(conversationId);
  }
  const nearbyBranchCount = siblingBranches.length + focusedBranches.length;
  const branchNavigationCount =
    nearbyBranchCount + Math.max(path.length - 1, 0);
  const branchAccessEnabled = branchNavigationCount > 0;
  const mobilePanelsOpen =
    isMobileViewport &&
    !isTileView &&
    !isGraphView &&
    leftSidebarOpen;
  const searchResults = searchExploreOpen
    ? buildSearchResults(state.conversations, deferredSearchQuery, threadSummaries)
    : [];
  const searchCloudRef = useRef(vault.searchCloud);
  searchCloudRef.current = vault.searchCloud;
  const canSearchCloud = !!vault.searchCloud;
  const cachedSearchCloud = useMemo(() => canSearchCloud
    ? cacheVaultCloudSearch((query, options, onEvent) => searchCloudRef.current?.(query, options, onEvent) ?? Promise.reject(new Error("Cloud search is unavailable.")))
    : undefined, [canSearchCloud]);
  const vaultSearchProvider = useMemo(() => createVaultSearchProvider(() => ({
    conversations: state.conversations, cloudDocuments: vault.cloudDocuments ?? [], groups: state.groups, categories: jev.categories,
  }), cachedSearchCloud), [state.conversations, vault.cloudDocuments, state.groups, jev.categories, cachedSearchCloud]);

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

  useEffect(() => lockPageZoom(), []);

  // On phones the sidebar sits above everything, so a window opened from it
  // (profile, settings, inbox, import) would open hidden behind it.
  const sidebarModalOpen = profileModalOpen || captureInboxOpen || historyImportOpen;
  useEffect(() => {
    if (!isMobileViewport || !sidebarModalOpen) return;
    setLeftSidebarOpen(false);
    setState((current) => current.railOpen ? { ...current, railOpen: false } : current);
  }, [isMobileViewport, sidebarModalOpen]);

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

      const completed = event instanceof PointerEvent && event.type === "pointerup";
      if (completed) handleChatPanelResizePointerMove(event);
      panelResizeStateRef.current = null;
      if (completed && resizeState.latestWidth !== resizeState.originWidth) {
        setState((current) => setDocumentWidth(current, resizeState.conversationId, resizeState.latestWidth));
      }
      if (!completed) pendingPanelResizeScroll.current = resizeState.startScrollLeft;
      if (!completed) restorePanelWidthOverride(resizeState);
      setIsResizingChatPanel(false);
      setResizingChatPanelConversationId(null);
      if (resizeState.handle.hasPointerCapture?.(resizeState.pointerId)) resizeState.handle.releasePointerCapture(resizeState.pointerId);
      document.body.style.cursor = resizeState.previousCursor;
      document.body.style.userSelect = resizeState.previousUserSelect;

    }

    function handleChatPanelResizePointerMove(event: PointerEvent) {
      const resizeState = panelResizeStateRef.current;

      if (!resizeState || event.pointerId !== resizeState.pointerId) {
        return;
      }

      event.preventDefault();
      const next = resizeChatPanel({
        width: resizeState.originWidth,
        delta: (event.clientX - resizeState.startClientX) * resizeState.direction,
        maxWidth: resizeState.maxWidth,
      });
      resizeState.latestWidth = next.width;
      // In a horizontal flow, compensate scrolling when moving the left edge
      // so the document's opposite edge stays in place where the canvas allows.
      pendingPanelResizeScroll.current = resizeState.startScrollLeft
        + (resizeState.direction === -1 ? next.width - resizeState.originWidth : 0);
      setResizedPanelWidths((current) => ({
        ...current,
        [resizeState.conversationId]: next.width,
      }));
    }

    function cancelWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !panelResizeStateRef.current) return;
      event.preventDefault();
      stopChatPanelResize();
    }

    window.addEventListener("pointermove", handleChatPanelResizePointerMove);
    window.addEventListener("pointerup", stopChatPanelResize);
    window.addEventListener("pointercancel", stopChatPanelResize);
    window.addEventListener("lostpointercapture", stopChatPanelResize);
    window.addEventListener("blur", stopChatPanelResize);
    window.addEventListener("resize", stopChatPanelResize);
    window.addEventListener("keydown", cancelWithEscape);

    return () => {
      window.removeEventListener("pointermove", handleChatPanelResizePointerMove);
      window.removeEventListener("pointerup", stopChatPanelResize);
      window.removeEventListener("pointercancel", stopChatPanelResize);
      window.removeEventListener("lostpointercapture", stopChatPanelResize);
      window.removeEventListener("blur", stopChatPanelResize);
      window.removeEventListener("resize", stopChatPanelResize);
      window.removeEventListener("keydown", cancelWithEscape);
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
    restorePanelWidthOverride(resizing);
    setIsResizingChatPanel(false);
    setResizingChatPanelConversationId(null);
    if (resizing.handle.hasPointerCapture?.(resizing.pointerId)) resizing.handle.releasePointerCapture(resizing.pointerId);
    document.body.style.cursor = resizing.previousCursor;
    document.body.style.userSelect = resizing.previousUserSelect;
  }, [mainViewMode]);

  useEffect(() => {
    if (mainViewMode !== "graph" && !mapModalOpen) {
      setGraphFocusRequest(null);
    }
  }, [mainViewMode, mapModalOpen]);

  const showMapModal = mapModalOpen && mainViewMode === "chat" && navigationStyle === "graph";
  // The modal covers the document area (below its header), measured because the header's height varies.
  useLayoutEffect(() => {
    if (!showMapModal) return;
    function measure() {
      const section = canvasSectionRef.current?.getBoundingClientRect();
      const area = documentAreaRef.current?.getBoundingClientRect();
      if (!section || !area) return;
      const gap = area.width < 600 ? 4 : 12;
      setMapModalBounds({ top: area.top - section.top + gap, left: area.left - section.left + gap,
        width: Math.max(0, area.width - gap * 2), height: Math.max(0, area.height - gap * 2) });
    }
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (canvasSectionRef.current) observer?.observe(canvasSectionRef.current);
    if (documentAreaRef.current) observer?.observe(documentAreaRef.current);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [showMapModal]);

  useEffect(() => {
    if (!showMapModal) return;
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      // Escape inside the map's own menus and fields belongs to them.
      if (target?.closest("input, textarea, select, [contenteditable='true'], details[open], [role='menu']")) return;
      setMapModalOpen(false);
    }
    window.addEventListener("keydown", closeWithEscape);
    return () => window.removeEventListener("keydown", closeWithEscape);
  }, [showMapModal]);

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

  const openSearchFromShortcut = useEffectEvent(() => handleOpenSearch());
  useEffect(() => {
    function handleSearchShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing || event.key.toLowerCase() !== "o") return;
      // Capture before editor keymaps and suppress the browser's Open File action.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) openSearchFromShortcut();
    }
    document.addEventListener("keydown", handleSearchShortcut, true);
    return () => document.removeEventListener("keydown", handleSearchShortcut, true);
  }, []);

  // Ctrl+Alt+arrows walk the graph: up to the parent, down to the first child, sideways to siblings.
  const walkDocumentGraph = useEffectEvent((key: string) => {
    if (mainViewMode !== "chat" || !documentNeighbors) return false;
    const { parent, siblings, index, children } = documentNeighbors;
    const target = key === "ArrowUp" ? parent : key === "ArrowDown" ? children[0]
      : key === "ArrowLeft" ? siblings[index - 1] : key === "ArrowRight" ? siblings[index + 1] : undefined;
    if (!target) return false;
    handleOpenNeighbor(target.id, key === "ArrowUp" ? "parent" : key === "ArrowDown" ? "child" : "sibling");
    return true;
  });
  useEffect(() => {
    function handleGraphWalk(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey || event.isComposing || !event.key.startsWith("Arrow")) return;
      if (walkDocumentGraph(event.key)) { event.preventDefault(); event.stopPropagation(); }
    }
    document.addEventListener("keydown", handleGraphWalk, true);
    return () => document.removeEventListener("keydown", handleGraphWalk, true);
  }, []);

  const setViewFromShortcut = useEffectEvent((mode: MainViewMode) => { if (mode !== mainViewMode) handleSetMainViewMode(mode); });
  useEffect(() => {
    function handleViewShortcut(event: KeyboardEvent) {
      const mode = viewForShortcut(event);
      if (!mode) return;
      // Capture before editor keymaps; Cmd+G also stops the browser's Find next.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) setViewFromShortcut(mode);
    }
    // The desktop app's View menu sends its picks here.
    function handleViewRequest(event: Event) {
      const mode = (event as CustomEvent).detail;
      if (mode === "chat" || mode === "tiles" || mode === "graph") setViewFromShortcut(mode);
    }
    document.addEventListener("keydown", handleViewShortcut, true);
    window.addEventListener("margin:set-view", handleViewRequest);
    return () => {
      document.removeEventListener("keydown", handleViewShortcut, true);
      window.removeEventListener("margin:set-view", handleViewRequest);
    };
  }, []);

  const toggleSidebarFromShortcut = useEffectEvent(() => handleToggleLeftSidebar());
  useEffect(() => {
    function handleSidebarShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing || event.key.toLowerCase() !== "b") return;
      // Capture before editor keymaps so this workspace shortcut never also
      // toggles bold or gets swallowed by a document's keyboard handlers.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleSidebarFromShortcut();
    }
    document.addEventListener("keydown", handleSidebarShortcut, true);
    return () => document.removeEventListener("keydown", handleSidebarShortcut, true);
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
    if (pinnedDocumentIds.includes(state.activeConversationId)) return;

    const panel = panelRefs.current[state.activeConversationId];
    const notes = panel?.closest("[data-document-id]")?.nextElementSibling;
    if (panel && !isCompactDocument(activeConversation) && activeMarginNotesVisible && notes instanceof HTMLElement && notes.dataset.marginNotesFor === activeConversation.id && canvasRef.current) {
      const canvas = canvasRef.current;
      const panelBounds = panel.getBoundingClientRect();
      const groupWidth = notes.getBoundingClientRect().right - panelBounds.left;
      canvas.scrollTo({
        left: canvas.scrollLeft + panelBounds.left - canvas.getBoundingClientRect().left
          - Math.max(0, (canvas.clientWidth - groupWidth) / 2),
        behavior: "smooth",
      });
      return;
    }
    // A side document beside its source: show the pair together, or as much of the source as fits.
    const source = scrollingDocuments.length === 2 && scrollingDocuments[1].id === state.activeConversationId
      ? panelRefs.current[scrollingDocuments[0].id]?.closest<HTMLElement>("[data-document-id]") : null;
    const slot = panel?.closest<HTMLElement>("[data-document-id]");
    if (chatPanelLayout.fitsPair && source && slot && canvasRef.current) {
      const canvas = canvasRef.current;
      const canvasLeft = canvas.getBoundingClientRect().left;
      const left = source.getBoundingClientRect().left;
      const right = slot.getBoundingClientRect().right;
      const offset = right - left <= canvas.clientWidth
        ? left - canvasLeft - (canvas.clientWidth - (right - left)) / 2
        // Too wide for both: keep the source's text uncut and let the side document's edge go first.
        : Math.min(right - canvasLeft - canvas.clientWidth + 24, left - canvasLeft);
      canvas.scrollTo({ left: canvas.scrollLeft + offset, behavior: "smooth" });
      return;
    }
    panel?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [mainViewMode, state.activeConversationId, canvasWidth, chatPanelLayout.width, chatPanelLayout.fitsPair, vault.ready, isResizingSidebar, documentFocusSequence, activeMarginNotesVisible]);

  useEffect(() => {
    if (!besideRequest || mainViewMode !== "chat") return;
    panelRefs.current[besideRequest.id]?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [besideRequest]);

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
      target instanceof Element && target.closest("select, .document-child-tabs-panel") ||
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

    // A block's own scrolling surface gets first refusal, including at its
    // boundaries. Otherwise the capture listener steals code/table scrolling
    // before the browser or editor can handle it.
    const block = target instanceof Element ? target.closest("[data-document-block-id]") : null;
    let blockSurface = block && target instanceof Element ? target : null;
    while (blockSurface && block?.contains(blockSurface)) {
      if (blockSurface instanceof HTMLElement) {
        const style = window.getComputedStyle(blockSurface);
        const scrollX = /^(auto|scroll|overlay)$/.test(style.overflowX)
          && blockSurface.scrollWidth > blockSurface.clientWidth;
        const scrollY = /^(auto|scroll|overlay)$/.test(style.overflowY)
          && blockSurface.scrollHeight > blockSurface.clientHeight;
        const blockDeltaX = normalizeWheelDelta(event.deltaX, event.deltaMode, blockSurface.clientWidth);
        const blockDeltaY = normalizeWheelDelta(event.deltaY, event.deltaMode, blockSurface.clientHeight);
        const blockHorizontalDelta = getHorizontalWheelDelta({
          deltaX: blockDeltaX,
          deltaY: event.shiftKey ? normalizeWheelDelta(event.deltaY, event.deltaMode, blockSurface.clientWidth) : blockDeltaY,
          shiftKey: event.shiftKey,
        });
        if ((scrollX && Math.abs(blockHorizontalDelta) >= 0.5)
          || (scrollY && !event.shiftKey && Math.abs(blockDeltaY) >= 0.5)) {
          event.preventDefault();
          event.stopPropagation();
          if (scrollX) blockSurface.scrollLeft = clamp(
            blockSurface.scrollLeft + (event.shiftKey ? blockHorizontalDelta : blockDeltaX),
            0, blockSurface.scrollWidth - blockSurface.clientWidth,
          );
          if (scrollY && !event.shiftKey) blockSurface.scrollTop = clamp(
            blockSurface.scrollTop + blockDeltaY, 0, blockSurface.scrollHeight - blockSurface.clientHeight,
          );
          return;
        }
      }
      blockSurface = blockSurface.parentElement;
    }

    if (Math.abs(horizontalDelta) < 0.5) {
      // Let ordinary vertical wheels use native scrolling. For a vertical
      // diagonal, discard X so it cannot chain sideways into the canvas,
      // including when the document has reached its top or bottom.
      if (deltaX === 0 || Math.abs(deltaY) < 0.5) return;
      event.preventDefault();
      event.stopPropagation();
      let element = target instanceof Element ? target : null;
      while (element && element !== canvas) {
        if (element instanceof HTMLElement) {
          const style = window.getComputedStyle(element);
          if (/^(auto|scroll|overlay)$/.test(style.overflowY)) {
            const nextScrollTop = clamp(
              element.scrollTop + normalizeWheelDelta(event.deltaY, event.deltaMode, element.clientHeight),
              0,
              Math.max(0, element.scrollHeight - element.clientHeight),
            );
            if (nextScrollTop !== element.scrollTop) {
              element.scrollTop = nextScrollTop;
              return;
            }
            if (style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none") return;
          }
        }
        element = element.parentElement;
      }
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
  }, [handleConversationCanvasWheel, mainViewMode, vault.ready]);

  useEffect(() => {
    if (!selectionDraft) {
      return undefined;
    }

    const selectedQuote = selectionDraft.quote;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement;

      if (selectionModelOpen || target.closest?.("[data-mobile-keyboard-toggle]") || toolbarRef.current?.contains(target)) {
        return;
      }

      // Native selection handles can target the text or a surrounding element.
      // Let the browser finish touch selection before deciding whether to clear it.
      if (isNativeSelectionInteraction(event, window.getSelection())) return;
      setSelectionDraft(null);
      window.getSelection()?.removeAllRanges();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !selectionModelOpen) {
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

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("copy", handleCopy);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("copy", handleCopy);
    };
  }, [selectionDraft, selectionModelOpen]);

  useEffect(() => { setSelectionActionsExpanded(false); }, [selectionDraft?.conversationId, selectionDraft?.messageId, selectionDraft?.startOffset, selectionDraft?.endOffset]);

  useLayoutEffect(() => {
    if (!selectionDraft || !toolbarRef.current) {
      return;
    }
    const toolbar = toolbarRef.current;
    function measure() {
      const nextSize = { width: toolbar.offsetWidth, height: toolbar.scrollHeight };
      setToolbarSize((current) => current.width === nextSize.width && current.height === nextSize.height ? current : nextSize);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [selectionDraft, selectionIntent, selectionActionsExpanded]);

  useEffect(() => {
    if (mainViewMode !== "chat") {
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

        const layout = canvasRef.current?.closest<HTMLElement>(".document-workspace-layout");
        const layoutRect = getElementRect(layout ?? canvasRef.current);
        if (!layoutRect) return;
        const windowRect = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
        const workspaceRect = intersectConnectorRects(layoutRect, windowRect);
        if (!workspaceRect) return;
        // The overlay is fixed above the workspace. Mask every pixel occupied by
        // the dock, including its headers and gutters, for every dock orientation.
        const dockRects = Array.from(layout?.querySelectorAll(".document-workspace-dock") ?? [])
          .map((element) => getElementRect(element)).filter((rect): rect is DOMRect => Boolean(rect));
        nextOcclusionRects.push(...buildConnectorOcclusions(workspaceRect, dockRects, window.innerWidth, window.innerHeight));

        const panelViewports = new Map<string, ConnectorRect | null>();
        function endpoint(conversation: Conversation, element: Element | null | undefined, target: DocumentConnectorEndpoint["target"]): DocumentConnectorEndpoint {
          const panel = panelRefs.current[conversation.id];
          const panelRect = getElementRect(panel);
          const body = panel?.querySelector<HTMLElement>(".document-body") ?? panel;
          const inHeader = Boolean(element && panel?.contains(element) && !body?.contains(element));
          const viewportKey = `${conversation.id}:${inHeader ? "header" : "body"}`;
          if (!panelViewports.has(viewportKey)) {
            let viewport: ConnectorRect | null = workspaceRect;
            // Each document scrolls independently; a DOM rect alone does not
            // tell us whether its text is clipped by its body or the canvas.
            // Header controls are outside that scroller and remain visible.
            for (let ancestor: Element | null = (inHeader ? panel : body) ?? null; ancestor && viewport; ancestor = ancestor.parentElement) {
              const style = window.getComputedStyle(ancestor);
              const clipX = /(auto|scroll|hidden|clip)/.test(style.overflowX);
              const clipY = /(auto|scroll|hidden|clip)/.test(style.overflowY);
              if (!clipX && !clipY) continue;
              const rect = ancestor.getBoundingClientRect();
              viewport = intersectConnectorRects(viewport, {
                left: clipX ? rect.left : viewport.left,
                right: clipX ? rect.right : viewport.right,
                top: clipY ? rect.top : viewport.top,
                bottom: clipY ? rect.bottom : viewport.bottom,
              });
            }
            panelViewports.set(viewportKey, viewport);
          }
          const viewport = panelViewports.get(viewportKey) ?? null;
          const lineRects = element ? Array.from(element.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0) : [];
          const anchor = lineRects.filter((rect) => viewport && intersectConnectorRects(rect, viewport)).at(-1)
            ?? lineRects.at(-1) ?? getElementRect(element ?? null);
          const bodyRect = getElementRect(body);
          return { title: conversation.title || "Untitled document", target, panel: panelRect, viewport, anchor,
            markerViewport: viewport && bodyRect ? intersectConnectorRects(viewport, bodyRect) : viewport };
        }

        const minimizedNodeElements = Array.from(canvasRef.current?.querySelectorAll<HTMLElement>("[data-minimized-node-id]") ?? []);
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
            // A note in its parent's margin sits beside its passage with its own short link.
            if (isCompactDocument(childConversation) && showsMarginInPanel(parentConversation)) continue;
            // A minimized child shown as a node beside its document gets its curve below.
            if (minimizedNodeElements.some((node) => node.dataset.minimizedNodeId === childConversation.id)) continue;

            const connection = buildDocumentConnector({
              id: `tree-${childConversation.id}`,
              source: endpoint(parentConversation, anchorRefs.current[childConversation.id], { conversationId: parentConversation.id, anchorId: childConversation.id }),
              target: endpoint(childConversation, branchOriginRefs.current[childConversation.id], { conversationId: childConversation.id }),
              active: activePathIds.has(childConversation.id),
            });
            if (connection) nextConnections.push(connection);
          }
        }

        // Minimized children drawn as nodes beside their document curve to them from their passage,
        // or from the document's header when they have none, like an open side document.
        for (const node of minimizedNodeElements) {
          const child = state.conversations[node.dataset.minimizedNodeId ?? ""];
          const parentConversation = child?.parentId ? state.conversations[child.parentId] : undefined;
          if (!child || !parentConversation) continue;
          const nodeRect = getElementRect(node);
          const listRect = getElementRect(node.closest(".minimized-child-nodes"));
          const viewport = nodeRect && listRect ? intersectConnectorRects(workspaceRect, listRect) : null;
          // A node's own children hang off its right edge, as on the map.
          const parentNode = node.dataset.minimizedNodeParent
            ? minimizedNodeElements.find((element) => element.dataset.minimizedNodeId === node.dataset.minimizedNodeParent) : undefined;
          if (parentNode) {
            const parentRect = getElementRect(parentNode);
            if (parentRect && nodeRect && viewport && intersectConnectorRects(parentRect, viewport) && intersectConnectorRects(nodeRect, viewport)) {
              nextConnections.push({ id: `minimized-${child.id}`, variant: "curve",
                active: node.closest<HTMLElement>("[data-document-id]")?.dataset.documentId === focusedConversation.id,
                start: { x: parentRect.right, y: parentRect.top + parentRect.height / 2 }, end: { x: nodeRect.left, y: nodeRect.top + nodeRect.height / 2 } });
            }
            continue;
          }
          const sourceElement = child.branchAnchor ? anchorRefs.current[child.id] : panelRefs.current[parentConversation.id]?.querySelector(".document-header");
          const connection = buildDocumentConnector({
            id: `minimized-${child.id}`,
            source: endpoint(parentConversation, sourceElement, { conversationId: parentConversation.id, anchorId: child.id }),
            target: { title: child.title || "Untitled document", target: { conversationId: child.id }, panel: nodeRect, viewport, anchor: nodeRect, markerViewport: viewport },
            active: parentConversation.id === focusedConversation.id,
          });
          if (connection) nextConnections.push(connection);
        }

        for (const conversation of Object.values(state.conversations)) {
          for (const link of conversation.document?.links ?? []) {
            const linked = getDocumentLinkTarget(link, state.conversations);
            if (!linked || link.sourceBlockId?.startsWith("detached:")) continue;
            const targetPanel = panelRefs.current[linked.conversation.id];
            if (!panelRefs.current[conversation.id] && !targetPanel) continue;
            const targetElement = link.targetBlockId
              ? Array.from(targetPanel?.querySelectorAll<HTMLElement>("[data-document-block-id]") ?? []).find((element) => element.dataset.documentBlockId === link.targetBlockId)
              : targetPanel?.querySelector(".document-header") ?? targetPanel?.querySelector("[data-document-block-id]") ?? targetPanel;
            const targetEndpoint = endpoint(linked.conversation, targetElement, { conversationId: linked.conversation.id, blockId: link.targetBlockId });
            if (linked.block) targetEndpoint.title = `${linked.conversation.title || "Untitled document"} · ${excerpt(linked.block.content.replace(/[#*_`]/g, ""), 48)}`;
            const connection = buildDocumentConnector({
              id: `link-${link.id}`,
              source: endpoint(conversation, anchorRefs.current[link.id], { conversationId: conversation.id, anchorId: link.id }),
              target: targetEndpoint,
              active: [conversation.id, linked.conversation.id].includes(state.activeConversationId),
            });
            if (connection) nextConnections.push(connection);
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

        setConnections((current) => JSON.stringify(current) === JSON.stringify(nextConnections) ? current : nextConnections);
        setConnectorOcclusionRects((current) => JSON.stringify(current) === JSON.stringify(nextOcclusionRects) ? current : nextOcclusionRects);
      });
    };

    requestUpdate();
    const layout = canvasRef.current?.closest<HTMLElement>(".document-workspace-layout");
    const resizeObserver = new ResizeObserver(requestUpdate);
    if (layout) resizeObserver.observe(layout);
    layout?.querySelectorAll(".document-workspace-dock, .document-workspace-scrolling, .document-body").forEach((element) => resizeObserver.observe(element));
    const mutationObserver = new MutationObserver(requestUpdate);
    if (layout) mutationObserver.observe(layout, { subtree: true, childList: true, characterData: true });
    window.addEventListener("resize", requestUpdate);
    window.addEventListener("scroll", requestUpdate, true);
    canvasRef.current?.addEventListener("scroll", requestUpdate);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
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
    state.documentDock,
    scrollingDocumentId,
    state.railOpen,
  ]);

  function clearPanelWidthOverride(conversationId: string) {
    setResizedPanelWidths((current) => {
      if (!(conversationId in current)) return current;
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
  }

  function restorePanelWidthOverride(resize: { conversationId: string; previousWidthOverride: number | undefined }) {
    if (resize.previousWidthOverride === undefined) clearPanelWidthOverride(resize.conversationId);
    else setResizedPanelWidths((current) => ({ ...current, [resize.conversationId]: resize.previousWidthOverride! }));
  }

  function handleResetChatPanelWidth(conversation: Conversation) {
    clearPanelWidthOverride(conversation.id);
    setState((current) => setDocumentWidth(current, conversation.id, undefined));
  }

  function handleChatPanelResizePointerDown(
    conversationId: string,
    edge: "left" | "right",
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
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window listeners also cover uncaptured pointers. */ }

    panelResizeStateRef.current = {
      conversationId,
      originWidth: info.width,
      previousWidthOverride: resizedPanelWidths[conversationId],
      latestWidth: info.width,
      startClientX: event.clientX,
      direction: edge === "left" ? -1 : 1,
      startScrollLeft: canvasRef.current?.scrollLeft ?? 0,
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
    edge: "left" | "right",
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const info = getPanelResizeInfo(conversation);
    const delta = event.key === "Home" ? -info.maxWidth
      : event.key === "End" ? info.maxWidth
        : (event.key === "ArrowRight" ? 1 : -1) * (edge === "left" ? -1 : 1) * CHAT_PANEL_KEYBOARD_STEP_PX;
    const next = resizeChatPanel({ ...info, delta });
    pendingPanelResizeScroll.current = (canvasRef.current?.scrollLeft ?? 0)
      + (edge === "left" ? next.width - info.width : 0);
    setResizedPanelWidths((current) => ({ ...current, [conversation.id]: next.width }));
    setState((current) => setDocumentWidth(current, conversation.id, next.width));
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

  function retractAssistantText(conversationId: string, messageId: string, text: string) {
    setState((current) => {
      const next = retractMessageText(current, conversationId, messageId, text);
      const conversation = next.conversations[conversationId];
      const generation = conversation?.document?.generations.find((item) => item.messageId === messageId);
      if (!generation?.acceptedAt) return next;
      const blocks = conversation.document!.blocks.map((block) => generation.blockIds.includes(block.id) && block.content.endsWith(text)
        ? { ...block, content: block.content.slice(0, -text.length) } : block);
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
    const conversation = remapDocumentLinks(before, { ...updated, messages: [...updated.messages, ...archived] });
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
          links: conversation.document.links,
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
    scheduleDocumentTitle(conversationId);
  }

  suggestDocumentTitleRef.current = (conversationId) => {
    const conversation = currentStateRef.current.conversations[conversationId];
    if (!conversation || !isPlaceholderDocumentTitle(conversation.title)) return null;
    const markdown = getEditableDocumentText(conversation);
    const local = suggestLocalDocumentTitle(markdown);
    if (!local) return null;
    const content = markdown.replace(/\s+/gu, " ").trim().slice(0, MAX_DOCUMENT_TITLE_CONTENT_LENGTH);
    // A few words are their own best name; only longer text is worth asking AI about.
    if (isHiddenFromAI(conversation) || content.length < 40) return { local, ai: null };
    return { local, ai: () => {
      const cached = suggestedDocumentTitles.current.get(conversationId);
      if (cached?.content === content) return cached.title;
      const title = requestDocumentTitle({ ai: normalizeAISettings(conversation.ai), content, expectedUserId: user.id })
        .finally(() => { void onRefreshBilling(); });
      suggestedDocumentTitles.current.set(conversationId, { content, title });
      title.catch(() => { if (suggestedDocumentTitles.current.get(conversationId)?.title === title) suggestedDocumentTitles.current.delete(conversationId); });
      return title;
    } };
  };

  function scheduleDocumentTitle(conversationId: string) {
    if (documentTitleRequests.current.has(conversationId)) return;
    clearTimeout(documentTitleTimers.current.get(conversationId));
    documentTitleTimers.current.set(conversationId, setTimeout(() => {
      documentTitleTimers.current.delete(conversationId);
      const conversation = currentStateRef.current.conversations[conversationId];
      const content = conversation && getDocumentTitleSource(conversation, provisionalDocumentTitles.current.get(conversationId));
      if (!conversation || !content) return;
      const placeholderTitle = conversation.title;
      const applyTitle = (title: string) => setState((current) => {
        const target = current.conversations[conversationId];
        // Never replace a title the user typed while the request was running.
        if (!target || target.title !== placeholderTitle) return current;
        const plainTitle = toPlainDocumentTitle(title, 80);
        if (!plainTitle) return current;
        provisionalDocumentTitles.current.delete(conversationId);
        return { ...current, conversations: { ...current.conversations, [conversationId]: { ...target, title: plainTitle } } };
      });
      // Without AI the document still gets a name: its first heading or sentence.
      const applyLocalTitle = () => {
        const latest = currentStateRef.current.conversations[conversationId];
        const local = latest ? suggestLocalDocumentTitle(getEditableDocumentText(latest)) : "";
        if (local) applyTitle(local);
      };
      // One attempt per document per session, so a failing provider is not retried on every keystroke.
      documentTitleRequests.current.add(conversationId);
      const canUseAI = user.role === "admin" || user.billing.hasAccess || user.apiKeys.hasAny;
      if (isHiddenFromAI(conversation) || !canUseAI) {
        applyLocalTitle();
        return;
      }
      void requestDocumentTitle({ ai: normalizeAISettings(conversation.ai), content, expectedUserId: user.id })
        .then(applyTitle, applyLocalTitle)
        .finally(() => { void onRefreshBilling(); });
    }, DOCUMENT_TITLE_IDLE_MS));
  }

  function handleMoveDocumentBlock(sourceId: string, blockId: string, targetId: string, beforeBlockId: string | null) {
    const updatedAt = new Date().toISOString();
    const movedBlockId = createId("block");
    setState((current) => {
      const next = transferDocumentBlock(current, sourceId, blockId, targetId, beforeBlockId, updatedAt, movedBlockId);
      if (next === current) return current;
      const focused = focusDocument(next, targetId);
      pendingMovedBlockFocus.current = { conversationId: targetId, blockId: movedBlockId };
      currentStateRef.current = focused;
      return focused;
    });
    setSelectionDraft((current) => current?.conversationId === sourceId && current.sourceBlockId === blockId ? null : current);
  }

  function handleDocumentSubmit(conversationId: string, request: DocumentAIRequest) {
    const source = currentStateRef.current.conversations[conversationId];
    if (!source || !request.prompt.trim() || chatExecutions.has(conversationId)) return;
    if (isHiddenFromAI(source)) {
      setDocumentErrors((current) => ({ ...current, [conversationId]: HIDDEN_FROM_AI_MESSAGE }));
      return;
    }
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
      ...(request.replaceSelection && sourceBlock ? {replacement: {blockId:sourceBlock.id,offset:request.from,content:sourceBlock.content.slice(request.from,request.to),authorship:getDocumentBlockAuthorship(sourceBlock,source.messages)}} : {}) };
    let prepared: Conversation = { ...target, messages: [...target.messages, userMessage], updatedAt: now,
      title: isPlaceholderDocumentTitle(target.title) ? excerpt(userMessage.content, 52) : target.title,
      document: { ...getEditableDocument(target), prompts: [...getEditableDocument(target).prompts, promptRecord], generations: [...getEditableDocument(target).generations, generation] } };
    if (!rerun) prepared = insertDocumentBlock(prepared, { id: outputBlockId, kind: "markdown", content: "", authorship: "ai", createdAt: now, updatedAt: now, sourceMessageId: messageId, generationId }, insertion, now);
    const targetId = prepared.id;
    if (prepared.title !== target.title || request.destination === "side") provisionalDocumentTitles.current.set(targetId, prepared.title);
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
    const requestMessage = buildDocumentAIMessage(source, userMessage, selectedQuote, { replaceSelection: request.replaceSelection });
    // A diagram the AI rewrites stays one Mermaid fence, whatever words come with it.
    const diagramReply = request.destination === "inline" && request.replaceSelection && isMermaidDiagramPassage(selectedQuote);
    chatExecutions.start({ conversationId: targetId, messageId, createdAt: now,
      request: async (onDelta, signal, onMetadata, onAgentEvent) => requestChatReply({
        ...prepareAIContext(currentStateRef.current.conversations, target, [requestMessage]),
        ai: withJevConsent(target.ai, jevEnabled), expectedUserId: user.id,
        conversation: await conversationRequestPayload(currentStateRef.current.conversations, target), messages: [requestMessage],
        modelId: target.modelId, serviceId: target.serviceId, onDelta, onMetadata, signal, acceptsDocuments: true,
        // Agent mode may ask a question or draft changes; both are shown under the reply in this document.
        acceptsQuestions: true, acceptsProposals: true, sourceDocumentId: source.id,
        ...(request.agentAnswer ? { agentAnswer: request.agentAnswer } : {}),
        // Pages agent mode imports become documents beside the one the user asked from.
        onAgentEvent: (event) => {
          if (event.type !== "documents") { onAgentEvent(event); return; }
          setState((current) => {
            const next = addImportedWebDocuments(current, source.id, event.documents, { createId }).state;
            currentStateRef.current = next;
            return next;
          });
        },
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
          const streamed = conversation.document.blocks.find((block)=>block.id===outputBlockId);
          const output = streamed && diagramReply && status === "complete" && streamed.content.trim() ? {...streamed,content:mermaidDiagramReply(streamed.content)} : streamed;
          const parts = output?.content ? splitDocumentMarkdown(output.content) : [];
          const completedBlocks = output && parts.length > 1 ? parts.map((content,index)=>({...output,id:index ? `${outputBlockId}:part:${index}` : outputBlockId,content})) : output ? [output] : [];
          return {...current,conversations:{...current.conversations,[targetId]:{...conversation,document:{...conversation.document,
            blocks:completedBlocks.length ? conversation.document.blocks.flatMap((block)=>block.id===outputBlockId?completedBlocks:[block]):conversation.document.blocks,
            generations:conversation.document.generations.map((item)=>item.id===generationId?{...item,status,...(completedBlocks.length ? {blockIds:completedBlocks.map((block)=>block.id)} : {})}:item),
          }}}};
        });
        // Title the document from its prompt and the AI's answer, not just the prompt excerpt.
        if (status === "complete") scheduleDocumentTitle(targetId);
        void onRefreshBilling();
      },
    });
  }

  /**
   * Asks the AI to change a diagram open in the Edit diagram dialog and returns its new Mermaid text.
   * The dialog shows the result; nothing reaches the document until the user saves the diagram.
   */
  async function handleAskDiagram(conversationId: string, request: DiagramAIRequest): Promise<string> {
    const conversation = currentStateRef.current.conversations[conversationId];
    if (!conversation) throw new Error("This document is no longer open.");
    if (isHiddenFromAI(conversation)) throw new Error(HIDDEN_FROM_AI_MESSAGE);
    const prompt: Message = { id: createId("message"), role: "user", content: request.prompt.trim(), createdAt: new Date().toISOString() };
    const message = buildDiagramAIMessage(conversation, prompt, request);
    try {
      const { reply } = await requestChatReply({
        ...prepareAIContext(currentStateRef.current.conversations, conversation, [message]),
        ai: withJevConsent(conversation.ai, jevEnabled), expectedUserId: user.id,
        conversation: await conversationRequestPayload(currentStateRef.current.conversations, conversation), messages: [message],
        modelId: conversation.modelId, serviceId: conversation.serviceId, signal: request.signal,
      });
      const source = findMermaidFences(mermaidDiagramReply(reply))[0]?.source.trim();
      if (!source) throw new Error("The AI didn't send back a diagram. Try asking another way.");
      return source;
    } catch (error) {
      if (isApiErrorStatus(error, 401)) onAuthExpired();
      else if (isApiErrorStatus(error, 402)) onBillingRequired(getErrorText(error, "Add money to continue using hosted AI."));
      throw error;
    } finally {
      void onRefreshBilling();
    }
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

  function handleCreateAIChildNodes(conversationId: string, proposals: AIChildNodeProposal[]) {
    setState((current) => {
      const next = addAIChildNodes(current, conversationId, proposals, { createId }).state;
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

  /**
   * Approve, dismiss or undo one change Agent mode proposed in the reply `messageId`. Returns why it
   * couldn't be done, or null. The decision is saved on the reply, so it shows the same after reload.
   */
  function handleAgentProposal(conversationId: string, messageId: string, proposalId: string, action: "approve" | "dismiss" | "undo"): string | null {
    const execution = currentStateRef.current.conversations[conversationId]?.messages.find((message) => message.id === messageId)?.execution;
    const proposal = execution?.agent?.proposals?.find((candidate) => candidate.id === proposalId);
    if (!execution || !proposal) return "This proposal is no longer available.";
    /** Saves the decision on the reply, in the same state update as the change it decides. */
    const decide = (current: AppState, update: Parameters<typeof withProposalUpdate>[2]): AppState => {
      const conversation = current.conversations[conversationId];
      const message = conversation?.messages.find((candidate) => candidate.id === messageId);
      if (!conversation || !message?.execution) return current;
      return { ...current, conversations: { ...current.conversations, [conversationId]: { ...conversation, updatedAt: new Date().toISOString(),
        messages: conversation.messages.map((candidate) => candidate === message ? { ...candidate, execution: withProposalUpdate(message.execution!, proposalId, update) } : candidate) } } };
    };
    const commit = (change: (current: AppState) => AppState | null, update: Parameters<typeof withProposalUpdate>[2]) => setState((current) => {
      const changed = change(current);
      if (!changed) return current;
      const next = decide(changed, update);
      currentStateRef.current = next;
      return next;
    });
    if (action === "dismiss") { commit((current) => current, { status: "dismissed" }); return null; }
    if (proposal.kind === "edit") {
      if (action === "undo" && !canUndoProposal(proposal)) return "This change can't be undone from here.";
      const target = currentStateRef.current.conversations[proposal.documentId];
      if (!target) return `Open \u201c${proposal.documentTitle || "that document"}\u201d first, then try again.`;
      if (chatExecutions.has(target.id)) return "AI is still writing in that document. Try again when it finishes.";
      const [find, replace] = action === "undo" ? undoEditArguments(proposal) : [proposal.find, proposal.replace];
      const updatedAt = new Date().toISOString();
      const checked = applyTextEdit(target, find, replace, updatedAt);
      if (checked === "missing") return action === "undo" ? "The changed text has been edited since, so it can't be undone automatically." : "That text has changed since the agent read it, so the edit can't be applied.";
      if (checked === "ambiguous") return "That text now appears more than once in the document, so the edit can't tell where to go.";
      // Approving several at once runs each update on the last one's result, so each edit is applied to the latest text.
      commit((current) => {
        const conversation = current.conversations[proposal.documentId];
        const updated = conversation ? applyTextEdit(conversation, find, replace, updatedAt) : "missing";
        return typeof updated === "string" ? null : replaceDocumentConversation(current, updated);
      }, action === "undo" ? {} : { status: "approved" });
      return null;
    }
    if (action === "undo") return "This change can't be undone from here.";
    if (!currentStateRef.current.conversations[proposal.parentId]) return `Open \u201c${proposal.parentTitle || "the parent document"}\u201d first, then try again.`;
    // IDs are made once, so the state update gives the same document however often it runs.
    const ids: Record<string, string> = { conversation: createId("conversation"), block: createId("block"), anchor: createId("anchor") };
    commit((current) => {
      const created = addAIChildNodes(current, proposal.parentId, [{ id: proposal.id, title: proposal.title, content: proposal.content, blockId: "", from: 0, to: 0 }],
        { createId: (prefix) => ids[prefix] ?? createId(prefix) });
      return created.createdIds.length ? created.state : null;
    }, { status: "approved", createdId: ids.conversation });
    return null;
  }

  function handleAISettingsChange(conversationId: string, ai: AISettings) {
    setState((current) => {
      const conversation = current.conversations[conversationId];
      if (!conversation) return current;
      return { ...current, conversations: { ...current.conversations, [conversationId]: { ...conversation, ai: normalizeAISettings(ai), updatedAt: new Date().toISOString() } } };
    });
  }

  function handleAgentModeChange(conversationId: string, next: { enabled: boolean; budgetMicros: number }) {
    const conversation = currentStateRef.current.conversations[conversationId];
    if (!conversation) return;
    const { agent: _agent, agentBudgetMicros: _budget, ...ai } = normalizeAISettings(conversation.ai);
    handleAISettingsChange(conversationId, next.enabled ? { ...ai, agent: true, agentBudgetMicros: next.budgetMicros } : ai);
    // The retired OpenAI Agent choice always runs as an agent; switching off moves it to plain OpenAI.
    if (!next.enabled && conversation.serviceId === "openai-agent") handleModelChange(conversationId, "openai-api", conversation.modelId);
  }

  function agentModeControls(conversation: Conversation): AgentModeControls {
    const ai = normalizeAISettings(conversation.ai);
    return {
      enabled: ai.agent === true || conversation.serviceId === "openai-agent",
      available: supportsAgentMode(conversation.serviceId),
      budgetMicros: ai.agentBudgetMicros,
      showBudget: user.role !== "admin",
      onChange: (next) => handleAgentModeChange(conversation.id, next),
    };
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

  /** The conversation for an AI request, with the PDF or image it is about when there is one. */
  async function conversationRequestPayload(conversations: Record<string, Conversation>, conversation: Conversation) {
    const payload = getConversationRequestPayload(conversations, conversation);
    const found = nearestVaultFile({ ...conversations, [conversation.id]: conversation }, conversation);
    return found ? { ...payload, file: await loadVaultFileContext(vault.media, found) } : payload;
  }

  function startAssistantStream(conversation: Conversation, messages: Message[]) {
    if (isHiddenFromAI(conversation)) {
      appendAssistantMessage(conversation.id, HIDDEN_FROM_AI_MESSAGE);
      return;
    }
    return chatExecutions.start({
      conversationId: conversation.id,
      messageId: createId("message"),
      createdAt: new Date().toISOString(),
      request: async (onDelta, signal, onMetadata, onAgentEvent) => requestChatReply({
        ...prepareAIContext(state.conversations, conversation, messages),
        ai: withJevConsent(conversation.ai, jevEnabled),
        expectedUserId: user.id,
        conversation: await conversationRequestPayload(state.conversations, conversation),
        messages,
        modelId: conversation.modelId,
        onDelta,
        onMetadata,
        onAgentEvent,
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
    const shouldGenerateTitle = isUntitledConversation && !isHiddenFromAI(conversation);
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
    if (!mobileKeyboard.mobile) window.getSelection()?.removeAllRanges();
    setSelectionDraft(draft);
    setSelectionIntent("branch");
    if (!mobileKeyboard.mobile) window.requestAnimationFrame(() => document.getElementById("branch-prompt")?.focus());
  }

  function handleModelChange(
    conversationId: string,
    serviceId: BackendServiceId,
    modelId: string,
  ) {
    const nextModelId = resolveBackendServiceModelId(serviceId, modelId);

    const updatedAt = new Date().toISOString();
    function applySelection(current: AppState): AppState {
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
                updatedAt,
              },
            },
      };
    }
    // Submission reads this ref, including before React commits a batched picker update.
    currentStateRef.current = applySelection(currentStateRef.current);
    setState(applySelection);

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
    // The document editor and the PDF viewer report their own selections.
    if ((range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest(".rich-document-editor, .vault-pdf-page")) return;
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

    const nextDraft: SelectionDraft = {
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
    };
    // Re-reading the same passage keeps what the toolbar has open and the prompt typed so far.
    const current = selectionDraftRef.current;
    if (isSameSelectedPassage(current, nextDraft)) {
      setSelectionDraft({ ...nextDraft, prompt: current!.prompt });
      return;
    }
    setSelectionDraft(nextDraft);
    setSelectionIntent("actions");
  }

  // On phones the app's selection bar replaces the system's Cut / Copy / Paste menu.
  useEffect(() => mobileKeyboard.mobile ? hideNativeSelectionMenu() : undefined, [mobileKeyboard.mobile]);

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

    function handleNativeSelectionChange() {
      window.cancelAnimationFrame(selectionSyncFrameRef.current);
      selectionSyncFrameRef.current = window.requestAnimationFrame(() => {
        if (selectionModelOpen || toolbarRef.current?.contains(document.activeElement)) return;
        // The compact prompt owns a saved passage after Ask. Blurring the
        // document to dismiss its keyboard must not discard that context.
        if (mobileKeyboard.mobile && selectionActionsExpanded && selectionIntent === "branch") return;
        // The selection is briefly lifted to dismiss the iOS edit menu; it is coming back.
        if (isReselectingSelection()) return;
        const selection = window.getSelection();
        // A diagram tapped in a document is selected without any text selected; the document clears it when focus moves on.
        if (selection?.isCollapsed && hasSelectedDiagramInFocus()) return;
        if (selection?.isCollapsed) setSelectionDraft(null);
        else syncSelectionDraft();
      });
    }
    document.addEventListener("selectionchange", handleNativeSelectionChange);
    document.addEventListener("mouseup", handleDocumentMouseUp);
    document.addEventListener("pointerup", handleDocumentPointerUp);
    document.addEventListener("keyup", handleDocumentKeyUp);

    return () => {
      window.cancelAnimationFrame(selectionSyncFrameRef.current);
      document.removeEventListener("selectionchange", handleNativeSelectionChange);
      document.removeEventListener("mouseup", handleDocumentMouseUp);
      document.removeEventListener("pointerup", handleDocumentPointerUp);
      document.removeEventListener("keyup", handleDocumentKeyUp);
    };
  }, [isMobileViewport, mobileKeyboard.mobile, selectionActionsExpanded, selectionIntent, selectionModelOpen, state.conversations]);

  function handleUpdateGraphNodeLayouts(
    nextLayouts: Record<string, Partial<GraphNodeLayout>>,
    options?: { replace?: boolean },
  ) {
    setState((current) => {
      const graphLayouts = mergeGraphNodeLayouts(current.conversations, current.graphLayouts, nextLayouts, options);
      return graphLayouts === current.graphLayouts ? current : { ...current, graphLayouts };
    });
  }

  /**
   * A passage selected across lines is saved in one block, so those lines join
   * before anything points at it. Returns null when the lines changed meanwhile.
   */
  function joinSelectedLines(draft: SelectionDraft): SelectionDraft | null {
    const { sourceBlockId, joinBlockIds } = draft;
    if (!sourceBlockId || !joinBlockIds?.length) return draft;
    const now = new Date().toISOString();
    const join = (current: AppState) => {
      const conversation = current.conversations[draft.conversationId];
      const document = conversation && getEditableDocument(conversation);
      const blocks = document && joinDocumentBlocks(document.blocks, sourceBlockId, joinBlockIds, conversation.messages, now);
      return blocks ? replaceDocumentConversation(current, { ...conversation, updatedAt: now, document: { ...document, blocks } }) : null;
    };
    const joined = join(currentStateRef.current);
    if (!joined || joined.conversations[draft.conversationId].document?.blocks.find((block) => block.id === sourceBlockId)?.content !== draft.sourceContent) {
      setDocumentErrors((current) => ({ ...current, [draft.conversationId]: "The passage changed. Select it again." }));
      setSelectionDraft(null);
      return null;
    }
    currentStateRef.current = joined;
    setState((current) => join(current) ?? current);
    return { ...draft, joinBlockIds: undefined };
  }

  function handleCreateBranch(promptOverride?: string) {
    const draft = selectionDraft && joinSelectedLines(selectionDraft);

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

    const parentConversation = currentStateRef.current.conversations[draft.conversationId];

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

  function handleSelectionQuickAction(prompt: string) {
    if (!selectionDraft || pendingConversationIds[selectionDraft.conversationId]) return;
    const draft = joinSelectedLines(selectionDraft);
    if (!draft) return;
    // Quick actions generate a reviewable side document, regardless of options
    // left over from an earlier custom request. The selected source stays intact.
    if (draft.sourceBlockId) {
      handleDocumentSubmit(draft.conversationId, {
        blockId: draft.sourceBlockId, from: draft.startOffset, to: draft.endOffset,
        quote: draft.quote, sourceContent: draft.sourceContent, prompt,
        destination: "side", replaceSelection: false,
      });
    } else handleCreateBranch(prompt);
  }

  function openMobileSelectionPrompt(showOptions = true) {
    setSelectionIntent("branch");
    setSelectionOptionsInitiallyOpen(showOptions);
    setSelectionActionsExpanded(true);
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.matches("[contenteditable='true'], input, textarea")) active.blur();
  }

  function handleCreateDocumentLink(target: { conversationId: string; blockId?: string }) {
    const draft = selectionDraft && joinSelectedLines(selectionDraft);
    if (!draft) return;
    const source = currentStateRef.current.conversations[draft.conversationId];
    const destination = currentStateRef.current.conversations[target.conversationId];
    const link = source && createDocumentLink(source, destination, draft, target.blockId);
    if (!link || !destination) {
      setSelectionLinkError("This passage or destination has changed. Select the text again and choose a current destination.");
      return;
    }
    setState((current) => ({ ...current, conversations: {
      ...current.conversations,
      [source.id]: addDocumentLink(current.conversations[source.id], link),
    } }));
    setDocumentLinkNotice({ message: `Linked to ${destination.title || "Untitled document"}${target.blockId ? " · block" : ""}`,
      conversationId: destination.id, blockId: target.blockId });
    setSelectionDraft(null);
    setSelectionLinkError(null);
    window.getSelection()?.removeAllRanges();
  }

  function handleRemoveDocumentLink(conversationId: string, linkId: string) {
    setState((current) => {
      const source = current.conversations[conversationId];
      if (!source) return current;
      return { ...current, conversations: { ...current.conversations, [source.id]: removeDocumentLink(source, linkId) } };
    });
    setDocumentLinkNotice({ message: "Link removed" });
  }

  function handleNavigateDocumentConnector(target: { conversationId: string; blockId?: string; anchorId?: string }) {
    const conversation = state.conversations[target.conversationId];
    if (!conversation) return;
    const anchor = target.anchorId
      ? conversation.document?.links?.find((link) => link.id === target.anchorId) ?? state.conversations[target.anchorId]?.branchAnchor
      : undefined;
    const blockId = target.blockId ?? anchor?.sourceBlockId;
    if (blockId || anchor) {
      handleOpenSearchSource({ conversationId: conversation.id, sourceKind: blockId ? "document" : "message",
        sourceBlockId: blockId, messageId: anchor?.sourceMessageId,
        quote: anchor?.quote, startOffset: anchor?.startOffset, endOffset: anchor?.endOffset });
    } else handleSelectConversation(conversation.id, { nextViewMode: "chat" });
  }

  function handleOpenDocumentReference(sourceId: string, referenceId: string) {
    const link = state.conversations[sourceId]?.document?.links?.find((item) => item.id === referenceId);
    if (!link) { handleSelectConversation(referenceId); return; }
    const target = getDocumentLinkTarget(link, state.conversations);
    if (target) handleNavigateDocumentConnector({ conversationId: target.conversation.id, blockId: target.block?.id });
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
    title?: string;
  }) {
    const now = new Date().toISOString();
    const id = createId("document");
    const note: ConversationNote = { id, content: args.content, kind: "comment",
      sourceMessageId: args.sourceMessageId, sourceBlockId: args.sourceBlockId,
      startOffset: args.startOffset ?? null, endOffset: args.endOffset ?? null,
      quote: args.quote ?? null, createdAt: now, updatedAt: now };
    setState((current) => {
      const original = current.conversations[args.conversationId];
      if (!original) return current;
      const parent = { ...original, document: getEditableDocument(original),
        childIds: [...original.childIds, id], updatedAt: now };
      const child = { ...createMarginDocument(parent, note), ...(args.title ? { title: args.title } : {}) };
      return focusDocument({ ...current, conversations: { ...current.conversations, [parent.id]: parent, [id]: child } }, id);
    });
    setClosedMarginNotes((current) => ({ ...current, [args.conversationId]: false }));
    setDocumentFocusSequence((sequence) => sequence + 1);
    return id;
  }

  function handleToggleMarginPresentation(conversationId: string) {
    const conversation = state.conversations[conversationId];
    if (!conversation?.document?.marginNote) return;
    const display = isCompactDocument(conversation) ? "full" : "compact";
    setState((current) => {
      const target = current.conversations[conversationId];
      if (!target?.document?.marginNote) return current;
      const next = focusDocument({ ...current, conversations: { ...current.conversations, [conversationId]: {
        ...target, updatedAt: new Date().toISOString(), document: { ...target.document,
          marginNote: { ...target.document.marginNote, display } },
      } } }, conversationId);
      // A note expanded into a pane opens next to its parent, like any newly opened child.
      return display === "full" ? placeDocumentAfterParent(next, conversationId) : next;
    });
    if (conversation.parentId) setClosedMarginNotes((current) => ({ ...current, [conversation.parentId!]: false }));
    setDocumentFocusSequence((sequence) => sequence + 1);
  }

  /**
   * A margin note that outgrew the margin becomes a side document: the same document, id and text,
   * minus its margin-note flag. Its passage link carries over, and it opens right after its host, ready to write in.
   */
  function handleMoveMarginNoteToSideDocument(conversationId: string) {
    const conversation = state.conversations[conversationId];
    if (!conversation?.document?.marginNote) return;
    setState((current) => {
      const target = current.conversations[conversationId];
      if (!target?.document?.marginNote) return current;
      const next = focusDocument({ ...current, conversations: { ...current.conversations,
        [conversationId]: marginNoteToSideDocument(target) } }, conversationId);
      return placeDocumentAfterParent(next, conversationId);
    });
    // The menu click focused the host pane first; the new pane should still scroll into view.
    suppressNextChatAutoCenterRef.current = false;
    setDocumentFocusSequence((sequence) => sequence + 1);
    focusNewDocumentEditor(conversationId);
  }

  function handleResizeMarginDocument(conversationId: string, size: MarginDocumentSize) {
    setState((current) => {
      const target = current.conversations[conversationId];
      if (!target?.document?.marginNote) return current;
      return { ...current, conversations: { ...current.conversations, [conversationId]: {
        ...target, updatedAt: new Date().toISOString(), document: { ...target.document,
          marginNote: { ...target.document.marginNote, size } },
      } } };
    });
  }

  /** Puts the cursor at the end of a newly created document once its editor mounts. */
  function focusNewDocumentEditor(documentId: string) {
    let attempts = 0;
    const focus = () => {
      const host = [...document.querySelectorAll<HTMLElement>("[data-document-id]")].find((element) => element.dataset.documentId === documentId);
      const editable = host?.querySelector<HTMLElement>("[contenteditable='true'], textarea");
      if (!editable) { if (attempts++ < 30) window.requestAnimationFrame(focus); return; }
      editable.focus({ preventScroll: true });
      if (editable instanceof HTMLTextAreaElement) { editable.setSelectionRange(editable.value.length, editable.value.length); return; }
      const range = document.createRange();
      range.selectNodeContents(editable);
      range.collapse(false);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    };
    window.requestAnimationFrame(focus);
  }

  /** The phone's + menu acts on the selection, else the paragraph at the caret, else the whole document. */
  function prepareCreateMenu(): MobileCreateTarget {
    if (selectionDraft?.conversationId === activeConversation.id) { createMenuPassage.current = selectionDraft; return "selection"; }
    const paragraph = caretParagraphIn(activeConversation.id);
    createMenuPassage.current = paragraph ? { ...paragraph, prompt: "", sourceKind: "message", sourceContent: paragraph.quote } : null;
    return paragraph ? "paragraph" : "document";
  }
  function handleCreateMenuSideDocument() {
    if (createMenuPassage.current) handleCreateSelectionSideDocument(createMenuPassage.current);
    else handleAddSideChat(activeConversation.id);
  }
  function handleCreateMenuNote() {
    if (createMenuPassage.current) { handleCreateSelectionNote(createMenuPassage.current); return; }
    focusNewDocumentEditor(handleCreateNote({ conversationId: activeConversation.id, content: "", sourceMessageId: null }));
  }

  /** Files picked from the + menu join the vault; one document opens right away. */
  function handleCreateMenuUpload(files: File[]) {
    setUploadNotice({ message: files.length === 1 ? `Adding “${files[0]!.name}”…` : `Adding ${files.length} files…`, kind: "info" });
    vault.uploadFiles(files).then(({ added, documentIds, summary }) => {
      setUploadNotice({ message: summary || "Nothing was added.", kind: added.length ? "success" : "error" });
      if (documentIds.length === 1) handleSelectConversation(documentIds[0]!, { nextViewMode: "chat" });
    }, (failure: unknown) => {
      setUploadNotice({ message: failure instanceof Error ? failure.message : "Those files couldn’t be added. Try again.", kind: "error" });
    });
  }

  function closeSelectionDraft() {
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
  }

  /** Mark the selected passage with a highlight, or take the mark off when it already has one. */
  function handleToggleSelectionHighlight() {
    if (!selectionDraft?.sourceBlockId) return;
    const draft = joinSelectedLines(selectionDraft);
    if (!draft?.sourceBlockId) return;
    const conversation = currentStateRef.current.conversations[draft.conversationId];
    const document = conversation ? getEditableDocument(conversation) : null;
    const block = document?.blocks.find((item) => item.id === draft.sourceBlockId);
    const content = block && block.content.slice(draft.startOffset, draft.endOffset) === draft.quote
      ? toggleMarkdownHighlight(block.content, draft.startOffset, draft.endOffset) : null;
    if (!conversation || !document || !block || content === null) {
      setDocumentErrors((current) => ({ ...current, [draft.conversationId]: "That passage can't be highlighted. Select plain text within one paragraph." }));
      closeSelectionDraft();
      return;
    }
    const now = new Date().toISOString();
    const updated = { ...conversation, updatedAt: now, document: { ...document,
      blocks: document.blocks.map((item) => item.id === block.id ? { ...item, content, updatedAt: now } : item) } };
    setState((current) => {
      const next = replaceDocumentConversation(current, updated);
      currentStateRef.current = next;
      return next;
    });
    closeSelectionDraft();
  }

  /** Search the vault for the selected passage. */
  function handleFindRelatedToSelection(passage: SelectionDraft | null = selectionDraft) {
    if (!passage) return;
    setSearchQuery(passage.quote.replace(/\s+/g, " ").trim().slice(0, 200));
    closeSelectionDraft();
    handleOpenSearch();
  }

  /** A side document about the selected passage, without AI: the passage is quoted at the top and linked back. */
  function handleCreateSelectionSideDocument(passage: SelectionDraft | null = selectionDraft) {
    if (!passage) return;
    const draft = joinSelectedLines(passage);
    if (!draft) return;
    const source = currentStateRef.current.conversations[draft.conversationId];
    if (!source) return;
    const sourceDocument = source.document ? getEditableDocument(source) : null;
    const sourceBlock = draft.sourceBlockId ? sourceDocument?.blocks.find((block) => block.id === draft.sourceBlockId) : undefined;
    if (!sourceBlock && hasOverlappingAnchor(currentStateRef.current.conversations, draft)) {
      window.alert("That highlight overlaps an existing branch. Try a different phrase for now.");
      return;
    }
    const now = new Date().toISOString();
    const id = createId("conversation");
    const quote = draft.quote.trim();
    const sideDocument: Conversation = {
      id, kind: "chat", title: excerpt(quote.replace(/\s+/g, " "), 52) || "Untitled document", parentId: source.id,
      serviceId: source.serviceId, modelId: source.modelId, ...(source.ai ? { ai: structuredClone(source.ai) } : {}),
      documents: [...(source.documents ?? [])],
      branchAnchor: { id: createId("anchor"), sourceConversationId: source.id,
        sourceMessageId: sourceBlock ? sourceBlock.sourceMessageId ?? `document:${sourceBlock.id}` : draft.messageId,
        ...(sourceBlock ? { sourceBlockId: sourceBlock.id } : {}),
        startOffset: draft.startOffset, endOffset: draft.endOffset, quote: draft.quote, prompt: "Side document", createdAt: now },
      childIds: [], messages: [], notes: [], createdAt: now, updatedAt: now,
      document: { schemaVersion: 1, prompts: [], generations: [], blocks: [{ id: createId("block"), kind: "markdown",
        content: quote.split(/\r?\n/).map((line) => line.trim() ? `> ${line}` : ">").join("\n"), authorship: "user", createdAt: now, updatedAt: now }] },
    };
    setState((current) => {
      const parent = current.conversations[source.id];
      if (!parent) return current;
      // A document block the passage points into is saved as a source message, as the AI path does.
      const snapshot = sourceBlock && !sourceBlock.sourceMessageId && sourceBlock.content.trim() && !parent.messages.some((message) => message.id === `document:${sourceBlock.id}`)
        ? [{ id: `document:${sourceBlock.id}`, role: "user" as const, content: sourceBlock.content, createdAt: sourceBlock.createdAt }] : [];
      const base = snapshot.length ? { ...current, conversations: { ...current.conversations, [parent.id]: { ...parent, messages: [...parent.messages, ...snapshot] } } } : current;
      const next = addChildConversation(base, sideDocument, { activate: true, sourceNoteId: draft.sourceNoteId });
      currentStateRef.current = next;
      return next;
    });
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
    setDocumentFocusSequence((sequence) => sequence + 1);
    focusNewDocumentEditor(id);
  }

  /** An empty margin note on the selected passage, open and ready to write in. */
  function handleCreateSelectionNote(passage: SelectionDraft | null = selectionDraft) {
    if (!passage) return;
    const draft = joinSelectedLines(passage);
    if (!draft) return;
    const noteId = handleCreateNote({
      content: "",
      // An empty note is named after its passage, so it can be told apart in lists.
      title: excerpt(draft.quote.trim().replace(/\s+/g, " "), 52) || undefined,
      conversationId: draft.conversationId,
      kind: "comment",
      sourceMessageId: draft.messageId,
      startOffset: draft.startOffset,
      endOffset: draft.endOffset,
      quote: draft.quote,
      sourceStandaloneNoteId: draft.sourceNoteId,
      sourceBlockId: draft.sourceBlockId,
    });
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
    focusNewDocumentEditor(noteId);
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
    setSearchExploreOpen(false);
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
    setMapEditMessage(existing ? `${existing.title} is already in your map.` : `${topic.label} added to your map.`);
  }

  /** Turns map previews into notes, each connected to what it was explored from. Returns the note each became. */
  function handleKeepExplored(exploration: MapExploration, ids: string[], detached: string[] = []): Record<string, string> {
    const identities = new Map<string, { id: string; noteId: string }>();
    const options = { createdAt: new Date().toISOString(), detached,
      newNote: (itemId: string) => {
        if (!identities.has(itemId)) identities.set(itemId, { id: createId("note-conversation"), noteId: createId("note") });
        return identities.get(itemId)!;
      } };
    const { kept } = keepExploredItems(state, exploration, ids, options);
    const keptIds = Object.keys(kept);
    if (!keptIds.length) return kept;
    setState((current) => keepExploredItems(current, exploration, ids, options).state);
    mapUndoRef.current = null;
    setMapEditMessage(keptIds.length === 1 ? `${exploration.items[keptIds[0]]?.label ?? "The preview"} is now a note in your map.` : `${keptIds.length} previews are now notes in your map.`);
    if (keptIds.length === 1) setGraphFocusRequest({ conversationId: kept[keptIds[0]], requestId: ++graphFocusRequestCounterRef.current, preserveMapMode: true });
    return kept;
  }

  /** Adds a page of Wikipedia connections to a note, adopting the matched article as its topic. */
  function handleAddTopicConnections(conversationId: string, expansion: PublicExpansion): number {
    const createdAt = new Date().toISOString();
    const topics = new Map(expansion.topics.map((topic) => [topic.id, topic]));
    const connections = expansion.relations.flatMap((relation) => relation.sourceId === expansion.topic.id && topics.has(relation.targetId)
      ? [{ topic: topics.get(relation.targetId)!, kind: wikipediaConnectionKind(relation.propertyId), note: `Wikipedia · ${relation.label}${relation.wikidata ? ` · Wikidata: ${wikidataStatement(relation, expansion.topic.label, topics.get(relation.targetId)!.label)}` : ""}` }] : []);
    const apply = (current: AppState) => {
      const conversation = current.conversations[conversationId];
      if (!conversation) return { state: current, added: 0 };
      const withTopic = conversation.publicTopic ? current
        : findSavedPublicTopic(current.conversations, expansion.topic) ? current
        : { ...current, conversations: { ...current.conversations, [conversationId]: { ...conversation, publicTopic: { ...expansion.topic, aliases: [...expansion.topic.aliases] } } } };
      return connectPublicTopics(withTopic, conversationId, connections, { createdAt, origin: "import" });
    };
    const { added } = apply(state);
    if (added) setState((current) => apply(current).state);
    mapUndoRef.current = null;
    setMapEditMessage(added ? `${added} Wikipedia topics connected to ${state.conversations[conversationId]?.title}.` : "Those Wikipedia topics are already connected.");
    return added;
  }

  /** Saves a private AI answer as a child note (or a new note when there is no parent), with its related topics connected to it. */
  function handleSavePrivateAnswer(conversationId: string | null, answer: PrivateAnswer) {
    if (conversationId && !state.conversations[conversationId]) return;
    const id = createId("note-conversation");
    const noteId = createId("note");
    const createdAt = new Date().toISOString();
    const content = `> AI answer to “${answer.question.replace(/\s+/g, " ")}”. Review before relying on it.\n\n${answer.answer}`;
    setState((current) => {
      if (conversationId && !current.conversations[conversationId]) return current;
      const next = conversationId
        ? addMapChildNote(current, { parentId: conversationId, id, noteId, createdAt, title: answer.question.slice(0, 100), content, activate: false })
        : createMapNote(current, { id, noteId, createdAt, title: answer.question.slice(0, 100), content });
      return connectPublicTopics(next, id, answer.related.map((topic) => ({
        topic: { id: topic.id, aliases: [], label: topic.label, description: topic.description, wikidataUrl: `https://www.wikidata.org/wiki/${topic.id}`, wikipediaUrl: wikipediaArticleUrl(topic.label), retrievedAt: createdAt },
        kind: "related" as const, note: topic.relation,
      })), { createdAt, origin: "ai" }).state;
    });
    mapUndoRef.current = null;
    setMapEditMessage(`Answer saved as a note${conversationId ? ` under ${state.conversations[conversationId]?.title}` : ""}${answer.related.length ? ", with its topics connected" : ""}.`);
  }

  function handleCreateMapNote(args: { linkedTo?: string; url?: string; position?: { x: number; y: number } }) {
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

  function handleSetMapRelation(args: { sourceId: string; targetId: string; type: DocumentRelationTypeId | null; previousType: DocumentRelationTypeId | null; remove?: boolean }) {
    const now = new Date().toISOString();
    if (setDocumentRelation(state, { ...args, updatedAt: now }) === state) return;
    const previous = [args.sourceId, args.targetId].flatMap((id) => state.conversations[id] ? [{ id,
      relations: state.conversations[id].relations, linkedConversationIds: state.conversations[id].linkedConversationIds }] : []);
    setState((current) => setDocumentRelation(current, { ...args, updatedAt: now }));
    mapUndoRef.current = (current) => restoreDocumentConnections(current, previous, new Date().toISOString());
    const label = args.type ? getDocumentRelationType(args.type)?.label.toLowerCase() : null;
    setMapEditMessage(args.remove ? "Relation removed. Both documents are still in your workspace."
      : label ? `Saved: ${state.conversations[args.sourceId]?.title} ${label} ${state.conversations[args.targetId]?.title}.` : "Saved as an untyped connection.");
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
    setSearchExploreOpen(false);
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
    setSearchExploreOpen(false);
  }

  /** Without a mode, focus the result as search always has; with one, follow Expand here / Open beside. */
  function openSearchConversation(conversationId: string, mode?: VaultSearchOpenMode) {
    if (!mode || mainViewMode !== "chat") handleSelectConversation(conversationId, { nextViewMode: "chat" });
    else if (mode === "beside") handleOpenDocumentBeside(conversationId);
    else handleExpandDocumentHere(conversationId);
  }

  function handleOpenSearchSource(source: SearchEvidenceRef, mode?: VaultSearchOpenMode) {
    if (source.sourceKind === "annotation" && source.noteId) {
      const migrated = Object.values(state.conversations).find((item) => item.parentId === source.conversationId && item.document?.marginNote?.legacyNoteId === source.noteId);
      if (migrated) {
        handleOpenSearchSource({ ...source, conversationId: migrated.id, sourceKind: "document",
          sourceBlockId: migrated.document!.blocks[0]?.id, noteId: undefined, messageId: undefined }, mode);
        return;
      }
    }
    if (resolveSearchSource(state.conversations, source).status === "missing") return;
    setSearchModalOpen(false);
    setSearchExploreOpen(false);
    openSearchConversation(source.conversationId, mode);
    setSearchSourceRequest((current) => ({ source, sequence: (current?.sequence ?? 0) + 1 }));
  }

  function handleOpenVaultSearchDocument(hit: VaultSearchDocumentHit, mode: VaultSearchOpenMode) {
    const target = hit.target;
    if (target.kind === "cloud") {
      // Still in the cloud: download it, then show it, as the cloud list does.
      void vault.openCloudDocument(target.path).then(() => {
        handleCloseSearch();
        setMainViewMode("chat");
        if (isMobileViewport) setLeftSidebarOpen(false);
      }).catch(() => undefined);
      return;
    }
    handleCloseSearch();
    openSearchConversation(target.conversationId, mode);
  }

  function handleOpenVaultSearchPassage(hit: VaultSearchPassageHit, mode: VaultSearchOpenMode) {
    if (hit.cloudPath && !state.conversations[hit.conversationId]) {
      // Still in the cloud: download it, then show the passage.
      void vault.openCloudDocument(hit.cloudPath).then(() => {
        handleCloseSearch();
        setMainViewMode("chat");
        if (isMobileViewport) setLeftSidebarOpen(false);
        setSearchSourceRequest((current) => ({ source: hit.evidence, sequence: (current?.sequence ?? 0) + 1 }));
      }).catch(() => undefined);
      return;
    }
    handleOpenSearchSource(hit.evidence, mode);
  }

  function handleSelectSearchResult(conversationId: string) {
    handleCloseSearch();
    handleSelectConversation(conversationId, { nextViewMode: "chat" });
  }

  function handleFocusVisibleDocument(conversationId: string) {
    if (currentStateRef.current.activeConversationId === conversationId) return;
    // Clicking into an already visible editor must not scroll it away from the pointer.
    suppressNextChatAutoCenterRef.current = true;
    setState((current) => focusDocument(current, conversationId, false));
  }

  function handleMinimizeDocument(conversationId: string) {
    if (selectionDraft?.conversationId === conversationId) setSelectionDraft(null);
    setState((current) => minimizeDocument(current.documentDock ? {
      ...current, documentDock: { ...current.documentDock, tree: removePinnedDocument(current.documentDock.tree, conversationId) },
    } : current, conversationId));
  }

  function handleCloseDocument(conversationId: string) {
    if (selectionDraft?.conversationId === conversationId) setSelectionDraft(null);
    setState((current) => closeDocument(current.documentDock ? {
      ...current, documentDock: { ...current.documentDock, tree: removePinnedDocument(current.documentDock.tree, conversationId) },
    } : current, conversationId));
  }

  function handleHideAllDocuments(action: "minimize" | "close") {
    // Snapshot the tabs before changing focus or removing pinned panes.
    const ids = tabDocuments.map((document) => document.id);
    if (!ids.length) return;
    setSelectionDraft(null);
    setScrollingDocumentId(workspaceFocusId);
    setState((current) => {
      const hide = action === "close" ? closeDocument : minimizeDocument;
      let next = current;
      for (const id of ids) {
        if (next.documentDock) next = { ...next, documentDock: { ...next.documentDock,
          tree: removePinnedDocument(next.documentDock.tree, id) } };
        next = hide(next, id);
      }
      // Keep the same document family on screen instead of switching to a closed pin's family.
      const family = getDocumentWorkspace(next.conversations, workspaceFocusId);
      return family.root ? { ...next, activeConversationId: workspaceFocusId, rootId: family.root.id } : next;
    });
  }

  function handleToggleDocumentPin(conversationId: string) {
    setSelectionDraft(null);
    revealMarginAncestors(conversationId);
    const body = panelRefs.current[conversationId]?.querySelector<HTMLElement>(".document-body");
    if (body) panelScrollPositionsRef.current[conversationId] = body.scrollTop;
    setState((current) => {
      if (!current.conversations[conversationId]) return current;
      const dock = normalizeDocumentDock(current.documentDock, current.conversations);
      const tree = dock?.tree ?? null;
      if (listPinnedDocumentIds(tree).includes(conversationId)) {
        return { ...current, documentDock: { ...dock, width: dock?.width ?? 0.4, tree: removePinnedDocument(tree, conversationId) } };
      }
      // Pinning also restores a minimized document, without changing the active editor.
      const restored = focusDocument(current, conversationId, false);
      return { ...restored, activeConversationId: current.activeConversationId, rootId: current.rootId,
        documentDock: { ...dock, width: dock?.width ?? 0.4, tree: addPinnedDocument(tree, conversationId) } };
    });
  }

  function handleToggleDocumentPinScope(conversationId: string) {
    function toggle(node: DocumentDockNode | null): DocumentDockNode | null {
      if (!node) return null;
      if (node.type === "pane") return node.documentId === conversationId
        ? { ...node, scope: node.scope === "family" ? "workspace" : "family" } : node;
      return { ...node, first: toggle(node.first)!, second: toggle(node.second)! };
    }
    setState((current) => {
      const dock = normalizeDocumentDock(current.documentDock, current.conversations);
      if (!dock) return current;
      const next = { ...current, documentDock: { ...dock, tree: toggle(dock.tree) } };
      return current.activeConversationId === conversationId && !familyPinnedDocumentIds.includes(conversationId)
        && !familyDocumentIds.has(conversationId) ? focusDocument(next, workspaceFocusId, false) : next;
    });
  }

  function revealMarginAncestors(conversationId: string) {
    setClosedMarginNotes((current) => {
      const next = { ...current };
      for (const item of getConversationPath(state.conversations, conversationId)) {
        if (item.parentId && isCompactDocument(item)) next[item.parentId] = false;
      }
      return next;
    });
  }

  function handleSelectConversation(
    conversationId: string,
    options: {
      nextViewMode?: MainViewMode;
      preserveRail?: boolean;
      keepSidebarOpen?: boolean;
      /** False focuses only this document (tabs, breadcrumbs) instead of reopening its closed ancestors. */
      restorePath?: boolean;
      /** Expand here: this document takes the replaced document's place, which closes. */
      replaceId?: string;
    } = {},
  ) {
    revealMarginAncestors(conversationId);
    suppressNextChatAutoCenterRef.current = false;
    if (!pinnedDocumentIds.includes(conversationId) || familyPinnedDocumentIds.includes(conversationId)) {
      setScrollingDocumentId(conversationId);
    }
    setDocumentFocusSequence((sequence) => sequence + 1);
    setSelectionDraft(null);
    // A caret in the editor you're typing in stays (clicking a highlight there opens its document); selected text clears.
    const selection = window.getSelection();
    const active = window.document.activeElement;
    if (!(selection?.isCollapsed && active instanceof HTMLElement && active.isContentEditable && selection.anchorNode && active.contains(selection.anchorNode))) selection?.removeAllRanges();
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
          ...(options.replaceId ? replaceDocument(current, options.replaceId, conversationId)
            : options.restorePath === false ? showDocument(current, conversationId)
            : focusDocument(current, conversationId)),
          railOpen: options.preserveRail ? current.railOpen : false,
        };
      });
    });

    if (isMobileViewport && !options.keepSidebarOpen) {
      setLeftSidebarOpen(false);
    }
  }

  /** Leave the active session as it is and pick up another where it was left. */
  function handleSwitchSession(sessionId: string) {
    const current = currentStateRef.current;
    if (current.sessions?.activeId === sessionId) return;
    const { state: next, documentId } = switchSession(current, sessionId);
    if (next === current) return;
    currentStateRef.current = next;
    setState(next);
    setMaximizedDocumentId(null);
    if (documentId) handleSelectConversation(documentId, { nextViewMode: "chat" });
    // An empty session starts with a fresh document rather than borrowing the one on screen.
    else handleCreateMainConversation();
  }

  function handleCreateSession(name?: string) {
    const { state: next } = createSession(currentStateRef.current, undefined, { name });
    currentStateRef.current = next;
    setState(next);
    setMaximizedDocumentId(null);
    handleCreateMainConversation();
  }

  function handleDeleteSession(sessionId: string) {
    const { state: next, switchTo } = deleteSession(currentStateRef.current, sessionId);
    currentStateRef.current = next;
    setState(next);
    if (switchTo) handleSwitchSession(switchTo);
    else if (!next.sessions?.activeId) handleCreateSession();
  }

  /** Move to a neighbour the way the navigator offers it: siblings take this pane's place, others focus. */
  function handleOpenNeighbor(conversationId: string, relation: NeighborRelation) {
    // A sibling already open or minimized comes back in its own place; others take this pane's place.
    const workspace = getDocumentWorkspace(state.conversations, conversationId);
    const open = isDocumentOnScreen(conversationId) || workspace.minimizedIds.includes(conversationId);
    if (relation === "sibling" && !open) handleSwitchDocumentInPlace(activeConversation.id, conversationId);
    else handleSelectConversation(conversationId, { nextViewMode: "chat" });
  }

  function handleChangeNavigationStyle(style: DocumentNavigationStyle) {
    setNavigationStyle(style);
    saveDocumentNavigationStyle(style);
    if (style === "graph") openMapModal();
    else setMapModalOpen(false);
  }

  function openMapModal() {
    setMapModalOpen(true);
    setGraphFocusRequest({ conversationId: activeConversation.id, requestId: ++graphFocusRequestCounterRef.current, neighborhoodDepth: 2, preserveMapMode: true });
  }

  /** Scrolling panes, pinned panes and the margin notes shown beside them. */
  function getOnScreenDocumentIds() {
    const ids = new Set([...visiblePinnedDocumentIds, ...scrollingDocuments.map((document) => document.id)]);
    function addNotes(conversation: Conversation) {
      if (closedMarginNotes[conversation.id]) return;
      for (const note of getMarginDocuments(conversation)) { ids.add(note.id); addNotes(note); }
    }
    for (const id of [...ids]) if (state.conversations[id]) addNotes(state.conversations[id]);
    return ids;
  }

  function isDocumentOnScreen(conversationId: string) {
    return getOnScreenDocumentIds().has(conversationId);
  }

  /** Expand here: like a browser tab, the focused document's place goes to the chosen document. */
  function handleExpandDocumentHere(conversationId: string) {
    handleSwitchDocumentInPlace(activeConversation.id, conversationId);
  }

  /** The target document takes `currentId`'s place, as Expand here does for the focused document. */
  function handleSwitchDocumentInPlace(currentId: string, conversationId: string) {
    const target = state.conversations[conversationId];
    if (!target || conversationId === currentId) return;
    // Visible documents, compact notes and pinned panes keep their places; focus moves to them.
    if (isDocumentOnScreen(conversationId) || isCompactDocument(target) || pinnedDocumentIds.includes(currentId)) {
      handleSelectConversation(conversationId, { restorePath: false });
      return;
    }
    setDocumentHistory((history) => recordDocumentNavigation(history, currentId, conversationId));
    handleSelectConversation(conversationId, { replaceId: currentId });
  }

  /** Open beside: show a document next to the focused one while focus stays put. */
  function handleOpenDocumentBeside(conversationId: string) {
    const anchorId = activeConversation.id;
    if (!state.conversations[conversationId] || conversationId === anchorId) return;
    revealMarginAncestors(conversationId);
    if (!isDocumentOnScreen(conversationId)) {
      const anchorPinned = pinnedDocumentIds.includes(anchorId);
      const hostId = getMarginHostPath(state.conversations, conversationId)[0];
      // A pinned document has no place in the scrolling strip, so the strip shows the target's family.
      if (anchorPinned && !pinnedDocumentIds.includes(hostId)) setScrollingDocumentId(hostId);
      setState((current) => openDocumentBeside(current, anchorPinned ? null : anchorId, conversationId));
    }
    setBesideRequest((current) => ({ id: conversationId, sequence: (current?.sequence ?? 0) + 1 }));
  }

  function handleDocumentBack() {
    const currentId = activeConversation.id;
    const previousId = getDocumentBackTarget(documentHistory, currentId, state.conversations);
    if (!previousId) return;
    const replace = !isDocumentOnScreen(previousId) && !pinnedDocumentIds.includes(currentId);
    setDocumentHistory((history) => takeDocumentBack(history, currentId, state.conversations, replace));
    handleSelectConversation(previousId, replace ? { replaceId: currentId } : { restorePath: false });
  }

  function handleRevealConversation(conversationId: string, options: { keepSidebarOpen?: boolean } = {}) {
    if (mainViewMode === "graph") {
      setGraphFocusRequest({
        conversationId,
        requestId: ++graphFocusRequestCounterRef.current,
      });
    }

    handleSelectConversation(conversationId, options);
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

  /** The user decides which notes and documents AI may read; nothing is hidden by default. */
  function handleToggleHiddenFromAI(conversationId: string) {
    setState((current) => {
      const conversation = current.conversations[conversationId];
      if (!conversation) return current;
      const { hiddenFromAI, ...rest } = conversation;
      return { ...current, conversations: { ...current.conversations,
        [conversationId]: { ...rest, ...(hiddenFromAI ? {} : { hiddenFromAI: true }), updatedAt: new Date().toISOString() } } };
    });
  }

  function handleDeleteThread(conversationId: string) {
    const rootConversation = state.conversations[conversationId];

    if (!rootConversation) {
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
    setSearchExploreOpen(false);
    setSearchQuery("");
    setMapModalOpen(false);
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
    currentPassword?: string;
  }) {
    setProfileSaving(true);
    setProfileSaveError(null);

    try {
      await onUpdateProfile(args);
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

  const selectionConversation = selectionDraft ? state.conversations[selectionDraft.conversationId] : undefined;
  const selectionPending = Boolean(selectionDraft && pendingConversationIds[selectionDraft.conversationId]);
  // A tapped diagram is selected whole; AI changes it in place, and Highlight or Rewrite would break its Mermaid.
  const selectionIsDiagram = Boolean(selectionDraft?.sourceBlockId && isMermaidDiagramPassage(selectionDraft.quote));
  const selectionBlock = selectionDraft?.sourceBlockId && selectionConversation?.document
    ? getEditableDocument(selectionConversation).blocks.find((block) => block.id === selectionDraft.sourceBlockId) : undefined;
  const selectionHighlighted = Boolean(selectionBlock && isMarkdownHighlighted(selectionBlock.content, selectionDraft!.startOffset, selectionDraft!.endOffset));
  useEffect(() => { if (!selectionDraft || selectionIntent !== "branch") setSelectionModelOpen(false); }, [selectionDraft, selectionIntent]);
  const selectionTooltipLayout =
    selectionDraft && typeof window !== "undefined"
      ? getSelectionTooltipLayout({
          rect: selectionDraft.rect,
          tooltipHeight: toolbarSize.height,
          tooltipWidth: toolbarSize.width,
          viewportHeight: selectionViewport.height,
          viewportTop: selectionViewport.top,
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
    // Leading space belongs to the first document group. Changing editor focus
    // must not move a note's controls between pointerdown and click.
    "--document-focus-width": `${getRenderedPanelWidth(scrollingDocuments[0]?.id ?? activeConversation.id)}px`,
    "--document-notes-space": !scrollingDocuments[0] ? "0px"
      : getMinimizedChildNodes(scrollingDocuments[0]) ? `${getMinimizedChildNodesWidth(getMinimizedChildNodes(scrollingDocuments[0])!.nodes, getMinimizedChildNodes(scrollingDocuments[0])!.compact)}px`
      : showsMarginInPanel(scrollingDocuments[0]) ? `${getDocumentMarginSpace(scrollingDocuments[0], false)}px`
      : !closedMarginNotes[scrollingDocuments[0].id] && getMarginDocuments(scrollingDocuments[0]).length ? `${getMarginColumnWidth(scrollingDocuments[0], false) + 32}px` : "0px",
  } as CSSProperties;

  function renderDocumentBreadcrumbs(plain = false) {
    const backId = getDocumentBackTarget(documentHistory, activeConversation.id, state.conversations);
    return <DocumentBreadcrumbs conversations={state.conversations} focusedId={activeConversation.id}
      onScreenIds={getOnScreenDocumentIds()} streamingIds={streamingThreadIds}
      minimizedIds={new Set(getDocumentWorkspace(state.conversations, activeConversation.id).minimizedIds)}
      backTitle={backId ? state.conversations[backId].title || "Untitled document" : null} onBack={handleDocumentBack}
      onExpand={handleExpandDocumentHere} onOpenBeside={handleOpenDocumentBeside} plain={plain} openedAt={documentOpenedAt}
      // On a computer the compass sits beside the path it continues; phones list the views as tabs below it.
      trailing={isMobileViewport ? undefined : <>
        {navigationStyle === "compass" && documentNeighbors ? <DocumentCompass neighbors={documentNeighbors} onOpen={handleOpenNeighbor} besidePath /> : null}
        <DocumentNavigationSwitcher value={navigationStyle} onChange={handleChangeNavigationStyle} />
      </>} />;
  }


  /** Sessions as chips: at the left of the tabs row on a computer, the top of the drop-down on a phone. */
  function renderSessionChips() {
    return sessions ? <SessionChips sessions={sortedSessions} activeId={sessions.activeId} limit={isMobileViewport ? Infinity : 3}
      onSelect={handleSwitchSession} onNew={() => handleCreateSession()}
      onManage={() => { setLeftSidebarOpen(true); setSessionsRequest((count) => count + 1); }} /> : null;
  }

  function renderSessionTabs(vertical = false) {
    return <>
                    {vertical ? null : renderSessionChips()}
                    <DocumentTabs vertical={vertical} documents={peerTabDocuments}
                      groups={state.groups}
                      onAssignGroup={handleAssignConversationGroup}
                      onRename={handleRenameThread}
                      activeDocumentId={activePeerTabId}
                      minimizedDocumentIds={documentWorkspace.minimizedIds}
                      pinnedDocumentIds={pinnedDocumentIds}
                      familyPinnedDocumentIds={familyPinnedDocumentIds}
                      onTogglePin={handleToggleDocumentPin}
                      onTogglePinScope={handleToggleDocumentPinScope}
                      canReorder={(draggedId, targetId) => familyDocumentIds.has(draggedId) && familyDocumentIds.has(targetId)}
                      onSelect={(id) => handleSelectConversation(id, { restorePath: false })}
                      onMinimize={handleMinimizeDocument}
                      onClose={handleCloseDocument}
                      showCloseButtons
                      onNewSideDocument={() => handleAddSideChat(activeConversation.id)}
                      onReorder={(draggedId, targetId) => setState((current) => reorderDocument(current, draggedId, targetId))}
                    />
    </>;
  }

  function renderDocumentViewsMenu() {
    return <DocumentViewsMenu currentDocumentId={activeConversation.id}
                        onMinimizeAll={() => handleHideAllDocuments("minimize")}
                        onCloseAll={() => handleHideAllDocuments("close")}
                        canMinimizeAll={tabDocuments.some((document) => pinnedDocumentIds.includes(document.id) || !documentWorkspace.minimizedIds.includes(document.id))}
                        canCloseAll={tabDocuments.length > 0}
                        relatedItems={jev.status === "ready" ? jev.related.filter((item) => item.id !== activeConversation.id && state.conversations[item.id]).slice(0, 5)
                          .map(({ id }) => ({ id, title: state.conversations[id].title, kind: state.conversations[id].kind })) : []}
                        relatedWarning={jev.warning} onSelectRelated={handleRevealConversation}
                        branchCount={branchNavigationCount} branchesOpen={state.railOpen} branchesEnabled={branchAccessEnabled}
                        onToggleBranches={handleToggleRail} />;
  }

  /** Full screen: the document alone, with the header and side panels put away. The same place in its header leads back out. */
  function renderFullScreenButton(conversation: Conversation = activeConversation) {
    if (isCompactDocument(conversation)) return null;
    if (maximizedDocument?.id === conversation.id) {
      return <button type="button" className="document-exit-full-screen" aria-keyshortcuts="Escape"
        aria-label={`Leave full screen: ${conversation.title || "Untitled document"}`} title="Leave full screen (Esc)"
        onClick={() => setMaximizedDocumentId(null)}>
        <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 3v5H3M12 3v5h5M8 17v-5H3M12 17v-5h5" />
        </svg>
      </button>;
    }
    return <button type="button" className="document-full-screen-button" aria-keyshortcuts="Escape"
      aria-label="Full screen" title="Full screen (Esc to leave)" onClick={() => toggleMaximizedDocument(conversation.id)}>
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5" />
      </svg>
    </button>;
  }

  function toggleDesktopHeader() {
    setDesktopHeaderOpen((open) => { saveDocumentHeaderOpen(!open); return !open; });
  }

  /** Main and side documents have a tab, and close only from its ×. */
  function hasDocumentTab(id: string) {
    return getPresentedParentId(state.conversations, id) === null;
  }

  function renderDocumentMenu(conversation: Conversation) {
    return <DocumentMenu conversation={conversation}
        className="document-header-menu-trigger"
        pinned={pinnedDocumentIds.includes(conversation.id)} familyPinned={familyPinnedDocumentIds.includes(conversation.id)}
        minimized={documentWorkspace.minimizedIds.includes(conversation.id)}
        onTogglePin={handleToggleDocumentPin} onTogglePinScope={handleToggleDocumentPinScope}
        // Documents with a tab close from its ×; notes and branches have no tab, so their menu keeps Close.
        onMinimize={handleMinimizeDocument} onClose={hasDocumentTab(conversation.id) ? undefined : handleCloseDocument} onRestore={handleSelectConversation} onRename={handleRenameThread}
        onNewMarginNote={(id) => handleCreateNote({ conversationId: id, content: "", sourceMessageId: null })}
        onMoveToSideDocument={conversation.document?.marginNote ? handleMoveMarginNoteToSideDocument : undefined}
        onToggleHiddenFromAI={handleToggleHiddenFromAI}
        groups={state.groups} onAssignGroup={handleAssignConversationGroup}
        onFocusFallback={() => {
          const triggers = [...document.querySelectorAll<HTMLButtonElement>("[data-document-tab-id] .document-tab-menu-trigger")]
            .filter((button) => !button.closest("[hidden]"));
          (triggers.find((button) => button.closest<HTMLElement>("[data-document-tab-id]")?.dataset.documentTabId === conversation.id)
            ?? triggers.find((button) => button.closest<HTMLElement>("[data-document-tab-id]")?.dataset.documentTabId === currentStateRef.current.activeConversationId)
            ?? triggers[0])?.focus();
        }} />;
  }

  function renderDocumentControls(conversation: Conversation, view: "chat" | "graph" = "chat") {
    // On phones the breadcrumb bar lists notes and children (and reopens closed notes), so the header skips them.
    const noteCount = isMobileViewport ? 0 : getMarginDocuments(conversation).length;
    if (!(view === "chat" && noteCount) && !conversation.document?.marginNote) return null;
    return <>
      {view === "chat" && noteCount ? <button type="button" className="document-margin-notes-toggle"
        aria-label={`${closedMarginNotes[conversation.id] ? "Show" : "Hide"} margin notes for ${conversation.title}`}
        aria-expanded={!closedMarginNotes[conversation.id]}
        onClick={() => setClosedMarginNotes((current) => ({ ...current, [conversation.id]: !current[conversation.id] }))}>
        Notes <span>{noteCount}</span>
      </button> : null}
      {conversation.document?.marginNote ? <button type="button" className="document-presentation-toggle"
        aria-label={`${isCompactDocument(conversation) ? "Expand" : "Compact"} margin note ${conversation.title}`}
        title={isCompactDocument(conversation) ? "Expand to full document" : "Show as a margin note"}
        onClick={() => handleToggleMarginPresentation(conversation.id)}>{isCompactDocument(conversation) ? "↗" : "↙"}</button> : null}
    </>;
  }

  /** Tabs keep creation order, so they don't jump when panes are reordered; linked documents follow. */
  function getChildTabDocuments(parent: Conversation) {
    const children = documentChildrenByParent.get(parent.id) ?? [];
    const rank = (document: Conversation) => { const index = parent.childIds.indexOf(document.id); return index < 0 ? Infinity : index; };
    return [...children].sort((a, b) => rank(a) - rank(b));
  }

  function renderChildrenMenu(conversation: Conversation, view: "chat" | "graph", dock?: GraphDockControls) {
    const childDocuments = getChildTabDocuments(conversation);
    if ((isMobileViewport && view === "chat") || !childDocuments.length || isCompactDocument(conversation)) return null;
    return <DocumentChildrenMenu parent={conversation} documents={childDocuments}
      currentDocumentId={activeConversation.id}
      marginNoteIds={showsMarginInPanel(conversation, view) ? getMarginDocuments(conversation).map((note) => note.id) : []}
      openDocumentIds={[...visiblePinnedDocumentIds, ...scrollingDocuments.map((document) => document.id)]}
      minimizedDocumentIds={[...minimizedSideDocumentsByParent.values()].flatMap((documents) => documents.map((document) => document.id))}
      // In Map View's side panel a child replaces its parent in the panel instead of leaving the map.
      onSelect={(id) => dock ? dock.onOpenDocument(id) : handleSelectConversation(id, { nextViewMode: "chat" })} />;
  }

  /** The parents of a document in Map View's side panel; each one opens in the panel. */
  function renderPanelBreadcrumbs(conversation: Conversation, dock: GraphDockControls) {
    const parents = getConversationPath(state.conversations, conversation.id).slice(0, -1);
    if (!parents.length) return null;
    return <nav className="document-panel-breadcrumbs" aria-label={`Parents of ${conversation.title || "Untitled document"}`}><ol>
      {parents.map((parent) => <li key={parent.id}>
        <button type="button" title={`Show ${parent.title || "Untitled document"} in this panel`} onClick={() => dock.onOpenDocument(parent.id)}>{parent.title || "Untitled document"}</button>
      </li>)}
      <li aria-current="page"><span>{conversation.title || "Untitled document"}</span></li>
    </ol></nav>;
  }

  /** Map View's menu: only actions that act on the map, with pin and close driving its split pane. */
  function renderMapDocumentMenu(conversation: Conversation, dock?: GraphDockControls) {
    return <DocumentMenu conversation={conversation} className="document-header-menu-trigger"
      pinned={dock?.pinned} onTogglePin={dock ? () => dock.onTogglePin() : undefined}
      onClose={dock ? () => dock.onClose() : undefined} onRename={handleRenameThread}
      onToggleHiddenFromAI={handleToggleHiddenFromAI}
      groups={state.groups} onAssignGroup={handleAssignConversationGroup} />;
  }

  function renderConversationChatPanel(conversation: Conversation, view: "chat" | "graph" = "chat", dock?: GraphDockControls) {
    const maximized = view === "chat" && maximizedDocument?.id === conversation.id;
    const dockHeader = view === "chat" && !maximized && pinnedDocumentIds.includes(conversation.id);
    // On phones the workspace header names the document and holds its menu, which can minimize and close it.
    const bareHeader = view === "chat" && isMobileViewport;
    return <DocumentPanel key={conversation.id} conversation={conversation}
      compact={isCompactDocument(conversation)} bareHeader={bareHeader}
      onMinimize={view === "chat" && !dockHeader && !maximized && !bareHeader ? () => handleMinimizeDocument(conversation.id) : undefined}
      onClose={view === "chat" && !dockHeader && !maximized && !bareHeader && !hasDocumentTab(conversation.id) ? () => handleCloseDocument(conversation.id) : dock ? dock.onClose : undefined}
      headerLeading={dock?.leading}
      parentBreadcrumbs={view === "graph" && dock ? renderPanelBreadcrumbs(conversation, dock) : undefined}
      headerControls={dockHeader ? null : <>
        {renderDocumentControls(conversation, view)}
      </>}
      childNavigation={renderChildrenMenu(conversation, view, view === "graph" ? dock : undefined)}
      marginNotes={getMarginItems(conversation, view)} marginWidth={getMarginColumnWidth(conversation) + DOCUMENT_MARGIN_GUTTER + 10}
      activeMarginNoteId={activeConversation.id}
      bodyFooter={view === "chat" && navigationStyle === "reading" && conversation.id === activeConversation.id && documentNeighbors
        ? <DocumentKeepReading neighbors={documentNeighbors} onOpen={handleOpenNeighbor} /> : null}
      fullScreenToggle={view === "chat" && !dockHeader && (maximized || !isMobileViewport) ? renderFullScreenButton(conversation) : undefined}
      documentMenu={dockHeader || bareHeader ? null : view === "graph" ? renderMapDocumentMenu(conversation, dock) : renderDocumentMenu(conversation)}
      minimizedSideDocuments={view === "chat" && getMinimizedChildNodes(conversation) ? undefined : minimizedSideDocumentsByParent.get(conversation.id)}
      moveTargets={blockMoveTargets} onMoveBlock={handleMoveDocumentBlock}
      isActive={conversation.id === activeConversation.id} isSubmitting={Boolean(pendingConversationIds[conversation.id])}
      aiControls={<AIControls conversation={conversation} conversations={state.conversations} disabled={Boolean(pendingConversationIds[conversation.id])} onChange={(settings) => handleAISettingsChange(conversation.id, settings)} />}
      agentMode={agentModeControls(conversation)} agentProgress={agentProgress[conversation.id]}
      recentModelSelections={recentModelSelections} theme={theme} anchors={documentAnchorLinks(conversation.id)}
      error={documentErrors[conversation.id] ?? documentUploadByConversationId[conversation.id]?.error ?? undefined}
      onChange={(document) => handleDocumentChange(conversation.id, document)}
      onRename={(title) => handleRenameThread(conversation.id, title)}
      onSubmit={(request) => handleDocumentSubmit(conversation.id, request)} onStop={() => stopChatStream(conversation.id)}
      onAskDiagram={(request) => handleAskDiagram(conversation.id, request)}
      onSelection={(selection) => { const same = isSameSelectedPassage(selectionDraft, selection); setSelectionDraft(same && selectionDraft ? { ...selection, prompt: selectionDraft.prompt } : selection); if (same) return; setSelectionIntent("actions"); setSelectionLinkError(null); const diagram = isMermaidDiagramPassage(selection.quote); setSelectionResponseDestination(diagram ? "inline" : defaultSelectionDestination(conversation.document ? getEditableDocument(conversation).blocks : [], selection)); setSelectionReplaceText(diagram); }}
      onCaretMenu={(menu) => { setSelectionDraft(null); setCaretMenu(menu); }}
      onVisibleOutlineChange={handleVisibleOutlineChange}
      onClearSelection={() => { if (!isReselectingSelection()) setSelectionDraft((current) => current?.conversationId === conversation.id ? null : current); }}
      onOpenBranch={(id) => handleOpenDocumentReference(conversation.id, id)}
      onRemoveLink={(id) => handleRemoveDocumentLink(conversation.id, id)}
      onOpenNote={(noteId) => {
        const migrated = Object.values(state.conversations).find((item) => item.parentId === conversation.id && item.document?.marginNote?.legacyNoteId === noteId);
        if (migrated) handleSelectConversation(migrated.id);
      }}
      onModelChange={(serviceId,modelId) => handleModelChange(conversation.id,serviceId,modelId)}
      onUpload={(files) => {void handleUploadDocuments(conversation.id,files);}}
      onRemoveAttachment={(id) => handleRemoveDocument(conversation.id,id)} uploading={documentUploadByConversationId[conversation.id]?.uploading}
      onAcceptVersion={(id) => handleAcceptDocumentVersion(conversation.id,id)} onUndoInsertion={(id) => handleUndoDocumentInsertion(conversation.id,id)}
      onCreateChildNodes={(proposals) => handleCreateAIChildNodes(conversation.id, proposals)}
      onAgentProposal={(messageId, proposalId, action) => handleAgentProposal(conversation.id, messageId, proposalId, action)}
      documentTitle={(id) => state.conversations[id]?.title}
      registerPanelRef={(element) => {(view === "graph" ? graphPanelRefs : documentPanelRefs).current[conversation.id]=element;}}
      registerAnchorRef={(id,element) => {if (view === "chat") anchorRefs.current[id]=element;}}
      registerBranchOriginRef={(element) => {if (view === "chat") branchOriginRefs.current[conversation.id]=element;}}
    />;
  }

  function getMarginDocuments(conversation: Conversation) {
    return (documentChildrenByParent.get(conversation.id) ?? []).filter((child) => child.parentId === conversation.id
      && isCompactDocument(child) && !getDocumentWorkspace(state.conversations, child.id).closedIds.includes(child.id) && !pinnedDocumentIds.includes(child.id)
      && !(minimizedSideDocumentsByParent.get(conversation.id) ?? []).some((item) => item.id === child.id));
  }

  /**
   * On desktop, a document's minimized side documents and margin notes show as map nodes in the space
   * beside it, shrunk to one-line pills while one of its children is open. Phones, Full screen and
   * pinned panes keep the small restore icons.
   */
  function getMinimizedChildNodes(conversation: Conversation): { nodes: MinimizedChildNode[]; compact: boolean } | null {
    const minimized = minimizedSideDocumentsByParent.get(conversation.id);
    if (!minimized?.length || isMobileViewport || maximizedDocument || isCompactDocument(conversation)
      || pinnedDocumentIds.includes(conversation.id)) return null;
    const viewingChild = (documentChildrenByParent.get(conversation.id) ?? []).some((child) => child.parentId === conversation.id
      && !isCompactDocument(child) && visibleDocumentIds.has(child.id));
    const viewingNote = !closedMarginNotes[conversation.id] && getMarginDocuments(conversation).length > 0;
    const compact = viewingChild || viewingNote;
    const closedIds = new Set(getDocumentWorkspace(state.conversations, conversation.id).closedIds);
    const seen = new Set([conversation.id]);
    // A minimized document's own side documents and margin notes stay on its branch, as in Map view,
    // unless they are open on screen or were closed.
    function branch(parent: Conversation, children: Conversation[]): MinimizedChildNode[] {
      return sortInReadingOrder(parent, children.filter((child) => !seen.has(child.id))).map((child) => {
        seen.add(child.id);
        const hidden = (documentChildrenByParent.get(child.id) ?? []).filter((grandchild) => grandchild.parentId === child.id
          && !visibleDocumentIds.has(grandchild.id) && !closedIds.has(grandchild.id) && !pinnedDocumentIds.includes(grandchild.id));
        return { document: child, children: branch(child, hidden) };
      });
    }
    return { nodes: branch(conversation, minimized), compact };
  }

  /**
   * Stack nodes in reading order, so each curve from its passage runs straight across without crossing
   * another. Nodes without a passage join the document's header, so they lead.
   */
  function sortInReadingOrder(parent: Conversation, children: Conversation[]) {
    const blockOrder = new Map(getEditableDocument(parent).blocks.map((block, index) => [block.id, index]));
    // A PDF's passages have no blocks; their page puts them in order.
    const position = (child: Conversation) => !child.branchAnchor ? [-1, 0]
      : [blockOrder.get(child.branchAnchor.sourceBlockId ?? "") ?? pdfPageFromSourceId(child.branchAnchor.sourceMessageId) ?? Number.MAX_SAFE_INTEGER,
        child.branchAnchor.startOffset];
    return [...children].sort((left, right) => {
      const [leftBlock, leftOffset] = position(left);
      const [rightBlock, rightOffset] = position(right);
      return leftBlock - rightBlock || leftOffset - rightOffset;
    });
  }

  function getMarginColumnWidth(conversation: Conversation, includePreview = true): number {
    const notes = getMarginDocuments(conversation);
    return 8 + Math.max(0, ...notes.map((note) => Math.max(
      getMarginDocumentSize(includePreview ? marginResizePreviews[note.id] ?? note.document?.marginNote?.size : note.document?.marginNote?.size).width,
      !closedMarginNotes[note.id] && getMarginDocuments(note).length ? getMarginColumnWidth(note, includePreview) + 21 : 0,
    )));
  }

  /**
   * On wider screens a document's margin notes live inside its frame, each beside its passage,
   * and the frame grows by the margin so the text keeps its width. Phones keep the notes column.
   */
  function showsMarginInPanel(conversation: Conversation, view: "chat" | "graph" = "chat") {
    return view === "chat" && !isMobileViewport && !isCompactDocument(conversation)
      && !closedMarginNotes[conversation.id] && getMarginDocuments(conversation).length > 0;
  }
  /** Extra frame width the margin adds, so the text column keeps its width. */
  function getDocumentMarginSpace(conversation: Conversation, includePreview = true) {
    return showsMarginInPanel(conversation) ? getMarginColumnWidth(conversation, includePreview) + DOCUMENT_MARGIN_GUTTER + 10 : 0;
  }
  function renderMarginFamily(note: Conversation, view: "chat" | "graph", fitContent = false) {
    return <div className="margin-document-family">
      <MarginDocumentFrame data-document-id={note.id} size={note.document?.marginNote?.size} fitContent={fitContent}
        onResize={(size) => handleResizeMarginDocument(note.id, size)}
        onResizePreview={(size) => setMarginResizePreviews((current) => ({ ...current, [note.id]: size ?? undefined }))}
        onPointerDownCapture={() => handleFocusVisibleDocument(note.id)}
        onFocusCapture={() => handleFocusVisibleDocument(note.id)}>
        {renderConversationChatPanel(note, view)}
      </MarginDocumentFrame>
      {renderDocumentMarginNotes(note, view)}
    </div>;
  }
  function getMarginItems(conversation: Conversation, view: "chat" | "graph"): DocumentMarginItem[] | undefined {
    if (!showsMarginInPanel(conversation, view)) return undefined;
    return getMarginDocuments(conversation).map((note) => ({ id: note.id, anchored: Boolean(note.branchAnchor), node: renderMarginFamily(note, view, true) }));
  }

  /** The column of notes beside a document on phones, and beside a margin note for its own notes. */
  function renderDocumentMarginNotes(conversation: Conversation, view: "chat" | "graph" = "chat"): React.ReactNode {
    const notes = getMarginDocuments(conversation);
    if (!notes.length || closedMarginNotes[conversation.id] || showsMarginInPanel(conversation, view)) return null;
    return <aside className={`document-margin-notes${maximizedDocument?.id === conversation.id ? " is-maximized-document" : ""}`}
      aria-label={`Notes for ${conversation.title}`} data-margin-notes-for={conversation.id}
      style={{ "--margin-column-width": `${getMarginColumnWidth(conversation)}px` } as CSSProperties}>
      <header className="document-margin-notes-header">
        <div><strong>Margin notes</strong><span title={conversation.title}>{conversation.title}</span></div>
        <button type="button" aria-label={`Close margin notes for ${conversation.title}`} title="Close margin notes"
          onClick={() => {
            setClosedMarginNotes((current) => ({ ...current, [conversation.id]: true }));
            if (getConversationPath(state.conversations, activeConversation.id).some((item) => item.id === conversation.id)) handleFocusVisibleDocument(conversation.id);
            const panel = panelRefs.current[conversation.id];
            (panel?.querySelector<HTMLButtonElement>(".document-margin-notes-toggle")
              ?? panel?.closest("[data-dock-document-id]")?.querySelector<HTMLButtonElement>(".document-margin-notes-toggle"))?.focus();
          }}>×</button>
      </header>
      <div className="document-margin-notes-list">
        {notes.map((note) => <Fragment key={note.id}>{renderMarginFamily(note, view)}</Fragment>)}
      </div>
    </aside>;
  }

  function renderDocumentWithMarginNotes(conversation: Conversation, view: "chat" | "graph" = "chat", dock?: GraphDockControls) {
    return <div className="document-with-margin-notes">
      {renderConversationChatPanel(conversation, view, dock)}
      {view === "chat" ? renderDocumentMarginNotes(conversation, view) : null}
    </div>;
  }

  function renderExpandedTreeConversation(conversation: Conversation) {
    const resizeInfo = getPanelResizeInfo(conversation);
    const minimizedNodes = getMinimizedChildNodes(conversation);
    const nodesWidth = minimizedNodes ? getMinimizedChildNodesWidth(minimizedNodes.nodes, minimizedNodes.compact) : 0;
    const resizeMinimum = resizeChatPanel({ ...resizeInfo, delta: -resizeInfo.maxWidth }).width;
    const resizeMaximum = resizeChatPanel({ ...resizeInfo, delta: resizeInfo.maxWidth }).width;
    const isResizing =
      conversation.id === resizingChatPanelConversationId &&
      isResizingChatPanel;

    return (
      <div
        className={`conversation-tree-expanded panel-slot is-resizable is-split-context${isResizing ? " is-resizing" : ""}${
          maximizedDocument?.id === conversation.id ? " is-maximized-document" : ""}${minimizedNodes ? " has-minimized-child-nodes" : ""}`}
        data-expanded-conversation-id={conversation.id}
        data-document-id={conversation.id}
        onPointerDownCapture={() => handleFocusVisibleDocument(conversation.id)}
        onFocusCapture={() => handleFocusVisibleDocument(conversation.id)}
        key={conversation.id}
        style={{ "--chat-panel-width": `${resizeInfo.width + getDocumentMarginSpace(conversation) + nodesWidth}px`,
          ...(minimizedNodes ? { "--minimized-child-nodes-width": `${nodesWidth}px` } : {}) } as CSSProperties}
      >
        {renderConversationChatPanel(conversation)}
        {minimizedNodes ? <MinimizedChildNodes nodes={minimizedNodes.nodes} compact={minimizedNodes.compact}
          onOpen={(id) => handleOpenDocumentReference(conversation.id, id)} /> : null}
        {(["left", "right"] as const).map((edge) => <div
          key={edge}
          data-resize-edge={edge}
          aria-label={`Resize ${conversation.title} document from ${edge}`}
          aria-orientation="vertical"
          aria-valuemax={resizeMaximum}
          aria-valuemin={resizeMinimum}
          aria-valuenow={Math.round(resizeInfo.width)}
          aria-valuetext={`${Math.round(resizeInfo.width)} pixels wide`}
          className={`panel-resize-handle is-visible${edge === "left" ? " is-left-edge" : ""}`}
          onDoubleClick={() => handleResetChatPanelWidth(conversation)}
          onKeyDown={(event) => handleChatPanelResizeKeyDown(conversation, edge, event)}
          onPointerDown={(event) =>
            handleChatPanelResizePointerDown(conversation.id, edge, event)
          }
          role="separator"
          tabIndex={0}
          title={`Drag the ${edge} edge to resize ${conversation.title}. Double-click to reset this document.`}
        >
          <span className="panel-resize-handle-grip" />
        </div>)}
      </div>
    );
  }

  function renderWorkspaceBrand() {
    return (
      <div className="workspace-session-brand">
        <button
          aria-label={leftSidebarOpen ? "Close chat sidebar" : "Open chat sidebar"}
          aria-pressed={leftSidebarOpen}
          aria-keyshortcuts="Meta+B Control+B"
          title="Toggle chat sidebar (⌘B / Ctrl+B)"
          className="workspace-menu-button"
          onClick={handleToggleLeftSidebar}
          type="button"
        >
          <SidebarPanelIcon />
        </button>
        <h1>Margin Chat</h1>
        <WorkspaceModeToggle mainViewMode={mainViewMode} onSetMainViewMode={handleSetMainViewMode} />
      </div>
    );
  }

  function renderRelatedItems() {
    return <JevRelatedItems status={jev.status} related={jev.related} warning={jev.warning}
      conversations={state.conversations} currentId={activeConversation.id} onSelect={handleRevealConversation} />;
  }

  // While the files saved on this device are read, the workspace already shows; it only waits on a screen when they can't be opened.
  if (!vault.ready && vault.message) {
    return <div className="auth-shell"><section className="thread-dialog" role="status">
      <h2>Opening your Markdown vault</h2>
      <p>{vault.message}</p>
      <button className="thread-dialog-button" onClick={() => window.location.reload()}>Try again</button>
      {vault.startFreshCopy ? <button className="thread-dialog-button" onClick={() => {
        if (window.confirm("Download your vault from the cloud into a new copy on this device? The copy that can't be opened is kept, but edits in it that never reached the cloud won't appear.")) vault.startFreshCopy?.();
      }}>Download a fresh copy from the cloud</button> : null}
    </section></div>;
  }

  if (vault.vaultFolderPrompt || vaultFolderGateBusy) return <VaultFolderGate vault={vault} onBusyChange={setVaultFolderGateBusy} />;

  return (
    <VaultMediaContext.Provider value={vault.media}>
    <DocumentTitleSuggestionContext.Provider value={suggestDocumentTitle}>
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
    {/* Until the vault is read the workspace can't be edited, so nothing typed is replaced when the documents arrive. */}
    <div className={`app-shell${maximizedDocument ? " is-document-maximized" : ""}${vault.ready ? "" : " is-vault-opening"}`}
      aria-busy={!vault.ready || undefined} inert={!vault.ready || undefined}>
      <div className="app-chrome">
        <div className="workspace-notifications">
          {!leftSidebarOpen || isMobileViewport ? <VaultFetchIndicator status={vault.fetchStatus ?? null} compact /> : null}
          <NotificationToast message={documentLinkNotice?.message ?? null} kind="success"
            onDismiss={() => setDocumentLinkNotice(null)}
            action={documentLinkNotice?.conversationId ? { label: "Open link", onClick: () => handleNavigateDocumentConnector({
              conversationId: documentLinkNotice.conversationId!, blockId: documentLinkNotice.blockId,
            }) } : undefined} />
          <NotificationToast
            message={billingNotice?.message ?? null}
            kind={billingNotice?.kind}
            onDismiss={onDismissBillingNotice}
          />
          <NotificationToast
            message={vault.folderAccessMessage}
            action={{ label: "Allow access", onClick: () => vault.allowDirectoryAccess().then(() => undefined, () => {
              setProfileInitialTab("storage"); setProfileModalOpen(true);
            }) }}
          />
          <NotificationToast
            message={vault.folderUnavailable ? `Margin Chat can’t find or open the folder “${vault.localDirectoryStatus.directoryName}”. Your edits are saved in the app and nothing in the folder is changed until it’s back.` : null}
            action={{ label: "Vault settings", onClick: () => { setProfileInitialTab("storage"); setProfileModalOpen(true); } }}
          />
          <NotificationToast message={vault.recoveryNotice} onDismiss={vault.dismissRecoveryNotice} duration={120000} />
          <NotificationToast
            message={chatImportReminder ? "Have chats in ChatGPT? Bring them into Margin Chat to keep working on them here." : null}
            duration={30000}
            onDismiss={() => { finishChatImportReminder(storageUserId); setChatImportReminder(false); }}
            action={{ label: "Bring your chat history", onClick: () => {
              finishChatImportReminder(storageUserId); setChatImportReminder(false); setHistoryImportOpen(true);
            } }}
          />
          <NotificationToast
            message={newDeviceNotice ? NEW_DEVICE_NOTICE : null}
            duration={60000}
            onDismiss={() => setNewDeviceNotice(false)}
            action={{ label: "Vault settings", onClick: () => { setNewDeviceNotice(false); setProfileInitialTab("storage"); setProfileModalOpen(true); } }}
          />
          <FolderDeletionPrompt held={vault.heldFolderDeletion} onResolve={vault.resolveHeldFolderDeletion} />
          <OnlyCopyPrompt reminder={vault.onlyCopyReminder} folderSupported={vault.localDirectoryStatus.supported}
            onDownload={vault.download} onChooseFolder={vault.chooseDirectory} onLater={vault.snoozeOnlyCopyReminder} />
          <VaultFileDrop vault={vault} />
          <NotificationToast message={uploadNotice?.message ?? null} kind={uploadNotice?.kind}
            duration={uploadNotice?.kind === "info" ? 120000 : 10000} onDismiss={() => setUploadNotice(null)} />
          <NotificationToast
            message={vault.message}
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

          {isMobileViewport && mainViewMode === "chat" ? <MobileEdgeSwipe
            canSync={cloudSyncEnabled && vault.ready}
            disabled={searchModalOpen}
            sidebarOpen={leftSidebarOpen}
            onCloseSidebar={() => setLeftSidebarOpen(false)}
            onOpenSidebar={() => {
              setState((current) => current.railOpen ? { ...current, railOpen: false } : current);
              setLeftSidebarOpen(true);
            }}
            /* The vault shows its own notice if the sync fails. */
            onSync={() => void vault.syncNow().catch(() => undefined)}
          /> : null}

          <main className="workspace">
            <ResizableSidebar collapsed={!leftSidebarOpen} mobile={isMobileViewport} onResizingChange={setIsResizingSidebar}>
            {!isMobileViewport && renderWorkspaceBrand()}
            <ThreadSidebar
              header={isMobileViewport ? renderWorkspaceBrand() : undefined}
              vaultSwitcher={<VaultSwitcher vault={vault} cloudSync={cloudSyncEnabled}
                onOpenSettings={() => { setProfileInitialTab("storage"); setProfileModalOpen(true); }} />}
              documentOrder={documentOrder}
              sessionsPanel={sessions ? <SessionsPanel sessions={sortedSessions} activeId={sessions.activeId}
                conversations={state.conversations} focusedDocumentId={activeConversation.id}
                onOpen={handleSwitchSession}
                onRename={(sessionId, name) => setState((current) => renameSession(current, sessionId, name))}
                onDuplicate={(sessionId) => setState((current) => duplicateSession(current, sessionId))}
                onDelete={handleDeleteSession} onNew={(name) => handleCreateSession(name)}
                onOpenDocument={(id) => handleSelectConversation(id, { nextViewMode: "chat" })}
                showIntro={newVault}
                onRemoveDocument={(sessionId, documentId) => setState((current) => removeDocumentFromSession(current, sessionId, documentId))} /> : undefined}
              sessionsRequest={sessionsRequest}
              documentSort={documentSort}
              onDocumentSortChange={(sort) => { setDocumentSort(sort); saveSidebarDocumentSort(storageUserId, sort); }}
              mapExplorerRef={setGraphExplorerContainer}
              mapExplorerActive={mapSidebarSection === "explore"}
              onSelectSidebarSection={setMapSidebarSection}
              activeOutlineItemId={activeOutlineItemId}
              activeThreadId={activeConversation.id}
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
              onOpenInbox={guest ? undefined : () => setCaptureInboxOpen(true)}
              onImportChatHistory={() => setHistoryImportOpen(true)}
              onTakeTour={inExtension ? undefined : () => {
                if (isMobileViewport) setLeftSidebarOpen(false);
                handleSetMainViewMode("chat");
                updateOnboarding({ tour: "active", step: 0 });
              }}
              onOpenProfile={() => {
                setProfileSaveError(null);
                setProfileInitialTab(null);
                setProfileModalOpen(true);
              }}
              onOpenSettings={() => {
                setProfileSaveError(null);
                setProfileInitialTab("appearance");
                setProfileModalOpen(true);
              }}
              onOpenSearch={handleOpenSearch}
              onPinThread={handlePinThread}
              onRenameThread={handleRenameThread}
              onSelectOutlineItem={handleSelectOutlineItem}
              onOutlineNavigated={() => { if (isMobileViewport) setLeftSidebarOpen(false); }}
              onSelectThread={handleRevealConversation}
              onToggleGroup={handleToggleConversationGroup}
              onToggleTheme={() =>
                onSetTheme((current) => getNextTheme(current))
              }
              onUnpinThread={handleUnpinThread}
              pinnedThreads={pinnedThreadSummaries}
              streamingThreadIds={streamingThreadIds}
              theme={theme}
              threads={documentSummaries}
              fetchIndicator={<VaultFetchIndicator status={vault.fetchStatus ?? null} />}
              arrivingThreadIds={vault.arrivingIds}
              cloudIndex={<CloudVaultIndex documents={vault.cloudDocuments ?? []} openingPath={vault.openingPath ?? null}
                arrivingPaths={vault.streamingPaths ?? EMPTY_SET}
                onOpen={(path) => {
                  void vault.openCloudDocument(path).then(() => {
                    setMainViewMode("chat");
                    if (isMobileViewport) setLeftSidebarOpen(false);
                  }).catch(() => undefined);
                }} />}
            />
            </ResizableSidebar>

            <div className="workspace-main-pane">
              {isTileView && (!leftSidebarOpen || isMobileViewport) && (
                <header className="workspace-session-bar workspace-content-toolbar">
                  {renderWorkspaceBrand()}
                </header>
              )}
              <div className="workspace-content">

            <section
              ref={canvasSectionRef}
              className={
                isTileView
                  ? "canvas-section is-thread-tile-view"
                  : isGraphView
                    ? "canvas-section is-graph-view"
                    : showMapModal ? "canvas-section has-map-modal" : "canvas-section"
              }
            >
              {isTileView ? (
                <div className="canvas-head">
                  <div className="canvas-view-intro">
                    <p className="eyebrow">Tiles</p>
                    <h2>Your documents</h2>
                    <p className="canvas-hint">
                      Every main document as a card. Search, or open one to keep working.
                    </p>
                    {newVault ? <ViewIntro id="tiles" className="is-tiles" title="What Tiles shows">
                      Each main document gets a card here, with its side documents and notes counted on it. Make a group to keep a project&apos;s documents together.
                    </ViewIntro> : null}
                  </div>
                  {renderRelatedItems()}
                </div>
              ) : null}

              <WorkspaceView mode="tiles" active={isTileView}>
                <MainChatTileView
                  activeThreadId={activeRootConversation.id}
                  groups={state.groups}
                  onAssignGroup={handleAssignConversationGroup}
                  onCreateGroup={handleCreateConversationGroup}
                  onOpenThread={handleSelectConversation}
                  onToggleGroup={handleToggleConversationGroup}
                  threads={threadSummaries}
                />
              </WorkspaceView>
              {showMapModal ? <div className="document-map-modal-backdrop" aria-hidden="true" onClick={() => setMapModalOpen(false)} /> : null}
              <WorkspaceView mode="graph" active={isGraphView || showMapModal}
                modal={showMapModal ? { labelledBy: "document-map-modal-title", style: mapModalBounds ?? undefined } : undefined}>
                {showMapModal ? <DocumentMapHeader open onToggle={() => setMapModalOpen(false)}
                  onOpenMap={() => handleSetMainViewMode("graph")} /> : null}
                {isGraphView && newVault ? <ViewIntro id="map" className="is-map" title="What Map View shows">
                  Every document is a dot. Side documents, margin notes and links you add become lines, so you can see how your ideas connect. Click a dot to open it.
                </ViewIntro> : null}
                <Suspense fallback={<div className="workspace-view-loading" role="status">Opening Map View…</div>}>
                  <KnowledgeGraphWorkspace
                    isVisible={isGraphView || showMapModal}
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
                    urlMapAIOptions={{ serviceId: state.defaultServiceId, modelId: state.defaultModelId, ai: activeConversation.ai }}
                    publicMapAccount={{ userId: user.id, canAsk: user.role === "admin" || user.billing.hasAccess, isAdmin: user.role === "admin",
                      aiOptions: { serviceId: state.defaultServiceId, modelId: state.defaultModelId, ai: activeConversation.ai },
                      onBillingRefresh: () => { void onRefreshBilling(); }, onAuthExpired }}
                    onSavePublicTopic={handleSavePublicTopic}
                    onAddTopicConnections={handleAddTopicConnections}
                    onSavePrivateAnswer={handleSavePrivateAnswer}
                    onKeepExplored={handleKeepExplored}
                    onCreateMapNote={handleCreateMapNote}
                    onSetMapConnection={handleSetMapConnection}
                    onSetRelation={handleSetMapRelation}
                    onRemoveMapNote={handleRemoveMapNote}
                    onUndoMapEdit={handleUndoMapEdit}
                    mapEditMessage={mapEditMessage}
                    canUndoMapEdit={Boolean(mapUndoRef.current)}
                    key={`graph-${user.id}`}
                    workspaceKey={storageUserId}
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
                    onOpenConversation={(conversationId) => {
                      setMapModalOpen(false);
                      handleSelectConversation(conversationId, {
                        nextViewMode: "chat",
                      });
                    }}
                    onZoomIntoConversation={(conversationId) => {
                      setMapModalOpen(false);
                      if (!showMapModal) setMapReturnId(conversationId);
                      handleSelectConversation(conversationId, { nextViewMode: "chat" });
                    }}
                    onToggleGroup={handleToggleConversationGroup}
                    onUpdateGraphNodeLayouts={handleUpdateGraphNodeLayouts}
                    dockControlsInHeader
                    renderDockedConversation={(conversationId, source, dock) => {
                      const conversation = state.conversations[conversationId];
  
                      return conversation
                        ? <>
                            <GraphSourceFocus
                              source={source}
                              getPanelElement={() => graphPanelRefs.current[conversationId] ?? null}
                            />
                            {renderDocumentWithMarginNotes(conversation, "graph", dock)}
                          </>
                        : null;
                    }}
                    renderExpandedConversation={(conversationId) => {
                      const conversation = state.conversations[conversationId];
  
                      return conversation
                        ? renderDocumentWithMarginNotes(conversation, "graph")
                        : null;
                    }}
                  />
                </Suspense>
              </WorkspaceView>
              <WorkspaceView mode="chat" active={!isTileView && !isGraphView}>
                <div className="chat-tree-workspace document-workspace" data-from-map={mapReturnId ? "true" : undefined}>
                  <header className={`document-workspace-header${headerOpen ? " is-open" : ""}${headerScrolledAway ? " is-scrolled-away" : ""}`}
                    aria-label="Document navigation" onKeyDown={(event) => {
                      if (event.key === "Escape" && isMobileViewport && mobileHeaderOpen) { event.stopPropagation(); setMobileHeaderOpen(false); }
                    }}>
                  <div className="document-workspace-toolbar">
                    {(!leftSidebarOpen || isMobileViewport) && <button
                      aria-label={leftSidebarOpen ? "Close chat sidebar" : "Open chat sidebar"}
                      aria-pressed={leftSidebarOpen}
                      aria-keyshortcuts="Meta+B Control+B"
                      title="Toggle chat sidebar (⌘B / Ctrl+B)"
                      className="workspace-menu-button"
                      onClick={handleToggleLeftSidebar}
                      type="button"
                    ><SidebarPanelIcon /></button>}
                    {isMobileViewport ? <button type="button" className="document-header-title" aria-expanded={mobileHeaderOpen}
                      aria-controls="document-header-details" title={mobileHeaderOpen ? "Hide tabs and path" : "Show tabs, path and views"}
                      onClick={() => setMobileHeaderOpen((open) => !open)}>
                      <span className={`document-navigator-kind is-${getDocumentKind(activeConversation)}`} aria-hidden="true" />
                      <span className="document-header-title-label">{activeConversation.title || "Untitled document"}</span>
                      <svg className="document-header-chevron" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                    </button> : renderSessionTabs()}
                    <div className="document-workspace-actions">
                      {mapReturnId ? <button type="button" className="document-back-to-map" onClick={() => handleSetMainViewMode("graph")}
                        title="Back to the map (or pinch out)">
                        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5 7 10l5 5" /></svg>
                        Map
                      </button> : null}
                      {/* On computers each document's own header holds it. */}
                      {isMobileViewport ? renderFullScreenButton() : null}
                      {isMobileViewport ? renderDocumentMenu(activeConversation) : <>
                        <button type="button" className="document-header-toggle" aria-expanded={desktopHeaderOpen}
                          aria-label={desktopHeaderOpen ? "Hide path and views" : "Show path and views"}
                          title={desktopHeaderOpen ? "Hide path and views" : "Show path and views"} onClick={toggleDesktopHeader}>
                          <svg className="document-header-chevron" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                        </button>
                        {renderDocumentViewsMenu()}
                      </>}
                    </div>
                  </div>
                  {isMobileViewport ? (mobileHeaderOpen ? <div id="document-header-details" className="document-header-details">
                    {sessions ? <div className="document-header-section-label">Session</div> : null}
                    {renderSessionChips()}
                    <div className="document-header-section-label">Open documents{renderDocumentViewsMenu()}</div>
                    {renderSessionTabs(true)}
                    <div className="document-header-section-label">Path</div>
                    {renderDocumentBreadcrumbs(true)}
                    <DocumentNavigationSwitcher labelled value={navigationStyle} onChange={(style) => {
                      handleChangeNavigationStyle(style);
                      if (style === "graph") setMobileHeaderOpen(false);
                    }} />
                    {navigationStyle === "compass" && documentNeighbors ? <DocumentCompass neighbors={documentNeighbors} onOpen={handleOpenNeighbor} besidePath /> : null}
                    {navigationStyle === "outline" && documentNeighbors ? <DocumentTopicOutline neighbors={documentNeighbors}
                      onOpen={(id) => handleSelectConversation(id, { nextViewMode: "chat" })} /> : null}
                  </div> : null) : desktopHeaderOpen ? renderDocumentBreadcrumbs() : null}
                  </header>
                  {isMobileViewport && mobileHeaderOpen ? <div className="document-header-backdrop" aria-hidden="true" onClick={() => setMobileHeaderOpen(false)} /> : null}
                  <div className="document-workspace-with-search" ref={documentAreaRef}>
                  {navigationStyle === "graph" && !showMapModal ? <DocumentMapHeader open={false} onToggle={openMapModal}
                    onOpenMap={() => handleSetMainViewMode("graph")} /> : null}
                  {navigationStyle === "outline" && documentNeighbors && !isMobileViewport ? <DocumentTopicOutline neighbors={documentNeighbors}
                    onOpen={(id) => handleSelectConversation(id, { nextViewMode: "chat" })} /> : null}
                  {searchPanel ? <SearchResultsPanel initialQuery={searchPanel.query} initialScope={searchPanel.scope} provider={vaultSearchProvider}
                    currentConversationId={activeConversation.id} openingPath={vault.openingPath ?? null}
                    onOpenDocument={handleOpenVaultSearchDocument} onOpenPassage={handleOpenVaultSearchPassage}
                    onClose={() => setSearchPanel(null)} /> : null}
                  <DocumentWorkspaceLayout width={documentDock?.width ?? 0.4} position={documentDock?.position}
                    onWidthChange={(width) => setState((current) => ({ ...current, documentDock: { ...current.documentDock, tree: current.documentDock?.tree ?? null, width } }))}
                    dock={documentDock?.tree && visiblePinnedDocumentIds.length && !maximizedIsPinned ? <DocumentDock
                      tree={documentDock.tree} conversations={state.conversations} activeDocumentId={activeConversation.id}
                      visibleDocumentIds={visiblePinnedDocumentIds}
                      onMinimize={handleMinimizeDocument} onClose={handleCloseDocument}
                      onSelect={handleFocusVisibleDocument} onUnpin={handleToggleDocumentPin} onToggleScope={handleToggleDocumentPinScope}
                      dockPosition={documentDock.position}
                      onMoveDock={(position) => setState((current) => ({ ...current, documentDock: { ...current.documentDock, tree: current.documentDock?.tree ?? null, width: current.documentDock?.width ?? 0.4, position } }))}
                      onChange={(tree) => setState((current) => ({ ...current, documentDock: { ...current.documentDock, tree, width: current.documentDock?.width ?? 0.4 } }))}
                      renderDocument={renderDocumentWithMarginNotes}
                      renderDocumentMenu={renderDocumentMenu}
                      renderDocumentControls={renderDocumentControls}
                    /> : null}>
                  <div className={`conversation-canvas is-tree-browser is-document-workspace${isResizingChatPanel ? " is-resizing-panel" : ""}`}
                    aria-label="Documents side by side" ref={canvasRef} style={conversationCanvasStyle}>
                    {scrollingDocuments.map((conversation) => <Fragment key={conversation.id}>
                      {renderExpandedTreeConversation(conversation)}
                      {renderDocumentMarginNotes(conversation)}
                    </Fragment>)}
                    {maximizedDocument && maximizedIsPinned ? <>
                      {renderExpandedTreeConversation(maximizedDocument)}
                      {renderDocumentMarginNotes(maximizedDocument)}
                    </> : null}
                    {!scrollingDocuments.length ? <div className="document-workspace-empty">
                      <p>Open a document from the sidebar or add a side document here.</p>
                      <button type="button" onClick={() => handleAddSideChat(activeConversation.id)}>New side document</button>
                    </div> : null}
                  </div>
                  </DocumentWorkspaceLayout>
                  </div>
                </div>
              </WorkspaceView>
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

          {!isTileView && !isGraphView && !maximizedDocument && connections.length ? (
            <ConnectorOverlay
              connections={connections}
              occlusionRects={connectorOcclusionRects}
              onNavigate={handleNavigateDocumentConnector}
            />
          ) : null}

          {createSlot && mainViewMode === "chat" && !leftSidebarOpen ? <MobileCreateMenu slot={createSlot} prepare={prepareCreateMenu}
            onNewDocument={handleCreateMainConversation} onSideDocument={handleCreateMenuSideDocument} onMarginNote={handleCreateMenuNote}
            onUpload={handleCreateMenuUpload} /> : null}
          {!isTileView && caretMenu && !selectionDraft ? <CaretActions menu={caretMenu} mobile={mobileKeyboard.mobile} onClose={closeCaretMenu}
            onNote={() => handleCreateSelectionNote(caretMenu.paragraph)}
            onSideDocument={() => handleCreateSelectionSideDocument(caretMenu.paragraph)}
            onLink={() => {
              if (!caretMenu.paragraph) return;
              // Link reuses the selection toolbar's picker, on the whole paragraph.
              setSelectionDraft(caretMenu.paragraph); setSelectionIntent("link"); setSelectionLinkError(null);
              if (mobileKeyboard.mobile) setSelectionActionsExpanded(true);
            }}
            onFindRelated={() => handleFindRelatedToSelection(caretMenu.paragraph)} /> : null}
          {!isTileView && selectionDraft ? (
            mobileKeyboard.mobile && !selectionActionsExpanded ? <MobileSelectionActions
              rect={selectionDraft.rect} formRef={toolbarRef}
              disabled={Boolean(pendingConversationIds[selectionDraft.conversationId])}
              onExplain={() => handleSelectionQuickAction(EXPLAIN_SELECTION_PROMPT)}
              onRewrite={selectionIsDiagram ? undefined : () => handleSelectionQuickAction(REWRITE_SELECTION_PROMPT)}
              onAsk={() => openMobileSelectionPrompt()}
              onSideDocument={() => handleCreateSelectionSideDocument()}
              onMarginNote={() => handleCreateSelectionNote()}
              onLink={() => { setSelectionLinkError(null); setSelectionIntent("link"); setSelectionActionsExpanded(true); }}
              onFindRelated={() => handleFindRelatedToSelection()}
              onHighlight={selectionDraft.sourceBlockId && !selectionIsDiagram ? handleToggleSelectionHighlight : undefined}
              highlighted={selectionHighlighted}
              marginNoteLabel={selectionDraft.sourceKind === "standalone-note" ? "Side note" : "Margin note"}
              onClose={() => { setSelectionDraft(null); window.getSelection()?.removeAllRanges(); }}
            /> : mobileKeyboard.mobile && selectionIntent === "branch" ? <MobileComposerViewport>
              <MobileAIComposer formRef={toolbarRef} testId="branch-composer" className="selection-mobile-composer"
                textareaId="branch-prompt" promptLabel="Branch prompt" quote={selectionIsDiagram ? undefined : selectionDraft.quote} contextLabel={selectionIsDiagram ? "Diagram" : undefined}
                placeholder={selectionIsDiagram ? DIAGRAM_PROMPT_PLACEHOLDER : undefined}
                prompt={selectionDraft.prompt}
                onPromptChange={(prompt) => setSelectionDraft((current) => current ? { ...current, prompt } : current)}
                onSubmit={() => handleCreateBranch()}
                onClose={() => { setSelectionDraft(null); window.getSelection()?.removeAllRanges(); }}
                disabled={Boolean(pendingConversationIds[selectionDraft.conversationId])}
                initiallyOpenOptions={selectionOptionsInitiallyOpen}
                options={<>
                  {selectionConversation ? <button type="button" aria-label="Choose AI model and provider"
                    aria-haspopup="dialog" aria-expanded={selectionModelOpen} onClick={() => setSelectionModelOpen(true)}>
                    Model: {selectionConversation.serviceId === "backend-services" ? "Auto" : getBackendServiceModel(selectionConversation.serviceId, selectionConversation.modelId)?.label ?? selectionConversation.modelId} ⌄
                  </button> : null}
                  {selectionConversation && selectionDraft.sourceBlockId ? <AgentModeToggle controls={agentModeControls(selectionConversation)} disabled={Boolean(pendingConversationIds[selectionConversation.id])}/> : null}
                  {selectionDraft.sourceBlockId ? <div className="document-ai-options">
                    <div role="group" aria-label="Response destination">
                      <button type="button" aria-pressed={selectionResponseDestination === "inline"} onClick={() => setSelectionResponseDestination("inline")}>In this document</button>
                      <button type="button" aria-pressed={selectionResponseDestination === "side"} onClick={() => setSelectionResponseDestination("side")}>Side document ↗</button>
                    </div>
                    {selectionResponseDestination === "inline" ? <label><input type="checkbox" checked={selectionReplaceText} onChange={(event) => setSelectionReplaceText(event.target.checked)}/>{selectionIsDiagram ? "Change the diagram in place" : "Replace selection"}</label> : null}
                  </div> : null}
                  <button type="button" aria-label="Create a side document from this passage"
                    onClick={() => handleCreateSelectionSideDocument()}>Side document</button>
                  <button type="button" aria-label={selectionDraft.sourceKind === "standalone-note" ? "Create a side note" : "Add a margin note"}
                    onClick={() => handleCreateSelectionNote()}>{selectionDraft.sourceKind === "standalone-note" ? "Side note" : "Margin note"}</button>
                  <button type="button" aria-label="Link selected text to an existing document or block"
                    onClick={() => { setSelectionLinkError(null); setSelectionIntent("link"); }}>Link to existing</button>
                </>}
              />
            </MobileComposerViewport> :
            <SelectionComposerFrame mobile={mobileKeyboard.mobile}>
            <form
              className={`selection-tooltip${mobileKeyboard.mobile ? "" : " is-toolbar"}`}
              data-testid="branch-composer"
              onSubmit={(event) => {
                event.preventDefault();
                if (selectionIntent === "branch") handleCreateBranch();
              }}
              ref={toolbarRef}
              style={mobileKeyboard.mobile ? undefined : toolbarStyle}
            >
              {mobileKeyboard.mobile ? <div className="selection-tooltip-head">
                <p className="eyebrow">Link this passage</p>
                <button aria-label="Cancel link" className="selection-close" onClick={closeSelectionDraft} type="button">
                  <CloseIcon />
                </button>
              </div> : <SelectionToolbarRow
                actions={[
                  ...(selectionDraft.sourceBlockId && !selectionIsDiagram ? [{ icon: "highlight" as const, label: "Highlight", ariaLabel: selectionHighlighted ? "Remove highlight" : "Highlight selected text",
                    pressed: selectionHighlighted, onSelect: handleToggleSelectionHighlight }] : []),
                  { icon: "note", label: "Note", ariaLabel: selectionDraft.sourceKind === "standalone-note" ? "Create a side note" : "Add a margin note", onSelect: () => handleCreateSelectionNote() },
                  { icon: "side", label: "Side doc", ariaLabel: "Create a side document from this passage", onSelect: () => handleCreateSelectionSideDocument() },
                  { icon: "link", label: "Link", ariaLabel: "Link selected text to an existing document or block", pressed: selectionIntent === "link",
                    onSelect: () => { setSelectionLinkError(null); setSelectionIntent((intent) => intent === "link" ? "actions" : "link"); } },
                ]}
                more={[
                  { icon: "copy", label: "Copy", hint: "⌘C", onSelect: () => { void copySelection(); } },
                  { icon: "find", label: "Find related", onSelect: () => handleFindRelatedToSelection() },
                  { icon: "explain", label: "Explain", ai: true, disabled: selectionPending, onSelect: () => handleSelectionQuickAction(EXPLAIN_SELECTION_PROMPT) },
                  ...(selectionIsDiagram ? [] : [{ icon: "rewrite" as const, label: "Rewrite", ai: true, disabled: selectionPending, onSelect: () => handleSelectionQuickAction(REWRITE_SELECTION_PROMPT) }]),
                ]}
                ask={{ icon: "ai", label: "Ask AI", ariaLabel: selectionIsDiagram ? "Ask AI to change this diagram" : "Ask AI about this passage", pressed: selectionIntent === "branch",
                  onSelect: () => setSelectionIntent((intent) => intent === "branch" ? "actions" : "branch") }}
              />}
              {selectionIntent === "branch" && !mobileKeyboard.mobile ? <div className="selection-toolbar-panel">
                <div className="selection-input-row">
                  <input
                    aria-label="Branch prompt"
                    autoFocus
                    id="branch-prompt"
                    inputMode="text"
                    onChange={(event) =>
                      setSelectionDraft((current) =>
                        current
                          ? { ...current, prompt: event.target.value }
                          : current,
                      )
                    }
                    placeholder={selectionIsDiagram ? DIAGRAM_PROMPT_PLACEHOLDER : BRANCH_PROMPT_PLACEHOLDER}
                    type="text"
                    value={selectionDraft.prompt}
                  />
                  <button
                    aria-label="Create branch with prompt"
                    className="selection-send"
                    disabled={!selectionDraft.prompt.trim() || selectionPending}
                    type="submit"
                  >
                    <SendIcon />
                  </button>
                </div>
                <div aria-label="Quick asks" className="selection-quick-asks" role="group">
                  {selectionIsDiagram ? <>
                    <button type="button" disabled={selectionPending} onClick={() => handleCreateBranch(SIMPLIFY_DIAGRAM_PROMPT)}>Simplify</button>
                    <button type="button" disabled={selectionPending} onClick={() => handleCreateBranch(MATCH_DIAGRAM_PROMPT)}>Match the document</button>
                  </> : <>
                    <button type="button" disabled={selectionPending} onClick={handleExplainSelection}>Explain</button>
                    <button type="button" disabled={selectionPending} onClick={() => handleCreateBranch(REWRITE_SELECTION_PROMPT)}>Rewrite</button>
                  </>}
                </div>
                {selectionDraft.sourceBlockId ? <div className="document-ai-options">
                  <div role="group" aria-label="Response destination"><button type="button" aria-pressed={selectionResponseDestination === "inline"} onClick={()=>setSelectionResponseDestination("inline")}>In this document</button><button type="button" aria-pressed={selectionResponseDestination === "side"} onClick={()=>setSelectionResponseDestination("side")}>Side document ↗</button></div>
                  {selectionResponseDestination === "inline" ? <label><input type="checkbox" checked={selectionReplaceText} onChange={(event)=>setSelectionReplaceText(event.target.checked)}/>{selectionIsDiagram ? "Change the diagram in place" : "Replace selection"}</label> : null}
                </div> : null}
                <div className="selection-actions">
                  {selectionConversation ? <button type="button" className="selection-explain" aria-label="Choose AI model and provider"
                    aria-haspopup="dialog" aria-expanded={selectionModelOpen} onClick={() => setSelectionModelOpen(true)}>
                    {selectionConversation.serviceId === "backend-services" ? "Auto" : getBackendServiceModel(selectionConversation.serviceId, selectionConversation.modelId)?.label ?? selectionConversation.modelId} ⌄
                  </button> : null}
                  {selectionConversation && selectionDraft.sourceBlockId ? <AgentModeToggle controls={agentModeControls(selectionConversation)} disabled={selectionPending}/> : null}
                </div>
              </div> : null}
              {selectionIntent === "link" ? <div className={mobileKeyboard.mobile ? undefined : "selection-toolbar-panel"}>
                <DocumentLinkPicker
                  conversations={state.conversations} sourceConversationId={selectionDraft.conversationId}
                  sourceBlockId={selectionDraft.sourceBlockId} onSelect={handleCreateDocumentLink}
                  onCancel={() => mobileKeyboard.mobile ? closeSelectionDraft() : setSelectionIntent("actions")} error={selectionLinkError ?? undefined}
                />
              </div> : null}
            </form>
            </SelectionComposerFrame>
          ) : null}

          {selectionConversation && selectionIntent === "branch" ? <ServicePickerModal
            isOpen={selectionModelOpen} onClose={() => setSelectionModelOpen(false)}
            currentServiceId={selectionConversation.serviceId} currentModelId={selectionConversation.modelId}
            recentSelections={recentModelSelections}
            onSelectModel={(serviceId, modelId) => handleModelChange(selectionConversation.id, serviceId, modelId)}
            contextControls={<AIControls conversation={selectionConversation} conversations={state.conversations}
              disabled={Boolean(pendingConversationIds[selectionConversation.id])}
              onChange={(settings) => handleAISettingsChange(selectionConversation.id, settings)} />}
          /> : null}

          <VaultSearchPalette
            conversations={state.conversations}
            currentConversationId={activeConversation?.id}
            currentFamilyTitle={activeConversation ? state.conversations[getConversationRootId(state.conversations, activeConversation.id) ?? activeConversation.id]?.title : undefined}
            isOpen={searchModalOpen}
            onClose={handleCloseSearch}
            onExplore={() => { setSearchModalOpen(false); setSearchExploreOpen(true); }}
            onKeepOpen={(query, scope) => { handleCloseSearch(); setMainViewMode("chat"); setSearchPanel({ query, scope }); }}
            onOpenDocument={handleOpenVaultSearchDocument}
            onOpenPassage={handleOpenVaultSearchPassage}
            onQueryChange={setSearchQuery}
            openingPath={vault.openingPath ?? null}
            provider={vaultSearchProvider}
            query={searchQuery}
          />
          <SearchModal
            conversations={state.conversations}
            currentConversation={activeConversation}
            groups={state.groups}
            categories={jev.categories}
            jev={{ userId: user.id, enabled: jevEnabled, ready: vault.ready, serviceStatus: jev.status }}
            onOpenSource={handleOpenSearchSource}
            isOpen={searchExploreOpen}
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
            initialCaptureId={captureHandoff?.captureId}
            initialIntent={captureHandoff?.intent}
            onClose={closeCaptureInbox}
            onOpenNote={(capture) => {
              setSelectionDraft(null);
              setMainViewMode("chat");
              setState((current) => openCaptureAsNote(current, capture));
              closeCaptureInbox();
              if (isMobileViewport) setLeftSidebarOpen(false);
            }}
            onAskAI={(capture, prompt) => {
              setSelectionDraft(null);
              setMainViewMode("chat");
              setState((current) => {
                const next = openCaptureAsNote(current, capture);
                currentStateRef.current = next;
                return next;
              });
              setCaptureAIRequest({ conversationId: `web-capture-${capture.id}`, prompt });
              closeCaptureInbox();
              if (isMobileViewport) setLeftSidebarOpen(false);
            }}
          /> : null}

          {vault.ready && onboarding.tour === "active" ? <GuidedTour steps={tourSteps} step={onboarding.step}
            onStep={(step) => updateOnboarding({ step })}
            onPause={() => updateOnboarding({ tour: "paused" })}
            onFinish={() => updateOnboarding({ tour: "done", step: 0 })} /> : null}
          {vault.ready && onboarding.tour === "paused" ? <TourPill step={onboarding.step} total={tourSteps.length}
            askToHide={starterTasksDone.size >= 3 && !onboarding.keepPill}
            onResume={() => { handleSetMainViewMode("chat"); updateOnboarding({ tour: "active" }); }}
            onHide={() => updateOnboarding({ tour: "done", step: 0 })}
            onKeep={() => updateOnboarding({ keepPill: true })} /> : null}
          {aiAccessOpen && <AIAccessDialog message={null} submitting={billingSubmitting} onClose={() => setAIAccessOpen(false)}
            onUseOwnKey={() => { setAIAccessOpen(false); openApiKeySettings(); }}
            onAddMoney={() => { setAIAccessOpen(false); void onAddMoney(500); }}
            onSubscribe={() => { setAIAccessOpen(false); void onStartSubscription("plus"); }} />}
          {historyImportOpen && <ChatHistoryImport
            existingIds={Object.keys(state.conversations)} cloudSyncEnabled={cloudSyncEnabled}
            onImport={async (chats) => {
              const result = await vault.importChatHistory(chats);
              finishChatImportReminder(storageUserId);
              return result;
            }} onUndo={vault.undoChatHistory}
            onOpenChat={(id) => handleSelectConversation(id, { nextViewMode: "chat" })}
            onClose={() => setHistoryImportOpen(false)}
          />}
          <SettingsPage
            initialTab={profileInitialTab}
            onOpenWebsiteSettings={onOpenWebsiteSettings}
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
            onChangePassword={onChangePassword}
            onDeleteAccount={onDeleteAccount}
            onStartSubscription={onStartSubscription}
            onUpgradeToPlus={onUpgradeToPlus}
            onSave={handleSaveProfile}
            user={user}
            theme={theme}
            onSetTheme={onSetTheme}
            mainViewMode={mainViewMode}
            onSetMainViewMode={handleSetMainViewMode}
            jevEnabled={jevEnabled}
            jevStatus={jev.status}
            onSetJevEnabled={setJevEnabled}
            vaultIndex={vault.storageMode === "server" ? vaultIndex : undefined}
            guest={guest}
          />
          </main>
        </div>
      </div>
    </div>
    </ConversationGroupPickerContext.Provider>
    </DocumentTitleSuggestionContext.Provider>
    </VaultMediaContext.Provider>
  );
}

function SelectionComposerFrame({ mobile, children }: { mobile: boolean; children: React.ReactNode }) {
  return mobile ? <MobileComposerViewport>{children}</MobileComposerViewport> : <>{children}</>;
}
