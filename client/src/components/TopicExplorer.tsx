import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { GraphDockControls } from "./ConversationGraphView";
import WikipediaPane from "./WikipediaPane";
import { isPassageNote, type PassageNote } from "../lib/wikipediaReader";
import type { PublicTopic } from "../lib/publicKnowledge";
import type { PublicMapAccount } from "./PublicTopicInsights";
import { askAboutNote, type PrivateAnswer } from "../lib/publicMapApi";
import { expandWikipediaTopic, resolveWikipediaTitles, searchWikipediaTopics, wikipediaTitle } from "../lib/wikipedia";
import { ApiError } from "../lib/apiError";
import { addExplored, publicTopicFromAnswer, setExpansion, topicItem, type ExploredBatch, type MapExploration } from "../lib/mapExploration";
import {
  addRoot, aiChildren, aiSearchQuestion, aiSubgraphContext, aiSubtopicQuestion, arrange, ARRANGEMENTS, boundsOf, childrenIndex, clampScale, descendants, expansionKey, explorerStorageKey, fitView,
  isArrangement, readExplorer, removeBranch, SUGGESTED_TOPICS, wikipediaChildren, type ExplorerArrangement, type ExplorerSource, type ExplorerView,
} from "../lib/topicExplorer";
import { githubRepoFromText, readRepoMemory } from "../lib/repoGraph";
import "./TopicExplorer.css";

const RepoExplorer = lazy(() => import("./RepoExplorer"));

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const browserStorage = () => { try { return window.localStorage; } catch { return undefined; } };
const MENU_WIDTH = 248;
const ARRANGEMENT_KEY = "margin-topic-explorer-arrangement";
type Positions = Record<string, { x: number; y: number }>;

function readJson<T>(key: string, valid: (value: unknown) => value is T, fallback: T): T {
  try { const value = JSON.parse(browserStorage()?.getItem(key) ?? "null"); return valid(value) ? value : fallback; }
  catch { return fallback; }
}
const isPositions = (value: unknown): value is Positions => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.values(value).every((point) => point && typeof point === "object" && Number.isFinite((point as { x: number }).x) && Number.isFinite((point as { y: number }).y));

/**
 * Explore mode: a scratch map for any topic. Search or pick a topic, click a
 * node, and grow a subgraph from Wikipedia or AI. Nothing reaches the
 * person's own map until they save a node.
 */
export default function TopicExplorer({ workspaceKey, account, savedTopics, mapTitles, documents, renderDocument, onCreateDocument, onKeep, onOpenDocument, onClose }: {
  workspaceKey: string;
  account?: PublicMapAccount;
  /** Wikidata ids already in the vault, to the document each became. */
  savedTopics: Record<string, string>;
  /** Recent document titles, offered as starting topics. */
  mapTitles: string[];
  /** Saves explored nodes into the vault; returns the document each became. */
  onKeep(exploration: MapExploration, ids: string[]): Record<string, string>;
  onOpenDocument(id: string): void;
  onClose(): void;
  /** Documents that can open in a pane beside the explore map. */
  documents: Array<{ id: string; title: string }>;
  /** The full document editor, for a document opened beside. */
  renderDocument?: (id: string, dock: GraphDockControls) => ReactNode;
  /** Makes a document in the vault, under `parentId` when given; returns its id. */
  onCreateDocument?: (args: { title: string; content: string; parentId?: string }) => string | null;
}) {
  /** A GitHub repository being explored instead of topics. */
  const [repoUrl, setRepoUrl] = useState<string | null>(null);
  const [repoDraft, setRepoDraft] = useState("");
  const [hasRecentRepos] = useState(() => readRepoMemory(browserStorage()).recent.length > 0);
  const [state, setState] = useState<MapExploration>(() => readExplorer(browserStorage(), workspaceKey));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ExplorerView>({ x: 0, y: 0, scale: 1 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [busy, setBusy] = useState<{ id: string | null; label: string; progress: string; controller: AbortController } | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [revealIds, setRevealIds] = useState<{ ids: string[]; request: number } | null>(null);
  const [arrangement, setArrangement] = useState<ExplorerArrangement>(() => readJson(ARRANGEMENT_KEY, isArrangement, "tree"));
  const [positions, setPositions] = useState<Positions>(() => readJson(`${explorerStorageKey(workspaceKey)}:canvas`, isPositions, {}));
  /** The topic in the middle of the Focus arrangement. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /** Reading panes on the left: a Wikipedia article and one of the person's documents. */
  const [articleTitle, setArticleTitle] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [passageNotes, setPassageNotes] = useState<PassageNote[]>(() => readJson(`${explorerStorageKey(workspaceKey)}:passages`, (value): value is PassageNote[] => Array.isArray(value) && value.every(isPassageNote), []));
  const canvasRef = useRef<HTMLDivElement>(null);
  // New nodes come into view: the whole map when it fits, otherwise the node and its branches.
  const fitted = useRef(false);
  const busyRef = useRef<typeof busy>(null);
  const counter = useRef(0);
  const latest = useRef({ state, view, size });
  latest.current = { state, view, size };

  useEffect(() => {
    setState(readExplorer(browserStorage(), workspaceKey)); setSelectedId(null);
    setPositions(readJson(`${explorerStorageKey(workspaceKey)}:canvas`, isPositions, {}));
  }, [workspaceKey]);
  useEffect(() => { try { browserStorage()?.setItem(ARRANGEMENT_KEY, JSON.stringify(arrangement)); } catch { /* Remembering the arrangement is optional. */ } }, [arrangement]);
  useEffect(() => {
    try { browserStorage()?.setItem(`${explorerStorageKey(workspaceKey)}:canvas`, JSON.stringify(positions)); } catch { /* Canvas spots are optional. */ }
  }, [positions, workspaceKey]);
  useEffect(() => {
    try { browserStorage()?.setItem(`${explorerStorageKey(workspaceKey)}:passages`, JSON.stringify(passageNotes.slice(-300))); } catch { /* Unsaved passage notes stay for this visit. */ }
  }, [passageNotes, workspaceKey]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { browserStorage()?.setItem(explorerStorageKey(workspaceKey), JSON.stringify(state)); }
      catch { /* Exploring still works when browser storage is full or blocked. */ }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [state, workspaceKey]);
  useEffect(() => () => busyRef.current?.controller.abort(), []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => setSize({ width: canvas.clientWidth, height: canvas.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => arrange(state, arrangement, { focusId, positions }), [state, arrangement, focusId, positions]);
  const { childrenOf } = useMemo(() => childrenIndex(state), [state]);
  const empty = Object.keys(state.items).length === 0;
  // A new arrangement, or a new topic in the middle of Focus, shows the whole picture again.
  useEffect(() => { fitted.current = false; }, [arrangement, arrangement === "brain" ? focusId : null]);


  useEffect(() => {
    if (!size.width || !size.height) return;
    if (!revealIds) {
      if (!fitted.current && layout.boxes.size) { fitted.current = true; setView(overview()); }
      return;
    }
    const bounds = boundsOf(revealIds.ids.flatMap((id) => layout.boxes.get(id) ?? []));
    if (!bounds) return;
    const current = latest.current.view;
    const left = bounds.x * current.scale + current.x, top = bounds.y * current.scale + current.y;
    const inside = left >= 16 && top >= 16 && left + bounds.width * current.scale <= size.width - 16 && top + bounds.height * current.scale <= size.height - 16;
    if (!inside) setView(fitView(bounds, size.width, size.height));
    setRevealIds(null);
  }, [revealIds, layout, size, empty]);

  function chooseArrangement(next: ExplorerArrangement) {
    // Canvas starts from whatever was on screen, so switching to it never jumbles the map.
    if (next === "canvas") setPositions((current) => {
      const seeded = { ...current };
      for (const [id, box] of layout.boxes) seeded[id] ??= { x: Math.round(box.x), y: Math.round(box.y) };
      return seeded;
    });
    if (next === "brain") setFocusId((current) => current && state.items[current] ? current : selectedId);
    setArrangement(next);
  }

  /** Dragging a card on Canvas moves it; a press without moving still opens its menu. */
  const dragRef = useRef<{ id: string; pointer: number; startX: number; startY: number; origin: { x: number; y: number }; moved: boolean } | null>(null);
  function onNodePointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (arrangement !== "canvas" || event.button !== 0) return;
    const box = layout.boxes.get(id);
    if (!box) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, origin: { x: box.x, y: box.y }, moved: false };
  }
  function onNodePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    const dx = (event.clientX - drag.startX) / view.scale, dy = (event.clientY - drag.startY) / view.scale;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4 / view.scale) return;
    if (!drag.moved) { drag.moved = true; setDragging(drag.id); }
    setPositions((current) => ({ ...current, [drag.id]: { x: Math.round(drag.origin.x + dx), y: Math.round(drag.origin.y + dy) } }));
  }
  function onNodePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    dragRef.current = null;
    if (drag.moved) { setDragging(null); suppressClick.current = true; window.setTimeout(() => { suppressClick.current = false; }, 0); }
  }
  const suppressClick = useRef(false);

  /**
   * The whole map when it stays readable; otherwise, as on a phone with a big
   * map, the chosen topic (or the first one) at a readable size.
   */
  function overview(): ExplorerView {
    const bounds = boundsOf(layout.boxes.values());
    if (!bounds) return latest.current.view;
    const whole = fitView(bounds, size.width, size.height);
    if (whole.scale >= 0.45) return whole;
    const anchor = layout.boxes.get(selectedId ?? "") ?? layout.boxes.get(focusId ?? "") ?? layout.boxes.get(childrenIndex(state).roots[0] ?? "") ?? bounds;
    const scale = 0.7;
    return { scale, x: size.width / 2 - (anchor.x + anchor.width / 2) * scale, y: size.height / 2 - (anchor.y + anchor.height / 2) * scale };
  }

  function reveal(ids: string[]) { setRevealIds({ ids, request: ++counter.current }); }
  function fitAll() { const bounds = boundsOf(layout.boxes.values()); if (bounds && size.width) setView(fitView(bounds, size.width, size.height)); }
  function zoomBy(factor: number, at = { x: size.width / 2, y: size.height / 2 }) {
    setView((current) => {
      const scale = clampScale(current.scale * factor);
      return { scale, x: at.x - (at.x - current.x) * (scale / current.scale), y: at.y - (at.y - current.y) * (scale / current.scale) };
    });
  }

  function newBatch(title: string): ExploredBatch {
    return { id: `explore-${Date.now().toString(36)}-${(++counter.current).toString(36)}`, title: title.slice(0, 200), createdAt: new Date().toISOString() };
  }

  /** One lookup at a time, with its progress and a Cancel. */
  async function run(id: string | null, label: string, task: (signal: AbortSignal, progress: (text: string) => void) => Promise<void>) {
    busyRef.current?.controller.abort();
    const entry = { id, label, progress: "", controller: new AbortController() };
    busyRef.current = entry;
    setBusy(entry); setMessage(null);
    try {
      await task(entry.controller.signal, (progress) => { if (busyRef.current === entry) setBusy({ ...entry, progress }); });
    } catch (error) {
      if (entry.controller.signal.aborted) return;
      if (error instanceof ApiError && error.statusCode === 401) account?.onAuthExpired?.();
      setMessage({ text: errorMessage(error, "That could not be explored. Try again."), error: true });
    } finally {
      if (busyRef.current === entry) { busyRef.current = null; setBusy(null); }
    }
  }

  function startFrom(topic: PublicTopic) {
    const id = `topic:${topic.id}`;
    setState((current) => addRoot(current, topic, newBatch(topic.label)));
    setSelectedId(id); setFocusId(id);
    reveal([id]);
  }

  function startFromTitle(title: string) {
    void run(null, `Finding “${title}” on Wikipedia…`, async (signal) => {
      const topic = (await resolveWikipediaTitles([title], signal)).get(title) ?? (await searchWikipediaTopics(title, signal))[0];
      signal.throwIfAborted();
      if (!topic) throw new Error(`Wikipedia has no article for “${title}”. Try other words.`);
      startFrom(topic);
    });
  }

  function expand(id: string, source: ExplorerSource, focus = "") {
    const item = latest.current.state.items[id];
    if (item?.source.kind !== "topic") return;
    const topic = item.source.topic;
    const batch = latest.current.state.batches[item.batchId] ?? newBatch(topic.label);
    if (source === "wikipedia") {
      void run(id, `Reading Wikipedia links for ${topic.label}…`, async (signal) => {
        let offset = latest.current.state.expansions[expansionKey("wikipedia", id)]?.nextOffset ?? 0;
        // Pages of links can be all broader topics or ones already here, so read on until something is new.
        for (let page = 0; page < 3; page += 1) {
          const expansion = await expandWikipediaTopic(topic, offset, signal);
          signal.throwIfAborted();
          offset = expansion.nextOffset;
          const children = wikipediaChildren(latest.current.state, id, expansion, batch, new Date().toISOString());
          const next = setExpansion(addExplored(latest.current.state, batch, children), { kind: "item", id }, { nextOffset: expansion.nextOffset, hasMore: expansion.hasMore });
          latest.current.state = next;
          setState(next);
          if (children.length) { reveal([id, ...children.map((child) => child.id)]); return; }
          if (!expansion.hasMore) break;
        }
        setMessage({ text: `Every Wikipedia link of ${topic.label} is already on this map.`, error: false });
      });
      return;
    }
    if (!account?.canAsk) return;
    void run(id, `Asking AI for subtopics of ${topic.label}…`, async (signal, progress) => {
      try {
        const existing = childrenOf(id).map((child) => latest.current.state.items[child]?.label).filter(Boolean) as string[];
        const answer = await askAboutNote({ userId: account.userId, topic: { label: topic.label.slice(0, 200), description: topic.description.slice(0, 2000) },
          noteContent: aiSubgraphContext(latest.current.state, id), question: aiSubtopicQuestion(topic.label, existing, focus), options: account.aiOptions, signal, onProgress: progress });
        signal.throwIfAborted();
        const children = aiChildren(latest.current.state, id, answer, batch, new Date().toISOString());
        const key = expansionKey("ai", id);
        const asked = latest.current.state.expansions[key]?.nextOffset ?? 0;
        const next = { ...addExplored(latest.current.state, batch, children) };
        next.expansions = { ...next.expansions, [key]: { nextOffset: asked + 1, hasMore: true } };
        latest.current.state = next;
        setState(next);
        if (children.length) reveal([id, ...children.map((child) => child.id)]);
        else setMessage({ text: `AI named no new subtopics of ${topic.label}. Try Wikipedia instead.`, error: false });
      } finally { account.onBillingRefresh?.(); }
    });
  }

  /** The explore node an article belongs to: the topic it was opened from, or one with its title. */
  function articleNode(article: string): string | null {
    const wanted = article.replace(/_/g, " ").toLowerCase();
    const found = Object.values(latest.current.state.items).find((item) => item.source.kind === "topic"
      && ((wikipediaTitle(item.source.topic.wikipediaUrl) ?? "").replace(/_/g, " ").toLowerCase() === wanted || item.label.toLowerCase() === wanted));
    return found?.id ?? null;
  }

  /** The node for an article, added as a starting topic when the pane wandered to one not on the map. */
  async function ensureArticleNode(article: string, signal: AbortSignal): Promise<string | null> {
    const existing = articleNode(article);
    if (existing) return existing;
    const topic = (await resolveWikipediaTitles([article], signal)).get(article);
    signal.throwIfAborted();
    if (!topic) return null;
    const next = addRoot(latest.current.state, topic, newBatch(topic.label));
    latest.current.state = next;
    setState(next);
    return `topic:${topic.id}`;
  }

  // A phone has room for one pane above the map, so opening one closes the other.
  const narrow = () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 760px)").matches;
  function openArticle(title: string) {
    setArticleTitle(title);
    if (narrow()) setDocumentId(null);
    setSelectedId(null);
  }
  function openDocument(id: string) {
    setDocumentId(id);
    if (narrow()) setArticleTitle(null);
  }

  /** A document made from an article passage, under the article's note when that is saved, and opened beside. */
  function createDocument(title: string, content: string, article: string) {
    if (!onCreateDocument) return false;
    const node = articleNode(article);
    const item = node ? latest.current.state.items[node] : undefined;
    const parentId = item?.source.kind === "topic" ? savedTopics[item.source.topic.id] : undefined;
    const id = onCreateDocument({ title, content, ...(parentId ? { parentId } : {}) });
    if (!id) { setMessage({ text: "That document could not be made. Try again.", error: true }); return false; }
    if (renderDocument) openDocument(id);
    setMessage({ text: `“${title}” is now a document in your map${parentId ? `, under ${item!.label}` : ""}.`, error: false });
    return true;
  }

  /** Selected article text as a topic on the map, under the article's node. */
  function exploreText(text: string, article: string) {
    void run(null, `Finding “${text.slice(0, 60)}” on Wikipedia…`, async (signal) => {
      const name = text.slice(0, 200);
      const topic = (await resolveWikipediaTitles([name], signal)).get(name) ?? (await searchWikipediaTopics(name, signal))[0];
      signal.throwIfAborted();
      if (!topic) throw new Error(`Wikipedia has no article for “${text.slice(0, 60)}”. Try selecting fewer words.`);
      const parent = await ensureArticleNode(article, signal);
      const id = `topic:${topic.id}`;
      if (latest.current.state.items[id]) { setSelectedId(id); reveal([id]); return; }
      const batch = newBatch(topic.label);
      const item = parent && parent !== id
        ? topicItem(topic, { parent: { kind: "item", id: parent }, batchId: batch.id, exploredAt: batch.createdAt }, { via: `Wikipedia · from ${latest.current.state.items[parent]?.label ?? article}`, connection: { kind: "related", label: "mentioned in" } })
        : topicItem(topic, { parent: null, batchId: batch.id, exploredAt: batch.createdAt });
      const next = addExplored(latest.current.state, batch, [item]);
      latest.current.state = next;
      setState(next);
      setSelectedId(id);
      reveal(parent ? [parent, id] : [id]);
    });
  }

  /** The topics an answer about a passage names, under the article's node. */
  function addAnswerTopics(answer: PrivateAnswer, article: string) {
    void run(null, "Adding the answer's topics…", async (signal) => {
      const parent = await ensureArticleNode(article, signal);
      if (!parent) throw new Error("This article is not on the explore map yet. Add it from the search first.");
      const parentItem = latest.current.state.items[parent];
      const batch = latest.current.state.batches[parentItem.batchId] ?? newBatch(parentItem.label);
      const children = aiChildren(latest.current.state, parent, answer, batch, new Date().toISOString());
      const next = addExplored(latest.current.state, batch, children);
      latest.current.state = next;
      setState(next);
      if (children.length) reveal([parent, ...children.map((child) => child.id)]);
      else setMessage({ text: "Those topics are already on the map.", error: false });
    });
  }

  function save(ids: string[]) {
    const kept = onKeep(latest.current.state, ids);
    if (!Object.keys(kept).length) setMessage({ text: "That is already in your map.", error: false });
  }

  function remove(id: string) {
    if (busy?.id && descendants(state, id).includes(busy.id)) busy.controller.abort();
    setState((current) => removeBranch(current, id));
    setSelectedId(null);
  }

  function startOver() {
    busyRef.current?.controller.abort();
    setPositions({}); setFocusId(null); setPassageNotes([]); setArticleTitle(null);
    setState((current) => ({ ...current, items: {}, batches: {}, expansions: {} }));
    setSelectedId(null); setMessage(null);
    fitted.current = false;
  }

  // Pan by dragging empty space, pinch or Ctrl+wheel to zoom, wheel to pan.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; distance: number } | null>(null);
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button, a, input, form, .topic-explorer-menu")) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()];
    gesture.current = { moved: false, distance: points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0 };
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const previous = pointers.current.get(event.pointerId);
    if (!previous || !gesture.current) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    const points = [...pointers.current.values()];
    if (points.length === 2) {
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const rect = event.currentTarget.getBoundingClientRect();
      if (gesture.current.distance) zoomBy(distance / gesture.current.distance, { x: (points[0].x + points[1].x) / 2 - rect.left, y: (points[0].y + points[1].y) / 2 - rect.top });
      gesture.current = { moved: true, distance };
      return;
    }
    const dx = point.x - previous.x, dy = point.y - previous.y;
    if (!gesture.current.moved && Math.abs(dx) + Math.abs(dy) < 3) { pointers.current.set(event.pointerId, previous); return; }
    gesture.current.moved = true;
    setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  }
  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const tapped = pointers.current.size === 1 && gesture.current && !gesture.current.moved;
    pointers.current.delete(event.pointerId);
    if (tapped) setSelectedId(null);
    if (!pointers.current.size) gesture.current = null;
  }
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest(".topic-explorer-menu")) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) zoomBy(Math.exp(-event.deltaY * 0.01), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      else setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  });

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.stopPropagation();
    if (selectedId) setSelectedId(null);
    else onClose();
  }

  const selected = selectedId ? state.items[selectedId] : undefined;
  const selectedBox = selectedId ? layout.boxes.get(selectedId) : undefined;
  const toScreen = (box: { x: number; y: number; width: number; height: number }) => ({
    x: box.x * view.scale + view.x, y: box.y * view.scale + view.y, width: box.width * view.scale, height: box.height * view.scale });

  const edgePaths = layout.edges.flatMap((edge) => {
    const from = layout.boxes.get(edge.from), to = layout.boxes.get(edge.to);
    if (!from || !to) return [];
    // A grid would be a tangle of lines, so it only shows the chosen topic's.
    if (arrangement === "grid" && edge.from !== selectedId && edge.to !== selectedId) return [];
    if (!edge.side) {
      const item = state.items[edge.to];
      return [{ id: edge.to, ai: item?.via.startsWith("AI"), path: `M${from.x + from.width / 2} ${from.y + from.height / 2}L${to.x + to.width / 2} ${to.y + to.height / 2}` }];
    }
    const right = edge.side === "right";
    const x1 = right ? from.x + from.width : from.x, y1 = from.y + from.height / 2;
    const x2 = right ? to.x : to.x + to.width, y2 = to.y + to.height / 2;
    const bend = Math.max(18, Math.abs(x2 - x1) / 2) * (right ? 1 : -1);
    const item = state.items[edge.to];
    return [{ id: edge.to, ai: item?.via.startsWith("AI"), path: `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}` }];
  });

  if (repoUrl !== null) return <Suspense fallback={<section className="topic-explorer" aria-busy="true" />}>
    <RepoExplorer initialUrl={repoUrl} account={account} onBack={() => setRepoUrl(null)} onClose={onClose}
      onSaveNote={onCreateDocument ? (note) => Boolean(onCreateDocument(note)) : undefined} />
  </Suspense>;

  return <section className="topic-explorer" aria-label="Explore any topic" onKeyDown={onKeyDown}>
    <header className="topic-explorer-bar">
      <button type="button" className="topic-explorer-back" onClick={onClose} aria-label="Back to my map" title="Back to my map">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg><span>My map</span>
      </button>
      {empty ? <strong className="topic-explorer-title">Explore</strong> : <TopicSearch compact account={account} onPick={startFrom} onPickTitle={startFromTitle} onPickRepo={setRepoUrl} mapTitles={mapTitles} />}
      {!empty ? <label className="topic-explorer-arrangement" title={ARRANGEMENTS.find((item) => item.id === arrangement)?.hint}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
        <select aria-label="Arrange topics as" value={arrangement} onChange={(event) => chooseArrangement(event.target.value as ExplorerArrangement)}>
          {ARRANGEMENTS.map((item) => <option key={item.id} value={item.id} title={item.hint}>{item.label}</option>)}
        </select>
      </label> : null}
      {renderDocument && documents.length ? <DocumentPicker documents={documents} openId={documentId} onOpen={openDocument} /> : null}
      {!empty ? <button type="button" className="topic-explorer-reset" onClick={startOver} title="Clear this exploration. Saved notes stay in your map.">Start over</button> : null}
    </header>
    {busy || message ? <div className="topic-explorer-status" aria-live="polite">
      {busy ? <div className="map-workspace-notice" role="status"><span className="map-explore-spinner" aria-hidden="true" /><span>{busy.progress || busy.label}</span><button type="button" onClick={() => busy.controller.abort()}>Cancel</button></div> : null}
      {message ? <div className={`map-workspace-notice${message.error ? " is-error" : ""}`} role={message.error ? "alert" : "status"}><span>{message.text}</span><button type="button" onClick={() => setMessage(null)}>Dismiss</button></div> : null}
    </div> : null}
    <div className={`topic-explorer-body${articleTitle || documentId ? " has-panes" : ""}`}>
    {articleTitle ? <WikipediaPane title={articleTitle} account={account} notes={passageNotes} onNotesChange={setPassageNotes}
      onNavigate={openArticle} onClose={() => setArticleTitle(null)}
      onCreateDocument={createDocument} onExplore={exploreText} onAddTopics={addAnswerTopics} /> : null}
    {documentId && renderDocument && documents.some((item) => item.id === documentId) ? <aside className="topic-explorer-pane is-document" aria-label="Document beside the explore map">
      <div className="conversation-graph-dock-body">
        {renderDocument(documentId, { leading: null, pinned: false, onTogglePin: () => undefined, onClose: () => setDocumentId(null), onOpenDocument: openDocument })}
      </div>
    </aside> : null}
    <div ref={canvasRef} className="topic-explorer-canvas" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      {empty ? <div className="topic-explorer-start">
        <h2>Explore any topic</h2>
        <p>A scratch map that stays out of your workspace. Click a topic to grow it from Wikipedia or AI, and save only what you want.</p>
        <TopicSearch autoFocus account={account} onPick={startFrom} onPickTitle={startFromTitle} onPickRepo={setRepoUrl} mapTitles={mapTitles} showSuggestions />
        <form className="topic-explorer-repo" onSubmit={(event) => { event.preventDefault(); if (repoDraft.trim()) setRepoUrl(repoDraft.trim()); }}>
          <h3>Or explore a codebase</h3>
          <div>
            <input type="text" inputMode="url" value={repoDraft} onChange={(event) => setRepoDraft(event.target.value)} placeholder="github.com/owner/repo" aria-label="GitHub repository to explore" />
            <button type="submit">Map repo</button>
          </div>
          {hasRecentRepos ? <button type="button" className="topic-explorer-repo-recent" onClick={() => setRepoUrl("")}>Recent repositories</button> : null}
        </form>
      </div> : <>
        <div className={`topic-explorer-world${dragging ? " is-dragging" : ""}`} data-arrangement={arrangement} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <svg className="topic-explorer-edges" aria-hidden="true">
            {edgePaths.map((edge) => <path key={edge.id} d={edge.path} className={edge.ai ? "is-ai" : undefined} />)}
          </svg>
          {[...layout.boxes].map(([id, box]) => {
            const item = state.items[id];
            const topicId = item.source.kind === "topic" ? item.source.topic.id : "";
            const saved = Boolean(savedTopics[topicId]);
            const root = item.parent === null;
            return <button key={id} type="button" className={`topic-explorer-node${selectedId === id ? " is-selected" : ""}${saved ? " is-saved" : ""}${root ? " is-root" : ""}${busy?.id === id ? " is-loading" : ""}${item.via.startsWith("AI") ? " is-ai" : ""}`}
              style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.width, height: box.height }}
              aria-pressed={selectedId === id} aria-label={`${item.label}${saved ? ", in your map" : ""}. Options`} title={item.detail || item.label}
              onPointerDown={(event) => onNodePointerDown(event, id)} onPointerMove={onNodePointerMove} onPointerUp={onNodePointerUp} onPointerCancel={onNodePointerUp}
              onClick={(event) => {
                event.stopPropagation();
                if (suppressClick.current) return;
                if (arrangement === "brain") { setFocusId(id); setSelectedId(id); return; }
                setSelectedId(selectedId === id ? null : id);
              }}>
              <strong>{item.label}</strong>
              <span>{saved ? "✓ In your map" : root ? item.detail || "Wikipedia" : item.via}</span>
              {childrenOf(id).length && (selectedId !== id || arrangement === "brain") ? <em aria-hidden="true">{childrenOf(id).length}</em> : null}
            </button>;
          })}
        </div>
        {selected && selectedBox ? <NodeMenu key={selected.id} box={toScreen(selectedBox)} canvas={size}
          label={selected.label} detail={selected.detail} url={selected.source.kind === "topic" ? selected.source.topic.wikipediaUrl : undefined}
          savedAs={selected.source.kind === "topic" ? savedTopics[selected.source.topic.id] : undefined}
          branchCount={descendants(state, selected.id).length - 1}
          wikipedia={state.expansions[expansionKey("wikipedia", selected.id)]}
          aiAsked={state.expansions[expansionKey("ai", selected.id)]?.nextOffset ?? 0}
          canAsk={Boolean(account?.canAsk)} busy={busy?.id === selected.id}
          onExpand={(source, focus) => expand(selected.id, source, focus)}
          onRead={selected.source.kind === "topic" ? () => openArticle((wikipediaTitle(selected.source.kind === "topic" ? selected.source.topic.wikipediaUrl : undefined) ?? selected.label).replace(/_/g, " ")) : undefined}
          onSave={(withBranches) => save(withBranches ? descendants(state, selected.id) : [selected.id])}
          onOpen={(id) => { if (renderDocument) { openDocument(id); setSelectedId(null); } else onOpenDocument(id); }}
          openLabel={renderDocument ? "Open the note beside" : "Open the note in my map"}
          onRemove={() => remove(selected.id)}
          onClose={() => setSelectedId(null)} /> : null}
        <div className="topic-explorer-zoom" role="group" aria-label="Zoom">
          <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in">+</button>
          <button type="button" onClick={() => zoomBy(0.8)} aria-label="Zoom out" title="Zoom out">−</button>
          <button type="button" onClick={fitAll} aria-label="Show everything" title="Show everything">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
          </button>
        </div>
      </>}
    </div>
    </div>
  </section>;
}

/** The small menu beside a clicked node. */
function NodeMenu({ box, canvas, label, detail, url, savedAs, branchCount, wikipedia, aiAsked, canAsk, busy, openLabel, onExpand, onRead, onSave, onOpen, onRemove, onClose }: {
  box: { x: number; y: number; width: number; height: number };
  canvas: { width: number; height: number };
  label: string; detail: string; url?: string; savedAs?: string; branchCount: number;
  wikipedia?: { nextOffset: number; hasMore: boolean }; aiAsked: number; canAsk: boolean; busy: boolean; openLabel: string;
  onExpand(source: ExplorerSource, focus?: string): void; onRead?: () => void; onSave(withBranches: boolean): void; onOpen(id: string): void; onRemove(): void; onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  /** The AI subgraph's optional prompt: what the person wants this branch to cover. */
  const [prompting, setPrompting] = useState(false);
  const [focus, setFocus] = useState("");
  const [height, setHeight] = useState(240);
  useLayoutEffect(() => { if (ref.current) setHeight(ref.current.offsetHeight); });
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true }); }, []);
  const width = Math.min(MENU_WIDTH, canvas.width - 16);
  const left = Math.min(Math.max(8, box.x + box.width / 2 - width / 2), canvas.width - width - 8);
  const below = box.y + box.height + 8;
  const top = below + height <= canvas.height - 8 || box.y - height - 8 < 8 ? Math.max(8, Math.min(below, canvas.height - height - 8)) : box.y - height - 8;
  const wikipediaDone = Boolean(wikipedia && !wikipedia.hasMore);
  return <div ref={ref} className="topic-explorer-menu" role="menu" aria-label={`${label} options`} style={{ left, top, width }}>
    <header>
      <strong>{label}</strong>
      <button type="button" className="topic-explorer-menu-close" aria-label="Close" onClick={onClose}>×</button>
    </header>
    {detail ? <p>{detail}</p> : null}
    <div className="topic-explorer-menu-grow">
      <button type="button" role="menuitem" disabled={busy || wikipediaDone} onClick={() => onExpand("wikipedia")}
        title={wikipediaDone ? "Every Wikipedia link of this topic is shown" : "Add this topic's main linked Wikipedia articles"}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 5l4.5 14L12 8l4.5 11L21 5" /></svg>
        <span>{wikipediaDone ? "All Wikipedia links shown" : wikipedia ? "More from Wikipedia" : "Wikipedia subgraph"}</span>
      </button>
      <button type="button" role="menuitem" aria-expanded={prompting} disabled={busy || !canAsk} onClick={() => setPrompting(!prompting)}
        title={canAsk ? "AI names this topic's main subtopics. Uses AI credit." : "AI subgraphs need a membership with AI turned on"}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" /></svg>
        <span>{aiAsked ? "More from AI" : "AI subgraph"}</span>
      </button>
    </div>
    {!canAsk ? <small>AI subgraphs need a membership with AI turned on.</small> : null}
    {prompting && canAsk ? <form className="topic-explorer-menu-prompt" onSubmit={(event) => {
      event.preventDefault(); onExpand("ai", focus); setPrompting(false); setFocus("");
      // The prompt goes away, so focus stays in the menu and Escape still closes it.
      window.setTimeout(() => ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true }), 0);
    }}>
      <textarea autoFocus rows={2} value={focus} maxLength={200} aria-label="What the AI subgraph should focus on"
        placeholder={`Optional: what about ${label} should it cover?`} onChange={(event) => setFocus(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
          if (event.key === "Escape") { event.stopPropagation(); setPrompting(false); }
        }} />
      <div><small>Uses the path that led here and its branches as context.</small><button type="submit" disabled={busy}>Generate</button></div>
    </form> : null}
    <div className="topic-explorer-menu-list">
      {savedAs ? <button type="button" role="menuitem" onClick={() => onOpen(savedAs)}>{openLabel}</button>
        : <button type="button" role="menuitem" onClick={() => onSave(false)}>Save to my map</button>}
      {branchCount ? <button type="button" role="menuitem" onClick={() => onSave(true)}>Save with its {branchCount} {branchCount === 1 ? "branch" : "branches"}</button> : null}
      {onRead ? <button type="button" role="menuitem" onClick={onRead}>Read on Wikipedia</button>
        : url ? <a role="menuitem" href={url} target="_blank" rel="noreferrer noopener">Read on Wikipedia ↗</a> : null}
      <button type="button" role="menuitem" className="is-quiet" onClick={onRemove}>Remove{branchCount ? " with its branches" : ""}</button>
    </div>
  </div>;
}

/** Opens one of the person's documents in a pane beside the explore map. */
function DocumentPicker({ documents, openId, onOpen }: { documents: Array<{ id: string; title: string }>; openId: string | null; onOpen(id: string): void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  const words = query.toLowerCase().trim();
  const shown = (words ? documents.filter((item) => item.title.toLowerCase().includes(words)) : documents).slice(0, 40);
  return <div className="topic-explorer-documents" ref={ref} onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
    <button type="button" aria-expanded={open} aria-haspopup="dialog" title="Open one of your documents beside the explore map" onClick={() => setOpen(!open)}>
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 3H6v18h12V7l-4-4ZM14 3v4h4M9 12h6M9 16h6" /></svg><span>Document</span>
    </button>
    {open ? <div className="topic-explorer-documents-list" role="dialog" aria-label="Open a document beside">
      <input autoFocus type="search" value={query} placeholder="Find a document…" aria-label="Find a document" onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && shown[0]) { onOpen(shown[0].id); setOpen(false); } }} />
      <div>
        {shown.map((item) => <button type="button" key={item.id} aria-pressed={item.id === openId} onClick={() => { onOpen(item.id); setOpen(false); setQuery(""); }}>{item.title || "Untitled"}</button>)}
        {!shown.length ? <p>No document matches.</p> : null}
      </div>
    </div> : null}
  </div>;
}

const aiSearchCache = new Map<string, PublicTopic[]>();
const AI_SEARCH_DELAY = 900;

/**
 * The topic search: AI's best matches first (for members), Wikipedia's
 * articles underneath, and starting suggestions before anything is typed.
 */
function TopicSearch({ compact = false, autoFocus = false, showSuggestions = false, mapTitles, account, onPick, onPickTitle, onPickRepo }: {
  compact?: boolean; autoFocus?: boolean; showSuggestions?: boolean; mapTitles: string[]; account?: PublicMapAccount;
  onPick(topic: PublicTopic): void; onPickTitle(title: string): void;
  /** A pasted GitHub repository address opens the code explorer. */
  onPickRepo?(url: string): void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PublicTopic[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const [ai, setAi] = useState<{ query: string; topics: PublicTopic[]; asking: boolean; error: string }>({ query: "", topics: [], asking: false, error: "" });
  const formRef = useRef<HTMLFormElement>(null);
  const canAsk = Boolean(account?.canAsk);
  const accountRef = useRef(account);
  accountRef.current = account;

  useEffect(() => {
    const search = query.trim();
    if (search.length < 2) { setResults([]); setError(""); setSearching(false); return; }
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchWikipediaTopics(search, controller.signal)
        .then((found) => { if (!controller.signal.aborted) { setResults(found.slice(0, 8)); setError(found.length ? "" : `No Wikipedia article matches “${search}”.`); } })
        .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason, "Wikipedia could not be searched.")); })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);

  // AI is asked once typing pauses, and each search is remembered so it is not paid for twice.
  useEffect(() => {
    const search = query.trim();
    const key = search.toLowerCase().replace(/\s+/g, " ");
    const account = accountRef.current;
    // A pasted repository address opens the code explorer, so it is never sent to AI as a topic.
    if (!canAsk || !account || search.length < 3 || (onPickRepo && githubRepoFromText(search))) { setAi({ query: "", topics: [], asking: false, error: "" }); return; }
    const cached = aiSearchCache.get(key);
    if (cached) { setAi({ query: search, topics: cached, asking: false, error: "" }); return; }
    const controller = new AbortController();
    setAi({ query: search, topics: [], asking: true, error: "" });
    const timer = window.setTimeout(() => {
      askAboutNote({ userId: account.userId, topic: { label: search.slice(0, 200), description: "" }, noteContent: "", question: aiSearchQuestion(search), options: account.aiOptions, signal: controller.signal })
        .then((answer) => {
          if (controller.signal.aborted) return;
          const exploredAt = new Date().toISOString();
          const topics = answer.related.map((topic) => publicTopicFromAnswer(topic, exploredAt));
          aiSearchCache.set(key, topics);
          while (aiSearchCache.size > 40) aiSearchCache.delete(aiSearchCache.keys().next().value!);
          setAi({ query: search, topics, asking: false, error: topics.length ? "" : "AI found no matching topics." });
        })
        .catch((reason) => {
          if (controller.signal.aborted) return;
          if (reason instanceof ApiError && reason.statusCode === 401) account.onAuthExpired?.();
          setAi({ query: search, topics: [], asking: false, error: errorMessage(reason, "AI could not be asked.") });
        })
        .finally(() => { if (!controller.signal.aborted) account.onBillingRefresh?.(); });
    }, AI_SEARCH_DELAY);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, canAsk]);

  useEffect(() => {
    if (!open || !compact) return;
    const onDown = (event: PointerEvent) => { if (!formRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, compact]);

  function pick(topic: PublicTopic) { onPick(topic); setQuery(""); setResults([]); setOpen(false); }
  function pickTitle(title: string) { onPickTitle(title); setQuery(""); setResults([]); setOpen(false); }
  function submit(event: FormEvent) {
    event.preventDefault();
    const repo = githubRepoFromText(query);
    if (repo && onPickRepo) { onPickRepo(repo); setQuery(""); setOpen(false); return; }
    const first = (ai.query === query.trim() ? ai.topics[0] : undefined) ?? results[0];
    if (first) pick(first);
    else if (query.trim().length >= 2) pickTitle(query.trim());
  }

  const listed = !compact || open;
  const suggestions = <div className="topic-explorer-suggestions">
    <h3>Suggested topics</h3>
    <div>{SUGGESTED_TOPICS.map((title) => <button type="button" key={title} onClick={() => pickTitle(title)}>{title}</button>)}</div>
    {mapTitles.length ? <><h3>From your map</h3><div>{mapTitles.map((title) => <button type="button" key={title} onClick={() => pickTitle(title)}>{title}</button>)}</div></> : null}
  </div>;
  const showAi = canAsk && query.trim().length >= 3;
  // An article AI already suggested is shown once, in AI's list.
  const aiTopics = new Set(ai.topics.flatMap((topic) => [topic.id, topic.label.toLowerCase()]));
  const wikipedia = showAi ? results.filter((topic) => !aiTopics.has(topic.id) && !aiTopics.has(topic.label.toLowerCase())) : results;

  return <form ref={formRef} className={`topic-explorer-search${compact ? " is-compact" : ""}`} role="search" onSubmit={submit}
    onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
    <label>
      <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>
      <input type="search" value={query} autoFocus={autoFocus} placeholder={compact ? "Explore another topic…" : canAsk ? "Ask AI or search Wikipedia for any topic…" : "Search Wikipedia for any topic…"}
        aria-label={canAsk ? "Ask AI or search Wikipedia for a topic to explore" : "Search Wikipedia for a topic to explore"}
        onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} />
    </label>
    {listed && (query.trim().length >= 2 || (compact && open)) ? <div className="topic-explorer-results">
      {query.trim().length >= 2 ? <>
        {onPickRepo && githubRepoFromText(query) ? <button type="button" onClick={() => { onPickRepo(githubRepoFromText(query)!); setQuery(""); setOpen(false); }}>
          <strong>Map this GitHub repository</strong><span>{githubRepoFromText(query)!.replace(/^https:\/\//u, "")}</span>
        </button> : null}
        {showAi ? <section className="topic-explorer-results-group is-ai" aria-label="AI suggestions">
          <h3>AI</h3>
          {ai.topics.map((topic) => <button type="button" key={topic.id} onClick={() => pick(topic)}><strong>{topic.label}</strong>{topic.description ? <span>{topic.description}</span> : null}</button>)}
          {ai.asking ? <p><span className="map-explore-spinner" aria-hidden="true" />Asking AI…</p> : null}
          {ai.error && !ai.asking ? <p role="alert">{ai.error}</p> : null}
        </section> : null}
        <section className="topic-explorer-results-group" aria-label="Wikipedia articles">
          {showAi ? <h3>Wikipedia</h3> : null}
          {wikipedia.map((topic) => <button type="button" key={topic.id} onClick={() => pick(topic)}><strong>{topic.label}</strong>{topic.description ? <span>{topic.description}</span> : null}</button>)}
          {searching && !results.length ? <p>Searching Wikipedia…</p> : null}
          {error && !searching ? <p role="alert">{error}</p> : null}
        </section>
      </> : suggestions}
    </div> : null}
    {showSuggestions && query.trim().length < 2 ? suggestions : null}
  </form>;
}
