import { useFeature } from "../lib/features";
import DismissibleDetails from "./DismissibleDetails";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import ConversationGraphView, { type ConversationGraphViewProps } from "./ConversationGraphView";
import { requestUrlMap, type UrlMapAIOptions } from "../lib/urlMap";
import type { PublicExpansion, PublicTopic } from "../lib/publicKnowledge";
import type { PublicMapAccount } from "./PublicTopicInsights";
import { MapTopicSourcesPanel } from "./TopicSources";
import { fallbackQuestion } from "./MapSearchFallbacks";
import { askAboutNote, type PrivateAnswer } from "../lib/publicMapApi";
import { expandWikipediaTopic, findWikipediaTopic, searchWikipediaTopics } from "../lib/wikipedia";
import { ApiError } from "../lib/apiError";
import {
  addExplored, answerItems, expansionItems, forgetExplored, isFullWebAddress, pageItemId, pageItems, parentKey, publicTopicFromAnswer,
  setExpansion, setOnMap, settleExplored, topicItem, webAddress,
  type ExploredBatch, type ExploredItem, type ExploredParent, type MapExploration,
} from "../lib/mapExploration";
import { useMapExploration } from "../lib/useMapExploration";
import { MapExploredHistory, MapPreviewBar, MapPreviewDetails, MapPreviewLayer, MapSearchLookFurther, looksLikeQuestion } from "./MapPreviews";
import { getStandaloneNote } from "../lib/standaloneNotes";
import TopicExplorer from "./TopicExplorer";
import type { Conversation } from "../types";
import { MapCourseEmpty, MapModeSwitch, MapRoadmapCourse } from "./MapRoadmapCourse";
import { draftingLabel, lessonContext, MapPathBar, MapPathLayer, MapPathStepStrip, MapPathPickBanner, MapPathPicker, MapPathsMenu, MapRoadmapFlags, type MapPathActions } from "./MapPaths";
import { buildMapPath, isPathDocument, withDraftPreview, listMapPaths, readActivePath, readPathLayout, rememberActivePath, rememberPathLayout } from "../lib/mapPaths";
import type { MapSpotlight } from "../lib/mapSpotlight";
import { readExploreLayout, writeExploreLayout, type ExploreLayout } from "../lib/exploreLibrary";
import { readExploreSource, writeExploreSource, type BrowseNode, type ExploreSource } from "../lib/exploreSources";
import ExploreSourceMenu from "./ExploreSourceMenu";
import ExplorePublic from "./ExplorePublic";
import WikipediaPane from "./WikipediaPane";
import TopicDetailsPane, { topicDetailsQuestion } from "./TopicDetailsPane";
import { isPassageNote, type PassageNote } from "../lib/wikipediaReader";
import { explorerStorageKey, addRoot, aiSubtopicQuestion } from "../lib/topicExplorer";
import { emptyExploration, topicItemId } from "../lib/mapExploration";
import { resolveWikipediaTitles, wikipediaArticleUrl } from "../lib/wikipedia";
import "./KnowledgeGraphWorkspace.css";

interface Props extends ConversationGraphViewProps {
  /** Opens Settings → Features; offered at the end of the map's ⋯ menu. */
  onMoreFeatures?: () => void;
  onToggleSidebar?: () => void;
  sidebarOpen?: boolean;
  urlMapAIOptions?: UrlMapAIOptions;
  onSavePublicTopic: (topic: PublicTopic) => void;
  publicMapAccount?: PublicMapAccount;
  onCreateMapNote: (args: { linkedTo?: string; url?: string; position?: { x: number; y: number } }) => void;
  onSetMapConnection: (sourceId: string, targetId: string, connected: boolean) => void;
  onRemoveMapNote: (id: string) => void;
  onUndoMapEdit: () => void;
  /** Put the map's last-edit notice away (its Undo goes with it). */
  onDismissMapEdit?: () => void;
  mapEditMessage?: string;
  canUndoMapEdit?: boolean;
  onAddChildNote?: (conversationId: string) => void;
  onExpandTopicWithAI?: (conversationId: string) => void;
  onCancelTopicExpansion?: () => void;
  expandingTopicId?: string | null;
  topicExpansionProgress?: string;
  topicExpansionError?: { conversationId: string; message: string } | null;
  onDismissTopicExpansionError?: () => void;
  /** Adds a page of Wikipedia connections to a note; returns how many were new. */
  onAddTopicConnections?: (conversationId: string, expansion: PublicExpansion) => number;
  /** Saves a private AI answer as a note under the given note, or on its own when there is none. */
  onSavePrivateAnswer?: (conversationId: string | null, answer: PrivateAnswer) => void;
  /** Turns previews into notes; returns the note each one became. */
  onKeepExplored?: (exploration: MapExploration, ids: string[], detached?: string[]) => Record<string, string>;
  /** Makes a document with this text, under `parentId` when given; returns its id. Used by Explore. */
  onCreateExploreDocument?: (args: { title: string; content: string; parentId?: string }) => string | null;
  /** Paths (roadmaps drawn on the map): making, changing and drafting them. */
  paths?: MapPathActions;
  /** Turn this roadmap on (a new requestId asks again). */
  /** Turns a roadmap on; `learn` opens it as a course instead of on the map. */
  pathRequest?: { id: string; requestId: number; learn?: boolean } | null;
  /** Every roadmap as tiles: Tile view's Roadmaps tab. */
  onShowAllRoadmaps?: () => void;
  /** Document, Tile and Map, shown beside the sidebar's button while the sidebar is closed. */
  viewToggle?: ReactNode;
}

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const hostname = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")));

export default function KnowledgeGraphWorkspace({ isVisible = true, onToggleSidebar, sidebarOpen, urlMapAIOptions, onSavePublicTopic, publicMapAccount, onCreateMapNote, onSetMapConnection, onRemoveMapNote, onUndoMapEdit, onDismissMapEdit, mapEditMessage, canUndoMapEdit, onAddChildNote, onExpandTopicWithAI, onCancelTopicExpansion, expandingTopicId, topicExpansionProgress, topicExpansionError, onDismissTopicExpansionError, onAddTopicConnections, onSavePrivateAnswer, onKeepExplored, onCreateExploreDocument, paths: pathActions, pathRequest, onMoreFeatures, onShowAllRoadmaps, viewToggle, ...personalProps }: Props) {
  const mapTools = useFeature("mapTools");
  const [sourcesFor, setSourcesFor] = useState<string | "add" | null>(null);
  const [addedTopicId, setAddedTopicId] = useState<string | null>(null);
  const [personalFocus, setPersonalFocus] = useState<Props["focusRequest"]>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [sourceFormOpen, setSourceFormOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [exploration, updateExploration] = useMapExploration(personalProps.workspaceKey ?? "workspace", publicMapAccount?.userId);
  const [selectedPreview, setSelectedPreview] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Explore mode: a scratch map of any topic in place of the person's own map. */
  const [exploring, setExploring] = useState(false);
  /** The Wikipedia article the topic graph starts from, when Canvas was picked on a public source. */
  const [exploringFrom, setExploringFrom] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<{ label: string; progress: string; controller: AbortController } | null>(null);
  const [exploreMessage, setExploreMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [revealRequest, setRevealRequest] = useState<{ ids: string[]; requestId: number } | null>(null);
  const [searchRequest, setSearchRequest] = useState<{ query: string; requestId: number } | null>(null);
  const counter = useRef(0);
  const busyRef = useRef<typeof busy>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pendingKept = useRef<Record<string, string>>({});
  // Lookup notices float just under the map header, which wraps to several rows on narrow screens.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const header = panel?.querySelector<HTMLElement>(".graph-map-navigation");
    if (!panel || !header) return;
    const place = () => panel.style.setProperty("--map-header-bottom", `${Math.max(0, header.getBoundingClientRect().bottom - panel.getBoundingClientRect().top)}px`);
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  const conversations = personalProps.conversations;
  const savedTopics = useMemo(() => {
    const index: Record<string, string> = {};
    for (const conversation of Object.values(conversations)) {
      const topic = conversation.publicTopic;
      if (topic) for (const id of [topic.id, ...topic.aliases]) index[id] ??= conversation.id;
    }
    return index;
  }, [conversations]);
  // Recent documents, offered as starting topics in Explore mode.
  const mapTitles = useMemo(() => Object.values(conversations)
    .filter((conversation) => !conversation.parentId && !conversation.hiddenFromAI && conversation.title.trim() && !/^(untitled|new chat)\b/i.test(conversation.title.trim()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6).map((conversation) => conversation.title.trim().slice(0, 80)), [conversations]);
  const documentList = useMemo(() => Object.values(conversations)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((conversation) => ({ id: conversation.id, title: conversation.title.trim() || "Untitled" })), [conversations]);
  const latest = useRef({ conversations, savedTopics, exploration });
  latest.current = { conversations, savedTopics, exploration };

  /** Explored items already in the workspace leave history; what hung off them hangs off the note. */
  const settle = useCallback((state: MapExploration) => {
    const { conversations: current, savedTopics: topics } = latest.current;
    return settleExplored(state, (item) => {
      const kept = pendingKept.current[item.id];
      if (kept && current[kept]) return kept;
      if (item.source.kind === "topic") return topics[item.source.topic.id] ?? null;
      if (item.source.kind === "page") { const id = `url-topic-${item.source.nodeId}`; return current[id] ? id : null; }
      return null;
    });
  }, []);
  useEffect(() => { updateExploration(settle); }, [conversations, savedTopics, settle, updateExploration]);

  // A topic added from Wikipedia opens its own sources, ready for its connections.
  useEffect(() => {
    const id = addedTopicId ? savedTopics[addedTopicId] : undefined;
    if (!id) return;
    setAddedTopicId(null);
    openSources(id);
    setPersonalFocus({ conversationId: id, requestId: -(++counter.current) });
  }, [addedTopicId, savedTopics]);

  useEffect(() => () => busyRef.current?.controller.abort(), []);

  // A link pasted or dropped on the map goes into the map search, which offers what to do with it.
  useEffect(() => {
    if (!isVisible) return;
    function onPaste(event: ClipboardEvent) {
      if (editable(event.target) || editable(document.activeElement)) return;
      const active = document.activeElement;
      if (active && active !== document.body && !sectionRef.current?.contains(active)) return;
      const url = webAddress(event.clipboardData?.getData("text/plain") ?? "");
      if (!url) return;
      event.preventDefault();
      setSearchRequest({ query: url, requestId: ++counter.current });
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [isVisible]);

  function droppedLink(event: DragEvent) {
    if (!event.dataTransfer.types.includes("text/uri-list")) return null;
    return webAddress(event.dataTransfer.getData("text/uri-list").split("\n").find((line) => line && !line.startsWith("#")) ?? "");
  }

  function openSources(id: string | "add") { setSourcesFor(id); setSelectedPreview(null); setHistoryOpen(false); }
  function focusDocument(id: string) { setPersonalFocus({ conversationId: id, requestId: -(++counter.current) }); }

  // ---- Paths: a roadmap drawn over the map ----
  const pathsKey = personalProps.workspaceKey ?? "workspace";
  const [activePathId, setActivePathIdState] = useState<string | null>(() => readActivePath(pathsKey));
  /** Paths gone into from a step (Dive deeper), outermost first. */
  const [pathTrail, setPathTrail] = useState<string[]>([]);
  const [pathLayout, setPathLayoutState] = useState<"map" | "list">(readPathLayout);
  const [pathFrame, setPathFrame] = useState(1);
  const [mapSelection, setMapSelection] = useState<string | null>(null);
  const [picking, setPicking] = useState<string[] | null>(null);
  const [pathMessage, setPathMessage] = useState<string | null>(null);
  const hasPaths = Boolean(pathActions);
  const pathSummaries = useMemo(() => hasPaths ? listMapPaths(conversations) : [], [hasPaths, conversations]);
  const activePathNote = activePathId && isPathDocument(conversations[activePathId]) ? conversations[activePathId] : null;
  /** Where each roadmap starts on the map, so it can wear a flag there. */
  const roadmapStarts = useMemo(() => hasPaths ? pathSummaries.flatMap((summary) => {
    const note = conversations[summary.id];
    const first = note ? buildMapPath(note, conversations).steps[0] : undefined;
    return first ? [{ ...summary, docId: first.docId }] : [];
  }).slice(0, 12) : [], [hasPaths, pathSummaries, conversations]);
  const savedActivePath = useMemo(() => activePathNote && hasPaths ? buildMapPath(activePathNote, conversations) : null, [activePathNote, hasPaths, conversations]);
  // While AI drafts the roadmap, its lessons stream onto it as they are written; they are saved when the run ends.
  const streamingDraft = activePathId ? pathActions?.progress[activePathId]?.roadmapDraft : undefined;
  const activePathDrafting = Boolean(activePathId && pathActions?.writingIds[activePathId]);
  const activePath = savedActivePath;
  const coursePath = useMemo(() => savedActivePath && activePathDrafting ? withDraftPreview(savedActivePath, streamingDraft, conversations) : savedActivePath,
    [savedActivePath, activePathDrafting, streamingDraft, conversations]);
  /** The lesson whose step details were closed with ×; they come back when another lesson is picked. */
  const [stepHiddenFor, setStepHiddenFor] = useState<string | null>(null);
  useEffect(() => { setStepHiddenFor(null); }, [mapSelection]);
  // Turning a roadmap on shows the whole map, so every step is in view wherever it sits.
  const [scopeRequest, setScopeRequest] = useState<{ choice: "all"; requestId: number } | null>(null);
  function setActivePath(id: string | null, trail: string[] = []) {
    setActivePathIdState(id); setPathTrail(trail); setPathMessage(null); setPathFrame((frame) => frame + 1);
    if (id && id !== activePathId) setScopeRequest({ choice: "all", requestId: ++counter.current });
    // Turning a roadmap on opens it in Learn, as a course.
    if (id && id !== activePathId) { setPathLayout("list"); setLearnEmpty(false); }
    rememberActivePath(pathsKey, id);
  }
  function setPathLayout(layout: "map" | "list") { setPathLayoutState(layout); rememberPathLayout(layout); }
  // Learn shows a roadmap as a course ("list" is its stored name); Explore is the map itself.
  const [learnEmpty, setLearnEmpty] = useState(false);
  function chooseMapMode(next: "learn" | "explore") {
    if (next === "explore") { setLearnEmpty(false); setPathLayout("map"); return; }
    setPathLayout("list");
    if (activePath) return;
    const first = pathSummaries[0];
    if (first) { setPicking(null); setActivePath(first.id); } else setLearnEmpty(true);
  }
  // Explore draws the same notes as Tiles, Clusters or the free Canvas; the choice follows the account.
  const [exploreLayout, setExploreLayoutState] = useState<ExploreLayout>(readExploreLayout);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === null || event.key === "margin-chat:explore-layout") setExploreLayoutState(readExploreLayout()); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  // Where Explore starts: your notes, Wikipedia, or a topic AI splits up. Follows the account too.
  const [exploreSource, setExploreSourceState] = useState<ExploreSource>(readExploreSource);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === null || event.key === "margin-chat:explore-source") setExploreSourceState(readExploreSource()); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  function chooseExploreSource(source: ExploreSource) {
    setExploreSourceState(source); writeExploreSource(source); setSidePane(null);
    // Public sources open in Tiles or Clusters; the free Canvas is your own map.
    if (source.kind !== "notes" && exploreLayout === "canvas") chooseExploreLayout("tiles");
  }
  /** The article or topic Explore is on, so Canvas can grow a graph from it. */
  const publicPlace = useRef<string | undefined>(undefined);
  function chooseExploreLayout(layout: ExploreLayout) {
    // On Wikipedia or an AI topic, Canvas is the topic graph, grown from where you are.
    if (layout === "canvas" && exploreSource.kind !== "notes") {
      setExploringFrom(publicPlace.current ?? (exploreSource.kind === "ai" ? exploreSource.topic : undefined));
      setExploring(true); setSelectedPreview(null); setHistoryOpen(false); setSourcesFor(null); setConnectingId(null);
      return;
    }
    setExploreLayoutState(layout); writeExploreLayout(layout);
  }
  // Beside Tiles or Clusters: a Wikipedia article, Topic details, or a note you made from a topic.
  const [sidePane, setSidePane] = useState<{ kind: "wikipedia"; title: string } | { kind: "details"; node: BrowseNode } | { kind: "document"; id: string } | null>(null);
  const setReaderTitle = (title: string | null) => setSidePane(title ? { kind: "wikipedia", title } : null);
  const passagesKey = `${explorerStorageKey(personalProps.workspaceKey ?? "workspace")}:passages`;
  const [passageNotes, setPassageNotesState] = useState<PassageNote[]>(() => {
    try { const value = JSON.parse(window.localStorage.getItem(passagesKey) ?? "[]"); return Array.isArray(value) ? value.filter(isPassageNote) : []; }
    catch { return []; }
  });
  const setPassageNotes = (change: (notes: PassageNote[]) => PassageNote[]) => setPassageNotesState((current) => {
    const next = change(current);
    try { window.localStorage.setItem(passagesKey, JSON.stringify(next.slice(-300))); } catch { /* Passage notes stay for this visit. */ }
    return next;
  });
  // Notes in the vault by title, so a public topic you already have a note on says so.
  const notesByTitle = useMemo(() => {
    const index = new Map<string, string>();
    for (const conversation of Object.values(conversations)) {
      const title = conversation.title.trim().toLocaleLowerCase();
      if (title && !index.has(title)) index.set(title, conversation.id);
    }
    return index;
  }, [conversations]);
  const noteFor = useCallback((label: string, topic?: PublicTopic) => (topic ? savedTopics[topic.id] : undefined) ?? notesByTitle.get(label.trim().toLocaleLowerCase()) ?? null,
    [savedTopics, notesByTitle]);
  const askSubtopics = useMemo(() => publicMapAccount?.canAsk ? async (label: string, existing: string[], signal: AbortSignal) => {
    const answer = await askAboutNote({ userId: publicMapAccount.userId, topic: { label: label.slice(0, 200), description: "" }, noteContent: "",
      question: aiSubtopicQuestion(label, existing), options: publicMapAccount.aiOptions, signal });
    const exploredAt = new Date().toISOString();
    return answer.related.map((topic) => publicTopicFromAnswer(topic, exploredAt));
  } : undefined, [publicMapAccount]);
  async function keepPublic(node: BrowseNode): Promise<{ id: string } | { error: string }> {
    try {
      const topic = node.topic ?? (node.article ? (await resolveWikipediaTitles([node.article])).get(node.article) : undefined);
      if (!topic) return { error: "Wikipedia has no topic page for this, so it can't be kept as a note yet." };
      const createdAt = new Date().toISOString();
      const state = addRoot(emptyExploration(), topic, { id: `explore-${createdAt}`, title: topic.label, createdAt });
      const id = onKeepExplored?.(state, [topicItemId(topic)])?.[topicItemId(topic)];
      return id ? { id } : { error: "That note could not be made. Try again." };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "That note could not be made. Try again." };
    }
  }
  const askDetails = useMemo(() => publicMapAccount?.canAsk ? async (label: string, signal: AbortSignal) => {
    const answer = await askAboutNote({ userId: publicMapAccount.userId, topic: { label: label.slice(0, 200), description: "" }, noteContent: "",
      question: topicDetailsQuestion(label), options: publicMapAccount.aiOptions, signal });
    return answer.answer;
  } : undefined, [publicMapAccount]);
  /** Makes a note in the vault and opens it beside Explore; returns why it could not. */
  function notePublic(title: string, content: string): string | null {
    if (!onCreateExploreDocument) return "Notes can't be made here.";
    const id = onCreateExploreDocument({ title: title.slice(0, 200), content });
    if (!id) return "That note could not be made. Try again.";
    setSidePane({ kind: "document", id });
    return null;
  }
  const newPublicNote = (node: BrowseNode) => notePublic(node.label,
    node.article ? `Source: [${node.article} on Wikipedia](${wikipediaArticleUrl(node.article)})\n\n` : "");
  function roadmapFor(node: BrowseNode): string | null {
    if (!pathActions) return "Roadmaps are off. Turn them on in Settings → Features.";
    const goal = node.article ? `Learn ${node.label}: ${wikipediaArticleUrl(node.article)}` : `Learn ${node.label}`;
    const made = pathActions.onDraftPath(goal);
    if ("error" in made) return made.error;
    setActivePath(made.id);
    return null;
  }
  const renderSourceMenu = (onTop: () => void) => <ExploreSourceMenu value={exploreSource} canAsk={Boolean(publicMapAccount?.canAsk)} onChange={chooseExploreSource} onTop={onTop} />;
  const mapMode: "learn" | "explore" = (activePath && pathLayout === "list") || (learnEmpty && !activePath) ? "learn" : "explore";
  // A lesson opened from the course stays a lesson, even when it has its own roadmap (↘ goes into that).
  const openedFromCourse = useRef<string | null>(null);
  useEffect(() => {
    if (!pathRequest) return;
    if (openedFromCourse.current === pathRequest.id) { openedFromCourse.current = null; return; }
    setPicking(null); setActivePath(pathRequest.id);
    if (pathRequest.learn) setPathLayout("list");
  }, [pathRequest?.requestId]);
  // A path that was deleted turns itself off.
  useEffect(() => { if (activePathId && conversations[activePathId] && !isPathDocument(conversations[activePathId])) setActivePath(null); }, [activePathId, conversations]);
  const pathSpotlight = useMemo<MapSpotlight | null>(() => activePath?.steps.length ? {
    label: activePath.name, path: true, requestId: -pathFrame,
    scores: Object.fromEntries(activePath.steps.map((step) => [step.docId, 1])),
  } : null, [activePath, pathFrame]);
  // Steps still only in the cloud come down, so the whole path draws.
  const requestedPathDocs = useRef(new Set<string>());
  useEffect(() => {
    if (!activePathNote || !pathActions?.onLoadDocuments) return;
    const missing = [...new Set((activePathNote.roadmap?.nodes ?? []).map((node) => node.target.docId))]
      .filter((id) => !conversations[id] && !requestedPathDocs.current.has(id));
    if (!missing.length) return;
    missing.forEach((id) => requestedPathDocs.current.add(id));
    pathActions.onLoadDocuments(missing);
  }, [activePathNote, conversations, pathActions]);
  function stepTo(docId: string) { setPersonalFocus({ conversationId: docId, requestId: -(++counter.current), keepViewMode: true }); }
  function startPicking() { setActivePath(null); setPicking([]); setSourcesFor(null); setHistoryOpen(false); setSelectedPreview(null); }
  const pickIds = useMemo(() => picking ? Object.keys(conversations).filter((id) => !isPathDocument(conversations[id])) : [], [picking, conversations]);
  function selectPreview(id: string | null) {
    setSelectedPreview(id);
    if (!id) return;
    setSourcesFor(null); setConnectingId(null);
    if (latest.current.exploration.items[id]?.onMap) setRevealRequest({ ids: [id], requestId: ++counter.current });
  }

  function newBatch(title: string): ExploredBatch {
    return { id: `batch-${Date.now().toString(36)}-${(++counter.current).toString(36)}`, title: title.slice(0, 200), createdAt: new Date().toISOString() };
  }

  /** Puts new previews on the map and brings them into view. */
  function showPreviews(update: (current: MapExploration) => MapExploration, ids: string[]) {
    updateExploration((current) => settle(update(current)));
    if (ids.length) setRevealRequest({ ids, requestId: ++counter.current });
  }

  /** Runs one lookup at a time, with its progress and a Cancel in the notice bar. */
  async function run(label: string, task: (signal: AbortSignal, progress: (text: string) => void) => Promise<void>) {
    busyRef.current?.controller.abort();
    const entry = { label, progress: "", controller: new AbortController() };
    busyRef.current = entry;
    setBusy(entry); setExploreMessage(null);
    try {
      await task(entry.controller.signal, (progress) => { if (busyRef.current === entry) setBusy({ ...entry, progress }); });
    } catch (error) {
      if (entry.controller.signal.aborted) return;
      if (error instanceof ApiError && error.statusCode === 401) publicMapAccount?.onAuthExpired?.();
      setExploreMessage({ text: errorMessage(error, "That could not be explored. Try again."), error: true });
    } finally {
      if (busyRef.current === entry) { busyRef.current = null; setBusy(null); }
    }
  }

  /** Reads Wikipedia connections under a document or preview, skipping pages already in the map. */
  async function loadConnections(topic: PublicTopic, parent: ExploredParent, batch: ExploredBatch, title: string, signal: AbortSignal) {
    let offset = latest.current.exploration.expansions[parentKey(parent)]?.nextOffset ?? 0;
    for (let page = 0; page < 3; page += 1) {
      const expansion = await expandWikipediaTopic(topic, offset, signal);
      signal.throwIfAborted();
      offset = expansion.nextOffset;
      const items = expansionItems(expansion, { parent, batchId: batch.id, exploredAt: new Date().toISOString() })
        .filter((item) => item.source.kind !== "topic" || !latest.current.savedTopics[item.source.topic.id]);
      const fresh = items.filter((item) => !latest.current.exploration.items[item.id]?.onMap);
      showPreviews((current) => setExpansion(addExplored(current, batch, items), parent, { nextOffset: expansion.nextOffset, hasMore: expansion.hasMore }), items.map((item) => item.id));
      if (fresh.length || !expansion.hasMore) {
        if (!fresh.length) setExploreMessage({ text: `Every Wikipedia connection of ${title} is already in your map or on it.`, error: false });
        return;
      }
    }
  }

  function previewTopic(topic: PublicTopic, parent: ExploredParent | null) {
    const existing = latest.current.savedTopics[topic.id];
    if (existing) { focusDocument(existing); showAround(existing); return; }
    const batch = newBatch(topic.label);
    const item = topicItem(topic, { parent, batchId: batch.id, exploredAt: batch.createdAt });
    showPreviews((current) => addExplored(current, batch, [item]), [item.id]);
    selectPreview(item.id);
    void run(`Reading Wikipedia connections for ${topic.label}…`, (signal) => loadConnections(topic, { kind: "item", id: item.id }, batch, topic.label, signal));
  }

  function previewFirstArticle(query: string) {
    void run(`Searching Wikipedia for “${query}”…`, async (signal) => {
      const [topic] = await searchWikipediaTopics(query, signal);
      signal.throwIfAborted();
      if (!topic) throw new Error(`No Wikipedia article matches “${query}”. Ask AI instead, or try other words.`);
      previewTopic(topic, null);
    });
  }

  /** Previews Wikipedia topics around a document in the map, without adding them. */
  function showAround(id: string) {
    const conversation = latest.current.conversations[id];
    if (!conversation) return;
    setConnectingId(null);
    const batch = newBatch(`Around ${conversation.title || "Untitled"}`);
    void run(`Finding Wikipedia topics around ${conversation.title}…`, async (signal) => {
      const saved = conversation.publicTopic;
      const found = saved?.wikipediaUrl ? saved : await findWikipediaTopic(saved?.label ?? conversation.title, signal);
      signal.throwIfAborted();
      if (!found) throw new Error(`Wikipedia has no article that matches “${conversation.title}”. Try the map search instead.`);
      await loadConnections(saved && found !== saved ? { ...found, id: saved.id } : found, { kind: "document", id }, batch, conversation.title, signal);
    });
  }

  function showMoreConnections(item: ExploredItem) {
    if (item.source.kind !== "topic") return;
    const topic = item.source.topic;
    const batch = latest.current.exploration.batches[item.batchId] ?? newBatch(topic.label);
    if (!item.onMap) showPreviews((current) => setOnMap(current, [item.id], true), [item.id]);
    void run(`Reading Wikipedia connections for ${topic.label}…`, (signal) => loadConnections(topic, { kind: "item", id: item.id }, batch, topic.label, signal));
  }

  function mapPage(url: string, parent: ExploredParent | null) {
    const account = publicMapAccount;
    if (!account?.canAsk) return;
    void run(`Reading ${hostname(url)}…`, async (signal, progress) => {
      try {
        const graph = await requestUrlMap({ ...urlMapAIOptions, url, expectedUserId: account.userId, signal, onProgress: progress });
        signal.throwIfAborted();
        const batch = newBatch(graph.source.title || hostname(url));
        const items = pageItems(graph, { parent, batchId: batch.id, exploredAt: new Date().toISOString() });
        showPreviews((current) => addExplored(current, batch, items, [graph]), items.map((item) => item.id));
        selectPreview(pageItemId(graph.rootId));
      } finally { account.onBillingRefresh?.(); }
    });
  }

  function askAI(question: string, parent: ExploredParent | null, context: { label: string; description?: string; noteContent?: string }) {
    const account = publicMapAccount;
    if (!account?.canAsk || question.trim().length < 3) return;
    void run("Asking AI…", async (signal, progress) => {
      try {
        const answer = await askAboutNote({ userId: account.userId, topic: { label: context.label.slice(0, 200) || "Map search", description: (context.description ?? "").slice(0, 2000) },
          noteContent: (context.noteContent ?? "").slice(0, 6000), question: question.slice(0, 500), options: account.aiOptions, signal, onProgress: progress });
        signal.throwIfAborted();
        const batch = newBatch(answer.question);
        const items = answerItems(answer, batch.id.slice(6), { parent, batchId: batch.id, exploredAt: batch.createdAt });
        showPreviews((current) => addExplored(current, batch, items), items.map((item) => item.id));
        selectPreview(items[0].id);
      } finally { account.onBillingRefresh?.(); }
    });
  }

  function keep(ids: string[], detached: string[] = []) {
    if (!onKeepExplored || !ids.length) return;
    const kept = onKeepExplored(latest.current.exploration, ids, detached);
    Object.assign(pendingKept.current, kept);
    if (selectedPreview && kept[selectedPreview]) setSelectedPreview(null);
  }

  /** What a search's previews sit beside: the best match, else a document whose title the search names. */
  function anchorFor(query: string, matchedIds: string[]): ExploredParent | null {
    if (matchedIds[0]) return { kind: "document", id: matchedIds[0] };
    const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const text = ` ${words(query)} `;
    let best: { id: string; length: number } | null = null;
    for (const conversation of Object.values(latest.current.conversations)) {
      const title = words(conversation.title);
      if (title.length >= 3 && text.includes(` ${title} `) && (!best || title.length > best.length)) best = { id: conversation.id, length: title.length };
    }
    return best ? { kind: "document", id: best.id } : null;
  }

  function submitSearch(query: string, matchedIds: string[]) {
    const canAsk = Boolean(publicMapAccount?.canAsk);
    const url = webAddress(query);
    if (url && isFullWebAddress(query)) { if (!canAsk) return false; mapPage(url, anchorFor(query, matchedIds)); return true; }
    if (canAsk && looksLikeQuestion(query)) { askAI(fallbackQuestion(query), anchorFor(query, matchedIds), { label: query }); return true; }
    if (matchedIds.length || query.length < 2) return false;
    previewFirstArticle(query);
    return true;
  }

  function renderActions(conversation: Conversation) {
    const aroundLabel = `Show Wikipedia topics around ${conversation.title}`;
    return <>
      {conversation.publicTopic && onExpandTopicWithAI ? <button type="button" className="conversation-graph-node-action map-topic-action" disabled={Boolean(expandingTopicId)} aria-label={`Expand ${conversation.title} with AI`} title="Create an editable subgraph of AI-generated notes" onClick={(event) => { event.stopPropagation(); onExpandTopicWithAI(conversation.id); }}>
        {expandingTopicId === conversation.id ? "Expanding…" : "✧ Expand with AI"}
      </button> : null}
      {onAddTopicConnections && publicMapAccount ? <button type="button" className="conversation-graph-node-action" aria-label={`Wikipedia and AI for ${conversation.title}`} title="Wikipedia connections and AI" onClick={(event) => { event.stopPropagation(); setConnectingId(null); openSources(conversation.id); }}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 6 6M8 10.5h5M10.5 8v5" /></svg>
      </button> : null}
      {onAddChildNote ? <button type="button" className="conversation-graph-node-action" aria-label={`Add child note to ${conversation.title}`} title={`Add child note to ${conversation.title}`} onClick={(event) => { event.stopPropagation(); onAddChildNote(conversation.id); }}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 3H5v18h14V8l-5-5ZM14 3v5h5M8 14h8M12 10v8" /></svg>
      </button> : null}
      <button type="button" className="conversation-graph-node-action" aria-label={aroundLabel} title={`${aroundLabel}, as previews you can keep`} onClick={(event) => { event.stopPropagation(); showAround(conversation.id); }}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" /></svg>
      </button>
    </>;
  }

  function renderMenuActions(conversation: Conversation) {
    return <>
          {onAddTopicConnections && publicMapAccount ? <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setConnectingId(null); openSources(conversation.id); }}>Wikipedia and AI…</button> : null}
          <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); showAround(conversation.id); }}>Show what's around it</button>
          {onAddChildNote ? <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onAddChildNote(conversation.id); }}>Add child note</button> : null}
          <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onCreateMapNote({ linkedTo: conversation.id }); }}>New connected note</button>
          <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setConnectingId(conversation.id); }}>Connect to another node</button>
          <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); personalProps.onOpenConversation(conversation.id); }}>Open and edit</button>
          {conversation.kind === "note" && !conversation.childIds.length ? <button type="button" onClick={() => onRemoveMapNote(conversation.id)}>Remove note from workspace</button> : null}
    </>;
  }

  const sourceConversation = sourcesFor && sourcesFor !== "add" ? conversations[sourcesFor] : undefined;
  const sourceNote = useMemo(() => sourceConversation ? {
    id: sourceConversation.id, title: sourceConversation.title,
    content: getStandaloneNote(sourceConversation)?.content ?? "",
    topic: sourceConversation.publicTopic,
    ...(sourceConversation.hiddenFromAI ? { hiddenFromAI: true } : {}),
  } : null, [sourceConversation]);
  const previewItem = selectedPreview ? exploration.items[selectedPreview] : undefined;
  const onMapIds = useMemo(() => Object.values(exploration.items).filter((item) => item.onMap).map((item) => item.id), [exploration]);
  const historyCount = Object.keys(exploration.items).length;
  const sidebarToggle = onToggleSidebar && !sidebarOpen ? <div className="knowledge-map-switcher is-inline">
    <button type="button" className="knowledge-map-sidebar-toggle" onClick={onToggleSidebar} aria-label="Open chat sidebar" aria-pressed={false}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
    </button>
  </div> : null;
  const addActions = <>
    <button type="button" className="knowledge-map-explore-button" title="Explore any topic in a scratch map that stays out of your workspace"
      onClick={() => { setExploringFrom(undefined); setExploring(true); setSelectedPreview(null); setHistoryOpen(false); setSourcesFor(null); setConnectingId(null); }}>
      <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" /></svg>
      <span>Explore</span>
    </button>
    <button type="button" className="knowledge-map-history-button" aria-pressed={historyOpen && !previewItem} aria-label={`Explored history${historyCount ? `, ${historyCount} items` : ""}`} title="Explored history: previews you have not kept"
      onClick={() => { setHistoryOpen(!(historyOpen && !previewItem)); setSelectedPreview(null); setSourcesFor(null); }}>
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3.5 4v4h4M12 7.5V12l3 2" /></svg>
      {historyCount ? <span>{historyCount > 99 ? "99+" : historyCount}</span> : null}
    </button>
    <DismissibleDetails className="knowledge-map-add" onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();
    }}>
      <summary aria-label="Add to map" title="Add to map"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></summary>
      <div>
        <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onCreateMapNote({}); }}>New note</button>
        {onAddTopicConnections && publicMapAccount ? <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); openSources("add"); }}>From Wikipedia</button> : null}
        <button type="button" aria-expanded={sourceFormOpen} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setSourceFormOpen(!sourceFormOpen); }}>Add web source</button>
      </div>
    </DismissibleDetails>
  </>;

  // The map's ⋯ menu holds these, so its bar keeps only search, the scope and Roadmaps.
  const closeMenu = (element: HTMLElement) => element.closest("details")?.removeAttribute("open");
  // Bringing in sources and exploring topics come with More map tools; a plain map just adds notes.
  const moreFeatures = onMoreFeatures ? <button type="button" className="graph-map-more-features" title="Turn on more tools in Settings → Features"
    onClick={(event) => { closeMenu(event.currentTarget); onMoreFeatures(); }}>More features…</button> : null;
  // Roadmaps left the bar: all of them are a tab of Tile view, and a new one by hand is picked here on the map.
  const roadmapActions = pathActions ? <>
    <span className="graph-map-menu-label">Roadmaps</span>
    {onShowAllRoadmaps ? <button type="button" onClick={(event) => { closeMenu(event.currentTarget); onShowAllRoadmaps(); }}>All roadmaps</button> : null}
    <button type="button" onClick={(event) => { closeMenu(event.currentTarget); startPicking(); }}>New roadmap: click notes in order</button>
  </> : null;
  const menuActions = !mapTools ? <><button type="button" onClick={(event) => { closeMenu(event.currentTarget); onCreateMapNote({}); }}>New note</button>{roadmapActions}</> : <>
    <span className="graph-map-menu-label">Add and explore</span>
    <button type="button" onClick={(event) => { closeMenu(event.currentTarget); onCreateMapNote({}); }}>New note</button>
    {onAddTopicConnections && publicMapAccount ? <button type="button" onClick={(event) => { closeMenu(event.currentTarget); openSources("add"); }}>Add from Wikipedia</button> : null}
    <button type="button" onClick={(event) => { closeMenu(event.currentTarget); setSourceFormOpen(true); }}>Add a web source</button>
    <button type="button" title="Explore any topic in a scratch map that stays out of your workspace"
      onClick={(event) => { closeMenu(event.currentTarget); setExploringFrom(undefined); setExploring(true); setSelectedPreview(null); setHistoryOpen(false); setSourcesFor(null); setConnectingId(null); }}>Explore a topic</button>
    <button type="button" title="Explored history: previews you have not kept" aria-label={`Explored history${historyCount ? `, ${historyCount} items` : ""}`}
      onClick={(event) => { closeMenu(event.currentTarget); setHistoryOpen(true); setSelectedPreview(null); setSourcesFor(null); }}>
      Explored history{historyCount ? <span className="graph-map-lens-badge">{historyCount > 99 ? "99+" : historyCount}</span> : null}</button>
    {roadmapActions}
  </>;
  void addActions;

  return <section ref={sectionRef} className="knowledge-graph-workspace" aria-label="Knowledge maps"
    onDragOver={(event) => { if (!event.defaultPrevented && event.dataTransfer.types.includes("text/uri-list")) { event.preventDefault(); event.dataTransfer.dropEffect = "link"; } }}
    onDrop={(event) => { if (event.defaultPrevented) return; const url = droppedLink(event); if (!url) return; event.preventDefault(); setSearchRequest({ query: url, requestId: ++counter.current }); }}>
    {sourceFormOpen ? <form className="map-source-form" onSubmit={(event) => {
      event.preventDefault();
      try {
        const url = new URL(sourceUrl);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
        onCreateMapNote({ url: url.href }); setSourceFormOpen(false); setSourceUrl(""); setSourceError("");
      } catch { setSourceError("Enter a complete http or https web address."); }
    }}>
      <label>Web address<input type="url" required value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://…" /></label>
      <button type="submit">Save source note</button><button type="button" onClick={() => setSourceFormOpen(false)}>Cancel</button>
      <small>A linked source with room for your notes.</small>{sourceError ? <p role="alert">{sourceError}</p> : null}
    </form> : null}
    {connectingId ? <div className="map-workspace-notice" role="status">Choose a second node to connect with {conversations[connectingId]?.title}.<button type="button" onClick={() => setConnectingId(null)}>Cancel</button></div> : null}
    {mapEditMessage ? <div className="map-workspace-notice is-dismissible" role="status"><span>{mapEditMessage}</span>{canUndoMapEdit ? <button type="button" onClick={onUndoMapEdit}>Undo</button> : null}
      {onDismissMapEdit ? <button type="button" className="map-workspace-notice-close" aria-label="Dismiss" title="Dismiss" onClick={onDismissMapEdit}>×</button> : null}</div> : null}
    {expandingTopicId ? <div className="map-workspace-notice" role="status" aria-live="polite"><span>{topicExpansionProgress || "Building an AI subgraph…"} · {conversations[expandingTopicId]?.title}</span><button type="button" onClick={onCancelTopicExpansion}>Cancel expansion</button></div> : null}
    {topicExpansionError ? <div className="map-workspace-notice is-error" role="alert"><span>{topicExpansionError.message}</span>{conversations[topicExpansionError.conversationId] ? <button type="button" disabled={Boolean(expandingTopicId)} onClick={() => onExpandTopicWithAI?.(topicExpansionError.conversationId)}>Retry AI expansion</button> : null}<button type="button" onClick={onDismissTopicExpansionError}>Dismiss</button></div> : null}
    <div className={`knowledge-map-panel${exploring ? " is-exploring" : ""}`} ref={panelRef}>
      {exploring ? <TopicExplorer workspaceKey={personalProps.workspaceKey ?? "workspace"} account={publicMapAccount} savedTopics={savedTopics} mapTitles={mapTitles}
        startTitle={exploringFrom}
        onKeep={(state, ids) => onKeepExplored?.(state, ids) ?? {}}
        documents={documentList} onCreateDocument={onCreateExploreDocument}
        renderDocument={personalProps.renderDockedConversation ? (id, dock) => personalProps.renderDockedConversation!(id, undefined, dock) : undefined}
        onOpenDocument={(id) => { setExploring(false); focusDocument(id); }}
        onClose={() => { setExploring(false); setExploringFrom(undefined); }} /> : null}
      {!exploring && (busy || exploreMessage) ? <div className="map-explore-status" aria-live="polite">
        {busy ? <div className="map-workspace-notice" role="status"><span className="map-explore-spinner" aria-hidden="true" /><span>{busy.progress || busy.label}</span><button type="button" onClick={() => busy.controller.abort()}>Cancel</button></div> : null}
        {exploreMessage ? <div className={`map-workspace-notice${exploreMessage.error ? " is-error" : ""}`} role={exploreMessage.error ? "alert" : "status"}><span>{exploreMessage.text}</span><button type="button" onClick={() => setExploreMessage(null)}>Dismiss</button></div> : null}
      </div> : null}
      <ConversationGraphView {...personalProps} isVisible={isVisible && !exploring} renderNodeActions={renderActions} onCreateDocument={onCreateExploreDocument}
        spotlight={personalProps.spotlight ?? (picking ? null : pathSpotlight)} onSelectionChange={setMapSelection}
        searchPlaceholder={narrowScreen() ? "Search or ask…" : "Search, ask, or paste a link…"} searchRequest={searchRequest} onSearchSubmit={submitSearch}
        renderSearchFallback={(query, close, matchedIds) => <MapSearchLookFurther query={query} matchedCount={matchedIds.length} canAsk={Boolean(publicMapAccount?.canAsk)}
          onMapPage={(url) => { close(); mapPage(url, anchorFor(query, matchedIds)); }}
          onSaveSource={(url) => { close(); onCreateMapNote({ url }); }}
          onPreviewTopic={(topic) => { close(); previewTopic(topic, anchorFor(query, matchedIds)); }}
          onAsk={(question) => { close(); askAI(question, anchorFor(query, matchedIds), { label: query }); }} />}
        renderMapOverlay={(context) => <>
          <MapPreviewLayer context={context} exploration={exploration} selectedId={selectedPreview} revealRequest={revealRequest} panelOpen={Boolean(previewItem || historyOpen || sourcesFor)}
            onSelect={selectPreview} onKeep={(id) => keep([id])} onHide={(id) => updateExploration((current) => setOnMap(current, [id], false))} />
          {onMapIds.length && !activePath ? <MapPreviewBar count={onMapIds.length} onKeepAll={() => keep(onMapIds)} onClear={() => updateExploration((current) => setOnMap(current, onMapIds, false))} /> : null}
          {activePath && !picking && pathLayout === "map" ? <MapPathLayer context={context} path={activePath} currentDocId={mapSelection} /> : null}
          {!activePath && !picking && pathActions && roadmapStarts.length ? <MapRoadmapFlags context={context} starts={roadmapStarts}
            onPick={(id) => setActivePath(id)} /> : null}
          {picking ? <MapPathPicker context={context} ids={pickIds} picked={picking}
            onToggle={(id) => setPicking((current) => current ? current.includes(id) ? current.filter((item) => item !== id) : [...current, id] : current)} /> : null}
        </>}
        renderNodeMenuActions={renderMenuActions} connectingConversationId={connectingId}
        toolbarLeading={<>{sidebarToggle}{sidebarToggle ? viewToggle : null}{pathActions ? <MapModeSwitch mode={mapMode} onChange={chooseMapMode} /> : null}</>}
        scopeHidden={mapMode === "learn"}
        // Picking notes for a roadmap, or a roadmap lit on the map, needs the map itself.
        exploreLayout={picking || activePath ? "canvas" : exploreLayout} onExploreLayoutChange={picking || activePath ? undefined : chooseExploreLayout}
        exploreSourceMenu={renderSourceMenu}
        renderPublicExplore={exploreSource.kind === "notes" ? undefined : (layout, leading) => <ExplorePublic source={exploreSource} layout={layout} leading={leading} sourceMenu={renderSourceMenu}
          onPlace={(place) => { publicPlace.current = place; }}
          actions={{ ask: askSubtopics, noteFor, onOpenNote: (id) => personalProps.onOpenConversation(id), onRead: setReaderTitle, onKeep: keepPublic,
            onDetails: (node) => setSidePane({ kind: "details", node }), onNewNote: newPublicNote,
            ...(pathActions ? { onRoadmap: roadmapFor } : {}) }}
          reader={sidePane?.kind === "wikipedia" ? <WikipediaPane title={sidePane.title} account={publicMapAccount} notes={passageNotes} onNotesChange={setPassageNotes}
            onNavigate={setReaderTitle} onClose={() => setSidePane(null)}
            onCreateDocument={(title, content) => Boolean(onCreateExploreDocument?.({ title, content }))}
            onExplore={(text) => { if (publicMapAccount?.canAsk) chooseExploreSource({ kind: "ai", topic: text.replace(/\s+/gu, " ").trim().slice(0, 200) }); }}
            onAddTopics={(_answer, article) => { setExploringFrom(article); setExploring(true); }} />
            : sidePane?.kind === "details" ? <TopicDetailsPane node={sidePane.node} ask={askDetails} onSave={notePublic} onRead={setReaderTitle} onClose={() => setSidePane(null)} />
            : sidePane?.kind === "document" ? <aside className="topic-explorer-pane is-document" aria-label="Note beside Explore">
              {conversations[sidePane.id] && personalProps.renderDockedConversation ? <div className="conversation-graph-dock-body">
                {personalProps.renderDockedConversation(sidePane.id, undefined, { leading: null, pinned: false, onTogglePin: () => undefined,
                  onClose: () => setSidePane(null), onOpenDocument: (id) => setSidePane({ kind: "document", id }) })}
              </div> : <p className="topic-explorer-pane-message" role="status">Opening your note…</p>}
            </aside> : undefined} />}
        // Roadmaps are reached from Tile view's Roadmaps tab and Learn; Learn's header names the roadmap on screen, as a menu.
        menuItems={menuActions} menuFooter={moreFeatures} scopeRequest={scopeRequest}
        focusRequest={personalProps.focusRequest ?? personalFocus}
        onFocusRequestHandled={(id) => { if (personalProps.focusRequest?.requestId === id) personalProps.onFocusRequestHandled?.(id); else setPersonalFocus(null); }}
        onConnectConversation={(source, target) => { if (source !== target) { onSetMapConnection(source, target, true); setConnectingId(null); } }}
        onRemoveConnection={(source, target) => onSetMapConnection(source, target, false)}
        onCreateNoteAt={(position) => onCreateMapNote({ position })} />
      {!exploring && picking && pathActions ? <MapPathPickBanner count={picking.length} onCancel={() => setPicking(null)} onDone={(title) => {
        const made = pathActions.onCreatePath(title, picking);
        if ("error" in made) { setPathMessage(made.error); return; }
        setPicking(null); setActivePath(made.id);
      }} /> : null}
      {!exploring && !picking && !activePath && learnEmpty && pathActions ? <MapCourseEmpty onNew={() => { setLearnEmpty(false); startPicking(); }}
        onDraft={(goal) => {
          const made = pathActions.onDraftPath(goal);
          if ("error" in made) return made.error;
          setLearnEmpty(false); setActivePath(made.id); return null;
        }} /> : null}
      {!exploring && !picking && activePath && pathActions ? <>
        {pathLayout === "list" ? <MapRoadmapCourse path={coursePath ?? activePath} conversations={conversations} currentDocId={mapSelection}
          drafting={activePathDrafting ? { label: draftingLabel(pathActions.progress[activePath.id], coursePath ?? activePath), onStop: () => pathActions.onStopDraft(activePath.id) } : null}
          stepStrip={(() => {
            const step = activePath.steps.find((item) => item.docId === mapSelection && !item.drafting);
            return step && stepHiddenFor !== step.docId ? <MapPathStepStrip docked path={activePath} step={step} conversations={conversations} actions={pathActions}
              onStep={stepTo} onOpenStep={(id) => personalProps.onOpenConversation(id)} onGoIn={(id) => setActivePath(id, [...pathTrail, activePath.id])}
              onMessage={setPathMessage} onHide={() => setStepHiddenFor(step.docId)} /> : null;
          })()}
          trail={pathTrail.flatMap((id) => pathSummaries.filter((item) => item.id === id))}
          onOpen={(id) => {
            if (conversations[id]?.nodeType === "roadmap") openedFromCourse.current = id;
            stepTo(id); personalProps.onOpenConversation(id);
            const step = activePath.steps.find((item) => item.docId === id);
            if (step) pathActions.onLessonOpened?.(activePath.id, id, lessonContext(activePath, step));
          }}
          onOpenStage={(stageId) => pathActions.onOpenStage?.(activePath.id, stageId)}
          titleMenu={<MapPathsMenu paths={pathSummaries} activeId={activePath ? activePathId : null} onShowAll={onShowAllRoadmaps}
          onPick={(id) => { setPicking(null); setActivePath(id); }} onNew={startPicking}
          onDraft={(goal) => {
            const made = pathActions.onDraftPath(goal);
            if ("error" in made) return made.error;
            setPicking(null); setActivePath(made.id); return null;
          }}
          onRevise={activePath && pathActions.onRevisePath ? (request) => pathActions.onRevisePath!(activePath.id, request) : undefined} />}
          onGoIn={(id) => setActivePath(id, [...pathTrail, activePath.id])}
          onGoTo={(id) => { const index = pathTrail.indexOf(id); setActivePath(id, index >= 0 ? pathTrail.slice(0, index) : []); }}
          onClose={() => setActivePath(null)} /> : null}
        <MapPathBar path={activePath} conversations={conversations} currentDocId={mapSelection} actions={pathActions} message={pathMessage} inCourse={pathLayout === "list"}
          stepHidden={stepHiddenFor === mapSelection} onHideStep={() => setStepHiddenFor(mapSelection)}
          trail={pathTrail.flatMap((id) => pathSummaries.filter((item) => item.id === id))}
          onStep={stepTo} onClose={() => setActivePath(null)} onMessage={setPathMessage}
          onOpenNote={() => personalProps.onOpenConversation(activePath.id)}
          onOpenStep={(id) => personalProps.onOpenConversation(id)}
          onGoIn={(id) => setActivePath(id, [...pathTrail, activePath.id])}
          onGoTo={(id) => { const index = pathTrail.indexOf(id); setActivePath(id, index >= 0 ? pathTrail.slice(0, index) : []); }} />
      </> : null}
      {exploring ? null : previewItem ? <MapPreviewDetails key={previewItem.id} item={previewItem} exploration={exploration} account={publicMapAccount}
        anchorTitle={previewItem.parent?.kind === "document" ? conversations[previewItem.parent.id]?.title ?? null : null}
        onClose={() => setSelectedPreview(null)}
        onKeep={() => keep([previewItem.id])}
        onKeepAlone={() => keep([previewItem.id], [previewItem.id])}
        onToggleMap={() => showPreviews((current) => setOnMap(current, [previewItem.id], !previewItem.onMap), previewItem.onMap ? [] : [previewItem.id])}
        onForget={() => { updateExploration((current) => forgetExplored(current, [previewItem.id])); setSelectedPreview(null); }}
        onShowConnections={() => showMoreConnections(previewItem)}
        onAsk={(question) => {
          const source = previewItem.source;
          const page = source.kind === "page" ? exploration.pages[source.url] : undefined;
          const node = source.kind === "page" ? page?.nodes.find((candidate) => candidate.id === source.nodeId) : undefined;
          askAI(question, { kind: "item", id: previewItem.id }, source.kind === "answer"
            ? { label: source.answer.question, noteContent: source.answer.answer }
            : { label: previewItem.label, description: previewItem.detail, noteContent: node && page ? `Source: ${page.source.url}\n\n${node.summary}\n\n> ${node.evidence.quote}` : previewItem.detail });
        }}
        onPreviewAnswer={(answer) => {
          const batch = exploration.batches[previewItem.batchId] ?? newBatch(previewItem.label);
          const items = answerItems(answer, answer.id, { parent: { kind: "item", id: previewItem.id }, batchId: batch.id, exploredAt: new Date().toISOString() });
          showPreviews((current) => addExplored(current, batch, items), items.map((item) => item.id));
        }}
        onPreviewTopic={(topic) => {
          const exploredAt = new Date().toISOString();
          const batch = exploration.batches[previewItem.batchId] ?? newBatch(previewItem.label);
          const item = topicItem(publicTopicFromAnswer(topic, exploredAt), { parent: { kind: "item", id: previewItem.id }, batchId: batch.id, exploredAt },
            { via: `Ask AI · ${topic.relation}`, connection: { kind: "related", label: topic.relation } });
          showPreviews((current) => addExplored(current, batch, [item]), [item.id]);
        }} />
      : historyOpen ? <MapExploredHistory exploration={exploration} selectedId={selectedPreview} onClose={() => setHistoryOpen(false)}
        onSelect={selectPreview}
        onSetOnMap={(ids, onMap) => showPreviews((current) => setOnMap(current, ids, onMap), onMap ? ids : [])}
        onKeep={(ids) => keep(ids)}
        onForget={(ids) => updateExploration((current) => forgetExplored(current, ids))} />
      : sourcesFor && publicMapAccount && onAddTopicConnections && (sourcesFor === "add" || sourceNote) ? <MapTopicSourcesPanel
        note={sourcesFor === "add" ? null : sourceNote} account={publicMapAccount} onClose={() => setSourcesFor(null)}
        onAddTopic={(topic) => { onSavePublicTopic(topic); setAddedTopicId(topic.id); }}
        onAddConnections={onAddTopicConnections}
        onSaveAnswer={(id, answer) => onSavePrivateAnswer?.(id, answer)}
        onPreviewConnections={(noteId) => { setSourcesFor(null); showAround(noteId); }} /> : null}
    </div>
  </section>;
}

/** A phone-width search box cuts the long placeholder off mid-word. */
function narrowScreen() {
  return typeof window !== "undefined" && window.matchMedia?.("(max-width: 480px)").matches === true;
}
