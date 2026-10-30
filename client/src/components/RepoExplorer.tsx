import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import hljs from "highlight.js/lib/core";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import kotlin from "highlight.js/lib/languages/kotlin";
import php from "highlight.js/lib/languages/php";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import scss from "highlight.js/lib/languages/scss";
import swift from "highlight.js/lib/languages/swift";
import { renderMarkdownToHtml } from "../lib/markdown";
import { ApiError } from "../lib/apiError";
import type { PublicMapAccount } from "./PublicTopicInsights";
import {
  addRepoNote, fileContext, fileLevel, fileId, folderId, folderLevel, folderOutline, githubUrl, indexRepo, layoutFileLevel, layoutFolderLevel, noteDocument, rawFileUrl,
  readRepoMemory, rememberRepo, REPO_EXPLORER_KEY, REPO_CARD, repoKey, repoLabel, requestExplanation, requestRepoGraph, sliceLines, symbolContext, symbolId, targetNodeId,
  type ExplainTarget, type RepoBox, type RepoExplorerMemory, type RepoGraph, type RepoNode, type RepoNote, type RepoSymbol,
} from "../lib/repoGraph";
import { boundsOf, clampScale, fitView, type ExplorerView } from "../lib/topicExplorer";
import "./TopicExplorer.css";
import "./RepoExplorer.css";

// The Markdown renderer registers the common languages; these cover the rest a repository may hold.
for (const [name, language] of Object.entries({ c, cpp, csharp, go, ini, java, kotlin, php, ruby, rust, scala, scss, swift })) if (!hljs.getLanguage(name)) hljs.registerLanguage(name, language);
const HIGHLIGHT: Record<string, string> = { typescript: "typescript", javascript: "javascript", vue: "xml", svelte: "xml", python: "python", go: "go", rust: "rust", java: "java", kotlin: "kotlin",
  swift: "swift", ruby: "ruby", php: "php", csharp: "csharp", c: "c", cpp: "cpp", scala: "scala", css: "css", scss: "scss", html: "xml", markdown: "markdown", json: "json", yaml: "yaml",
  toml: "ini", sql: "sql", shell: "bash" };

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const browserStorage = () => { try { return window.localStorage; } catch { return undefined; } };
const MENU_WIDTH = 264;
const NOTE = { width: REPO_CARD.width + 44, height: 132, gap: 10 };

type Location = { kind: "folder"; path: string } | { kind: "file"; path: string };
type Pane = { kind: "code"; path: string; symbol?: RepoSymbol; whole?: boolean } | { kind: "doc"; noteId: string };

/**
 * A GitHub repository as a map you can walk through: folders laid out by
 * what imports what, then a file's functions. Any function's code opens in a
 * side pane, and AI explains a function, file or folder as a small note
 * beside it or as a side document. Nothing reaches the vault until saved.
 */
export default function RepoExplorer({ initialUrl, account, onBack, onClose, onSaveNote }: {
  initialUrl: string;
  account?: PublicMapAccount;
  /** Back to the topic explorer. */
  onBack(): void;
  /** Back to the person's own map. */
  onClose(): void;
  /** Saves a note into the vault; returns false when it could not. */
  onSaveNote?(note: { title: string; content: string }): boolean;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [graph, setGraph] = useState<RepoGraph | null>(null);
  const [location, setLocation] = useState<Location>({ kind: "folder", path: "" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane | null>(null);
  const [view, setView] = useState<ExplorerView>({ x: 0, y: 0, scale: 1 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [busy, setBusy] = useState<{ id: string | null; label: string; progress: string; controller: AbortController } | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [memory, setMemory] = useState<RepoExplorerMemory>(() => readRepoMemory(browserStorage()));
  /** A new note to bring into view once it is laid out. */
  const [revealNote, setRevealNote] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef<typeof busy>(null);
  const files = useRef(new Map<string, Promise<string>>());
  const latest = useRef({ view });
  latest.current = { view };

  useEffect(() => { try { browserStorage()?.setItem(REPO_EXPLORER_KEY, JSON.stringify(memory)); } catch { /* Notes still show until the page closes. */ } }, [memory]);
  useEffect(() => () => busyRef.current?.controller.abort(), []);
  useEffect(() => { if (initialUrl) load(initialUrl); }, [initialUrl]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => setSize({ width: canvas.clientWidth, height: canvas.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [graph, pane !== null]);

  const index = useMemo(() => graph ? indexRepo(graph) : null, [graph]);
  const level = useMemo(() => !index ? null : location.kind === "folder" ? folderLevel(index, location.path) : fileLevel(index, location.path), [index, location]);
  const notes = graph ? memory.notes[repoKey(graph)] ?? [] : [];
  const layout = useMemo(() => {
    if (!level) return { boxes: new Map<string, RepoBox>(), notes: new Map<string, RepoBox>() };
    const boxes = location.kind === "folder" ? layoutFolderLevel(level) : layoutFileLevel(level);
    return withNotes(boxes, notes.filter((note) => note.style === "note"));
  }, [level, location.kind, notes]);
  const nodes = useMemo(() => new Map((level?.nodes ?? []).map((node) => [node.id, node])), [level]);

  // A new level shows the whole of it.
  const fitted = useRef("");
  const levelKey = `${location.kind}:${location.path}`;
  useEffect(() => {
    if (!size.width || !layout.boxes.size || fitted.current === levelKey) return;
    fitted.current = levelKey;
    const bounds = boundsOf(layout.boxes.values());
    if (!bounds) return;
    const whole = fitView(bounds, size.width, size.height);
    // Big folders open at a readable size from their left edge, rather than as specks.
    const scale = 0.8;
    setView(whole.scale >= 0.72 ? whole : { scale, x: 32 - bounds.x * scale, y: size.height / 2 - (bounds.y + bounds.height / 2) * scale });
  }, [layout, size, levelKey]);

  useEffect(() => {
    const box = revealNote ? layout.notes.get(revealNote) : undefined;
    if (!box || !size.width) return;
    setRevealNote(null);
    const current = latest.current.view;
    const left = box.x * current.scale + current.x, top = box.y * current.scale + current.y;
    if (left >= 16 && top >= 16 && left + box.width * current.scale <= size.width - 16 && top + box.height * current.scale <= size.height - 16) return;
    const scale = Math.max(current.scale, 0.8);
    setView({ scale, x: size.width / 2 - (box.x + box.width / 2) * scale, y: size.height / 2 - (box.y + box.height / 2) * scale });
  }, [revealNote, layout, size]);

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
      setMessage({ text: errorMessage(error, "That did not work. Try again."), error: true });
    } finally {
      if (busyRef.current === entry) { busyRef.current = null; setBusy(null); }
    }
  }

  function load(address: string) {
    if (!account) { setMessage({ text: "Sign in to explore a repository.", error: true }); return; }
    void run(null, "Reading the repository…", async (signal, progress) => {
      const next = await requestRepoGraph({ url: address, expectedUserId: account.userId, signal, onProgress: progress });
      files.current.clear();
      const nextIndex = indexRepo(next);
      setGraph(next); setPane(null); setSelectedId(null); fitted.current = "";
      setLocation({ kind: "folder", path: nextIndex.root });
      setMemory((current) => rememberRepo(current, next.repo.url + (next.repo.folder ? `/tree/${next.repo.ref ?? "HEAD"}/${next.repo.folder}` : ""), repoLabel(next), new Date().toISOString()));
      if (next.stats.truncated) setMessage({ text: "This repository is large, so only part of it is mapped.", error: false });
    });
  }

  function readFile(path: string, signal?: AbortSignal) {
    if (!graph) return Promise.reject(new Error("No repository is open."));
    let pending = files.current.get(path);
    if (!pending) {
      pending = fetch(rawFileUrl(graph, path), { signal }).then((response) => {
        if (!response.ok) throw new Error(`GitHub did not send ${path} (status ${response.status}).`);
        return response.text();
      });
      pending.catch(() => files.current.delete(path));
      files.current.set(path, pending);
    }
    return pending;
  }

  function go(next: Location, select: string | null = null) {
    setLocation(next); setSelectedId(select);
  }

  function open(node: RepoNode) {
    if (node.kind === "folder") go({ kind: "folder", path: node.path });
    else if (node.kind === "file") go({ kind: "file", path: node.path });
    else setPane({ kind: "code", path: node.path, symbol: node.symbol });
  }

  /** Asks AI about a function, file, folder or the whole repository. */
  function explain(target: ExplainTarget, style: "note" | "document", question = "") {
    if (!graph || !index || !account?.canAsk) return;
    const label = target.kind === "repo" ? repoLabel(graph) : target.name || target.path || graph.repo.name;
    void run(targetNodeId(target), `Asking AI about ${label}…`, async (signal, progress) => {
      let code = "", context = "";
      if (target.kind === "symbol" || target.kind === "file") {
        const text = await readFile(target.path, signal);
        const file = graph.files[index.byPath.get(target.path)!];
        const symbol = file?.symbols.find((item) => item.name === target.name);
        code = target.kind === "symbol" && symbol ? sliceLines(text, symbol.line, symbol.end) : text;
        context = target.kind === "symbol" && symbol ? symbolContext(index, target.path, symbol) : fileContext(index, target.path);
      } else context = folderOutline(index, target.kind === "repo" ? index.root : target.path);
      // Notes already written nearby help AI build on them.
      const nearby = notes.filter((note) => note.target.path && target.path.startsWith(note.target.path) && note.target !== target).slice(-3);
      if (nearby.length) context += `\n\nNotes already written about the surrounding code:\n${nearby.map((note) => `- ${note.target.name || note.target.path}: ${note.markdown.slice(0, 400)}`).join("\n")}`;
      try {
        const result = await requestExplanation({ ...account.aiOptions, repo: graph.repo.url, target, style, code: code.slice(0, 40_000), context: context.slice(0, 16_000), question,
          expectedUserId: account.userId, signal, onProgress: progress });
        signal.throwIfAborted();
        const note: RepoNote = { id: `note-${Date.now().toString(36)}`, target, markdown: result.markdown, question, createdAt: new Date().toISOString(), style };
        setMemory((current) => addRepoNote(current, repoKey(graph), note));
        if (style === "document") setPane({ kind: "doc", noteId: note.id });
        else setRevealNote(note.id);
      } finally { account.onBillingRefresh?.(); }
    });
  }

  async function save(note: RepoNote) {
    if (!graph || !index || !onSaveNote) return;
    let code = "", language: string | null = null;
    if (note.target.kind === "symbol" || note.target.kind === "file") {
      const file = graph.files[index.byPath.get(note.target.path)!];
      language = file?.language ? HIGHLIGHT[file.language] ?? file.language : null;
      try {
        const text = await readFile(note.target.path);
        const symbol = file?.symbols.find((item) => item.name === note.target.name);
        code = symbol ? sliceLines(text, symbol.line, symbol.end) : note.target.kind === "file" && text.length < 20_000 ? text : "";
      } catch { /* The note saves without its code. */ }
    }
    const saved = onSaveNote(noteDocument(graph, note, code, language));
    setMessage({ text: saved ? "Saved to your map." : "That could not be saved.", error: !saved });
  }

  function removeNote(id: string) {
    if (!graph) return;
    const key = repoKey(graph);
    setMemory((current) => ({ ...current, notes: { ...current.notes, [key]: (current.notes[key] ?? []).filter((note) => note.id !== id) } }));
    if (pane?.kind === "doc" && pane.noteId === id) setPane(null);
  }

  // Pan by dragging empty space, pinch or Ctrl+wheel to zoom, wheel to pan.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; distance: number } | null>(null);
  function zoomBy(factor: number, at = { x: size.width / 2, y: size.height / 2 }) {
    setView((current) => {
      const scale = clampScale(current.scale * factor);
      return { scale, x: at.x - (at.x - current.x) * (scale / current.scale), y: at.y - (at.y - current.y) * (scale / current.scale) };
    });
  }
  function fitAll() { const bounds = boundsOf([...layout.boxes.values(), ...layout.notes.values()]); if (bounds && size.width) setView(fitView(bounds, size.width, size.height)); }
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button, a, input, form, .topic-explorer-menu, .repo-explorer-note")) return;
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
      if ((event.target as HTMLElement).closest(".topic-explorer-menu, .repo-explorer-note")) return;
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
    else if (pane) setPane(null);
    else if (graph && index && !(location.kind === "folder" && location.path === index.root)) up();
    else onBack();
  }

  function up() {
    if (!index) return;
    if (location.kind === "file") { go({ kind: "folder", path: location.path.slice(0, Math.max(0, location.path.lastIndexOf("/"))) }, fileId(location.path)); return; }
    let parent = location.path.slice(0, Math.max(0, location.path.lastIndexOf("/")));
    // Skip folders that only hold this one, as the map does.
    while (parent && parent !== index.root && index.folders.get(parent)?.folders.length === 1 && !index.folders.get(parent)?.files.length) parent = parent.slice(0, Math.max(0, parent.lastIndexOf("/")));
    if (index.root.startsWith(parent) && parent.length < index.root.length) parent = index.root;
    go({ kind: "folder", path: parent }, folderId(location.path));
  }

  const toScreen = (box: RepoBox) => ({ x: box.x * view.scale + view.x, y: box.y * view.scale + view.y, width: box.width * view.scale, height: box.height * view.scale });
  const selected = selectedId ? nodes.get(selectedId) : undefined;
  const selectedBox = selectedId ? layout.boxes.get(selectedId) : undefined;
  const maxWeight = Math.max(1, ...(level?.edges ?? []).map((edge) => edge.weight));
  const crumbs = index ? breadcrumbs(index.root, location, graph!.repo.name) : [];
  const paneNote = pane?.kind === "doc" ? notes.find((note) => note.id === pane.noteId) : undefined;

  if (!graph || !index || !level) return <section className="topic-explorer repo-explorer" aria-label="Explore a GitHub repository" onKeyDown={onKeyDown}>
    <header className="topic-explorer-bar">
      <button type="button" className="topic-explorer-back" onClick={onBack} aria-label="Back to Explore" title="Back to Explore">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg><span>Explore</span>
      </button>
      <strong className="topic-explorer-title">GitHub repository</strong>
    </header>
    <StatusBar busy={busy} message={message} onDismiss={() => setMessage(null)} />
    <div ref={canvasRef} className="topic-explorer-canvas">
      <div className="topic-explorer-start">
        <h2>Explore a codebase</h2>
        <p>Paste a public GitHub repository. Margin Chat reads it and maps its folders, files and functions, free. AI explains code only when you ask.</p>
        <RepoForm url={url} onChange={setUrl} disabled={Boolean(busy)} onSubmit={load} />
        {memory.recent.length ? <div className="topic-explorer-suggestions"><h3>Recent</h3><div>{memory.recent.map((item) => <button type="button" key={item.label} onClick={() => { setUrl(item.url); load(item.url); }}>{item.label}</button>)}</div></div> : null}
      </div>
    </div>
  </section>;

  return <section className="topic-explorer repo-explorer" aria-label={`Explore ${repoLabel(graph)}`} onKeyDown={onKeyDown}>
    <header className="topic-explorer-bar">
      <button type="button" className="topic-explorer-back" onClick={onClose} aria-label="Back to my map" title="Back to my map">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg><span>My map</span>
      </button>
      <nav className="repo-explorer-crumbs" aria-label="Where you are">
        {crumbs.map((crumb, position) => <span key={crumb.key}>
          {position ? <i aria-hidden="true">/</i> : null}
          {position === crumbs.length - 1 ? <strong>{crumb.label}</strong> : <button type="button" onClick={() => go(crumb.location)}>{crumb.label}</button>}
        </span>)}
      </nav>
      <RepoSearch index={index} onPick={(path, symbol) => {
        if (symbol) { go({ kind: "file", path }, symbolId(path, symbol.name)); setPane({ kind: "code", path, symbol }); }
        else go({ kind: "file", path }, fileId(path));
      }} />
      <button type="button" aria-label={location.kind === "file" ? "Explain file" : "Explain architecture"} disabled={!account?.canAsk || Boolean(busy)} title={account?.canAsk ? "AI explains how this part of the code is put together. Uses AI credit." : "AI needs a membership with AI turned on"}
        onClick={() => explain(location.kind === "file" ? { kind: "file", path: location.path, name: location.path.split("/").at(-1) }
          : location.path === index.root ? { kind: "repo", path: "" } : { kind: "folder", path: location.path, name: `${location.path}/` }, "document")}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /></svg>
        <span>{location.kind === "file" ? "Explain file" : "Explain architecture"}</span>
      </button>
      <button type="button" className="topic-explorer-reset" onClick={() => { setGraph(null); setPane(null); }} title="Explore another repository">Other repo</button>
    </header>
    <StatusBar busy={busy} message={message} onDismiss={() => setMessage(null)} />
    <div className={`topic-explorer-body${pane ? " has-panes" : ""}`}>
      {pane?.kind === "code" ? <CodePane key={`${pane.path}#${pane.symbol?.name ?? ""}`} graph={graph} pane={pane} read={readFile} canAsk={Boolean(account?.canAsk)} busy={Boolean(busy)}
        onWhole={(whole) => setPane({ ...pane, whole })}
        onExplain={(style) => explain(pane.symbol ? { kind: "symbol", path: pane.path, name: pane.symbol.name } : { kind: "file", path: pane.path, name: pane.path.split("/").at(-1) }, style)}
        onClose={() => setPane(null)} /> : null}
      {paneNote ? <DocPane note={paneNote} canSave={Boolean(onSaveNote)} onSave={() => void save(paneNote)} onRemove={() => removeNote(paneNote.id)} onClose={() => setPane(null)}
        onShowCode={paneNote.target.kind === "symbol" || paneNote.target.kind === "file" ? () => {
          const file = graph.files[index.byPath.get(paneNote.target.path)!];
          setPane({ kind: "code", path: paneNote.target.path, symbol: file?.symbols.find((item) => item.name === paneNote.target.name) });
        } : undefined} /> : null}
      <div ref={canvasRef} className="topic-explorer-canvas"
        // Focusing a card off screen scrolls the canvas, which would shift the menu away from its card; the map pans instead.
        onScroll={(event) => { event.currentTarget.scrollLeft = 0; event.currentTarget.scrollTop = 0; }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <div className="topic-explorer-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <svg className="topic-explorer-edges" aria-hidden="true">
            {level.edges.map((edge) => {
              const from = layout.boxes.get(edge.from), to = layout.boxes.get(edge.to);
              if (!from || !to) return null;
              const lit = selectedId === edge.from || selectedId === edge.to;
              return <path key={`${edge.from}>${edge.to}`} d={edgePath(from, to)} className={lit ? "is-lit" : undefined}
                style={{ strokeWidth: 1 + 3 * Math.sqrt(edge.weight / maxWeight), opacity: selectedId && !lit ? 0.18 : 0.75 }} />;
            })}
          </svg>
          {level.nodes.map((node) => {
            const box = layout.boxes.get(node.id);
            if (!box) return null;
            const hasNote = notes.some((note) => targetNodeId(note.target) === node.id);
            return <button key={node.id} type="button" data-kind={node.kind} data-role={node.role}
              className={`topic-explorer-node repo-explorer-node${selectedId === node.id ? " is-selected" : ""}${level.center === node.id ? " is-root" : ""}${busy?.id === node.id ? " is-loading" : ""}`}
              style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.width, height: box.height }}
              aria-pressed={selectedId === node.id} aria-label={`${node.label}, ${node.kind}. Options`} title={node.symbol?.signature ?? node.path}
              onClick={(event) => { event.stopPropagation(); setSelectedId(selectedId === node.id ? null : node.id); }}
              onDoubleClick={(event) => { event.stopPropagation(); open(node); }}>
              <strong><KindIcon node={node} />{node.label}</strong>
              <span>{node.role === "imports" ? `imported · ${node.detail}` : node.role === "importedBy" ? `imports this · ${node.detail}` : node.detail}</span>
              {hasNote ? <em aria-label="Has an AI note">✎</em> : null}
            </button>;
          })}
          {notes.filter((note) => note.style === "note").map((note) => {
            const box = layout.notes.get(note.id);
            if (!box) return null;
            return <RepoNoteCard key={note.id} note={note} box={box} canSave={Boolean(onSaveNote)} onOpen={() => setPane({ kind: "doc", noteId: note.id })}
              onSave={() => void save(note)} onRemove={() => removeNote(note.id)} />;
          })}
        </div>
        {selected && selectedBox ? <NodeMenu key={selected.id} node={selected} graph={graph} box={toScreen(selectedBox)} canvas={size} canAsk={Boolean(account?.canAsk)} busy={Boolean(busy)}
          usedBy={(selected.symbol?.usedBy ?? []).map((position) => graph.files[position]?.path).filter(Boolean)}
          onOpen={() => open(selected)}
          onCode={() => { setPane({ kind: "code", path: selected.path, symbol: selected.symbol }); setSelectedId(null); }}
          onExplain={(style, question) => {
            explain(selected.kind === "symbol" ? { kind: "symbol", path: selected.path, name: selected.symbol!.name }
              : selected.kind === "file" ? { kind: "file", path: selected.path, name: selected.label } : { kind: "folder", path: selected.path, name: selected.label }, style, question);
            setSelectedId(null);
          }}
          onGoToFile={(path) => go({ kind: "file", path }, fileId(path))}
          onClose={() => setSelectedId(null)} /> : null}
        <div className="topic-explorer-zoom" role="group" aria-label="Zoom">
          <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in">+</button>
          <button type="button" onClick={() => zoomBy(0.8)} aria-label="Zoom out" title="Zoom out">−</button>
          <button type="button" onClick={fitAll} aria-label="Show everything" title="Show everything">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
          </button>
        </div>
        {location.kind === "folder" && level.edges.length ? <p className="repo-explorer-legend">Lines show imports. Code on the left uses code on the right.</p> : null}
      </div>
    </div>
  </section>;
}

/** Note cards go under the card they explain; anything below in the same column moves down to make room. */
function withNotes(boxes: Map<string, RepoBox>, notes: RepoNote[]) {
  const placed = new Map(boxes);
  const noteBoxes = new Map<string, RepoBox>();
  const targets = notes.flatMap((note) => { const box = placed.get(targetNodeId(note.target)); return box ? [{ note, box }] : []; }).sort((a, b) => a.box.y - b.box.y);
  for (const { note } of targets) {
    const anchor = placed.get(targetNodeId(note.target))!;
    const below = [...noteBoxes.values()].filter((other) => other.x === anchor.x - 22 && other.y >= anchor.y).reduce((bottom, other) => Math.max(bottom, other.y + other.height + NOTE.gap), anchor.y + anchor.height + NOTE.gap);
    const box = { x: anchor.x - 22, y: below, width: NOTE.width, height: NOTE.height };
    const shift = NOTE.height + NOTE.gap;
    for (const [id, other] of placed) if (other.y > anchor.y && other.x < box.x + box.width && box.x < other.x + other.width) placed.set(id, { ...other, y: other.y + shift });
    for (const [id, other] of noteBoxes) if (other.y >= box.y && other.x < box.x + box.width && box.x < other.x + other.width) noteBoxes.set(id, { ...other, y: other.y + shift });
    noteBoxes.set(note.id, box);
  }
  return { boxes: placed, notes: noteBoxes };
}

function edgePath(from: RepoBox, to: RepoBox) {
  // Side to side when the cards stand in different columns, otherwise top to bottom.
  if (from.x + from.width < to.x || to.x + to.width < from.x) {
    const right = from.x < to.x;
    const x1 = right ? from.x + from.width : from.x, y1 = from.y + from.height / 2;
    const x2 = right ? to.x : to.x + to.width, y2 = to.y + to.height / 2;
    const bend = Math.max(24, Math.abs(x2 - x1) / 2) * (right ? 1 : -1);
    return `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
  }
  const down = from.y < to.y;
  const x1 = from.x + from.width / 2, y1 = down ? from.y + from.height : from.y;
  const x2 = to.x + to.width / 2, y2 = down ? to.y : to.y + to.height;
  const bend = Math.max(18, Math.abs(y2 - y1) / 2) * (down ? 1 : -1);
  return `M${x1} ${y1}C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`;
}

function breadcrumbs(root: string, location: Location, repoName: string) {
  const crumbs: Array<{ key: string; label: string; location: Location }> = [{ key: "root", label: root ? `${repoName} / ${root}` : repoName, location: { kind: "folder", path: root } }];
  const rest = location.path.startsWith(root) ? location.path.slice(root.length).replace(/^\//u, "") : location.path;
  const parts = rest ? rest.split("/") : [];
  parts.forEach((part, position) => {
    const path = [root, ...parts.slice(0, position + 1)].filter(Boolean).join("/");
    const last = position === parts.length - 1;
    crumbs.push({ key: path, label: part, location: last && location.kind === "file" ? location : { kind: "folder", path } });
  });
  return crumbs;
}

function KindIcon({ node }: { node: RepoNode }) {
  const kind = node.kind === "symbol" ? node.symbol!.kind : node.kind;
  const letter = kind === "folder" ? "" : kind === "file" ? "" : kind === "class" ? "C" : kind === "type" ? "T" : kind === "method" ? "m" : "ƒ";
  if (kind === "folder") return <svg className="repo-explorer-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>;
  if (kind === "file") return <svg className="repo-explorer-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /></svg>;
  return <b className={`repo-explorer-kind is-${kind}`} aria-hidden="true">{letter}</b>;
}

function StatusBar({ busy, message, onDismiss }: { busy: { label: string; progress: string; controller: AbortController } | null; message: { text: string; error: boolean } | null; onDismiss(): void }) {
  if (!busy && !message) return null;
  return <div className="topic-explorer-status" aria-live="polite">
    {busy ? <div className="map-workspace-notice" role="status"><span className="map-explore-spinner" aria-hidden="true" /><span>{busy.progress || busy.label}</span><button type="button" onClick={() => busy.controller.abort()}>Cancel</button></div> : null}
    {message ? <div className={`map-workspace-notice${message.error ? " is-error" : ""}`} role={message.error ? "alert" : "status"}><span>{message.text}</span><button type="button" onClick={onDismiss}>Dismiss</button></div> : null}
  </div>;
}

export function RepoForm({ url, onChange, onSubmit, disabled = false, autoFocus = true }: { url: string; onChange(url: string): void; onSubmit(url: string): void; disabled?: boolean; autoFocus?: boolean }) {
  function submit(event: FormEvent) { event.preventDefault(); if (url.trim()) onSubmit(url.trim()); }
  return <form className="topic-explorer-search repo-explorer-form" onSubmit={submit}>
    <label>
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" /></svg>
      <input type="text" inputMode="url" value={url} autoFocus={autoFocus} placeholder="github.com/owner/repo" aria-label="GitHub repository address" onChange={(event) => onChange(event.target.value)} />
    </label>
    <button type="submit" disabled={disabled || !url.trim()}>Map it</button>
  </form>;
}

/** Find a file or function by name. */
function RepoSearch({ index, onPick }: { index: ReturnType<typeof indexRepo>; onPick(path: string, symbol?: RepoSymbol): void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const results = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (search.length < 2) return [];
    const found: Array<{ path: string; symbol?: RepoSymbol; score: number }> = [];
    for (const file of index.graph.files) {
      const name = file.path.slice(file.path.lastIndexOf("/") + 1).toLowerCase();
      if (name.includes(search) || file.path.toLowerCase().includes(search)) found.push({ path: file.path, score: name.startsWith(search) ? 0 : name.includes(search) ? 1 : 3 });
      for (const symbol of file.symbols) {
        const label = symbol.name.toLowerCase();
        if (label.includes(search)) found.push({ path: file.path, symbol, score: label === search || label.endsWith(`.${search}`) ? 0 : label.startsWith(search) ? 1 : 2 + (symbol.exported ? 0 : 0.5) });
      }
      if (found.length > 400) break;
    }
    return found.sort((a, b) => a.score - b.score || a.path.length - b.path.length).slice(0, 12);
  }, [index, query]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => { if (!formRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  const pick = (item: { path: string; symbol?: RepoSymbol }) => { onPick(item.path, item.symbol); setQuery(""); setOpen(false); };
  return <form ref={formRef} className="topic-explorer-search is-compact repo-explorer-search" role="search" onSubmit={(event) => { event.preventDefault(); if (results[0]) pick(results[0]); }}
    onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
    <label>
      <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>
      <input type="search" value={query} placeholder="Find a file or function…" aria-label="Find a file or function" onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} />
    </label>
    {open && query.trim().length >= 2 ? <div className="topic-explorer-results">
      {results.map((item) => <button type="button" key={`${item.path}#${item.symbol?.name ?? ""}`} onClick={() => pick(item)}>
        <strong>{item.symbol ? item.symbol.name : item.path.slice(item.path.lastIndexOf("/") + 1)}</strong><span>{item.symbol ? `${item.symbol.kind} in ${item.path}` : item.path}</span>
      </button>)}
      {!results.length ? <p>Nothing matches “{query.trim()}”.</p> : null}
    </div> : null}
  </form>;
}

/** The menu beside a clicked card: open it, read its code, or have AI explain it. */
function NodeMenu({ node, graph, box, canvas, canAsk, busy, usedBy, onOpen, onCode, onExplain, onGoToFile, onClose }: {
  node: RepoNode; graph: RepoGraph; box: RepoBox; canvas: { width: number; height: number }; canAsk: boolean; busy: boolean; usedBy: string[];
  onOpen(): void; onCode(): void; onExplain(style: "note" | "document", question: string): void; onGoToFile(path: string): void; onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(260);
  const [question, setQuestion] = useState("");
  useLayoutEffect(() => { if (ref.current) setHeight(ref.current.offsetHeight); });
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true }); }, []);
  const width = Math.min(MENU_WIDTH, canvas.width - 16);
  const left = Math.min(Math.max(8, box.x + box.width / 2 - width / 2), canvas.width - width - 8);
  const below = box.y + box.height + 8;
  const top = below + height <= canvas.height - 8 || box.y - height - 8 < 8 ? Math.max(8, Math.min(below, canvas.height - height - 8)) : box.y - height - 8;
  const symbol = node.symbol;
  const explainTitle = canAsk ? "Uses AI credit, with the model you chose for AI" : "AI needs a membership with AI turned on";
  return <div ref={ref} className="topic-explorer-menu repo-explorer-menu" role="menu" aria-label={`${node.label} options`} style={{ left, top, width }}>
    <header>
      <strong>{node.label}</strong>
      <button type="button" className="topic-explorer-menu-close" aria-label="Close" onClick={onClose}>×</button>
    </header>
    <p>{symbol?.signature ?? node.path}</p>
    <div className="topic-explorer-menu-grow">
      {node.kind === "symbol" ? <button type="button" role="menuitem" onClick={onCode}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m8 7-5 5 5 5M16 7l5 5-5 5" /></svg><span>View code</span>
      </button> : <button type="button" role="menuitem" onClick={onOpen}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
        <span>{node.kind === "folder" ? "Open folder" : "Open functions"}</span>
      </button>}
      {node.kind === "file" ? <button type="button" role="menuitem" onClick={onCode}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m8 7-5 5 5 5M16 7l5 5-5 5" /></svg><span>View code</span>
      </button> : <button type="button" role="menuitem" disabled={busy || !canAsk} title={explainTitle} onClick={() => onExplain("document", question.trim())}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 4h10l6 6v10H4Z" /><path d="M14 4v6h6M8 14h8M8 17h5" /></svg><span>Explain in side document</span>
      </button>}
    </div>
    <div className="repo-explorer-ask">
      <input type="text" value={question} maxLength={500} disabled={!canAsk} placeholder={canAsk ? "Ask something specific (optional)" : "AI needs a membership with AI turned on"} aria-label="Question for AI (optional)"
        onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && canAsk && !busy) { event.preventDefault(); onExplain("note", question.trim()); } }} />
    </div>
    <div className="topic-explorer-menu-list">
      <button type="button" role="menuitem" disabled={busy || !canAsk} title={explainTitle} onClick={() => onExplain("note", question.trim())}>✎ Explain as a note beside it</button>
      {node.kind === "file" ? <button type="button" role="menuitem" disabled={busy || !canAsk} title={explainTitle} onClick={() => onExplain("document", question.trim())}>Explain in a side document</button> : null}
      {usedBy.length ? <details className="repo-explorer-used"><summary>Used in {usedBy.length} {usedBy.length === 1 ? "file" : "files"}</summary>
        {usedBy.map((path) => <button type="button" key={path} role="menuitem" onClick={() => onGoToFile(path)}>{path}</button>)}
      </details> : null}
      <a role="menuitem" href={githubUrl(graph, node.path, symbol ? { line: symbol.line, end: symbol.end } : undefined, node.kind === "folder")} target="_blank" rel="noreferrer noopener">Open on GitHub ↗</a>
    </div>
  </div>;
}

function RepoNoteCard({ note, box, canSave, onOpen, onSave, onRemove }: { note: RepoNote; box: RepoBox; canSave: boolean; onOpen(): void; onSave(): void; onRemove(): void }) {
  const html = useMemo(() => renderMarkdownToHtml(note.markdown), [note.markdown]);
  return <article className="repo-explorer-note" style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.width, height: box.height }} aria-label={`AI note on ${note.target.name || note.target.path}`}>
    <div className="repo-explorer-note-text message-content is-markdown" dangerouslySetInnerHTML={{ __html: html }} />
    <footer>
      <button type="button" onClick={onOpen} title="Open as a side document">Open</button>
      {canSave ? <button type="button" onClick={onSave} title="Save this note with its code to your map">Save</button> : null}
      <button type="button" className="is-quiet" onClick={onRemove} aria-label="Remove note" title="Remove note">×</button>
    </footer>
  </article>;
}

function CodePane({ graph, pane, read, canAsk, busy, onWhole, onExplain, onClose }: {
  graph: RepoGraph; pane: Extract<Pane, { kind: "code" }>; read(path: string): Promise<string>; canAsk: boolean; busy: boolean;
  onWhole(whole: boolean): void; onExplain(style: "note" | "document"): void; onClose(): void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    read(pane.path).then((value) => { if (live) setText(value); }, (reason) => { if (live) setError(errorMessage(reason, "The code could not be read.")); });
    return () => { live = false; };
  }, [pane.path]);
  const file = graph.files.find((item) => item.path === pane.path);
  const symbol = pane.symbol;
  const range = symbol && !pane.whole ? { line: symbol.line, end: symbol.end } : { line: 1, end: Number.MAX_SAFE_INTEGER };
  const code = text === null ? "" : sliceLines(text, range.line, range.end);
  const language = file?.language ? HIGHLIGHT[file.language] : undefined;
  const html = useMemo(() => {
    if (!code) return "";
    try { return language && hljs.getLanguage(language) ? hljs.highlight(code, { language, ignoreIllegals: true }).value : hljs.highlightAuto(code).value; }
    catch { return code.replace(/[&<>]/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!); }
  }, [code, language]);
  const count = code ? code.split("\n").length : 0;
  // The whole file scrolls to the function it was opened from.
  useEffect(() => {
    if (!pane.whole || !symbol || !scrollRef.current) return;
    const lineHeight = 19.5;
    scrollRef.current.scrollTop = Math.max(0, (symbol.line - 4) * lineHeight);
  }, [pane.whole, html]);
  return <aside className="topic-explorer-pane repo-explorer-pane" aria-label={`Code of ${symbol?.name ?? pane.path}`}>
    <header className="topic-explorer-pane-header repo-explorer-pane-header">
      <div>
        <strong>{symbol?.name ?? pane.path.split("/").at(-1)}</strong>
        <span>{pane.path}{symbol ? ` · lines ${symbol.line}–${symbol.end}` : ""}</span>
      </div>
      <button type="button" className="topic-explorer-menu-close" aria-label="Close code" onClick={onClose}>×</button>
    </header>
    <div className="repo-explorer-pane-actions">
      <button type="button" disabled={!canAsk || busy} title={canAsk ? "Uses AI credit" : "AI needs a membership with AI turned on"} onClick={() => onExplain("document")}>Explain in side document</button>
      <button type="button" disabled={!canAsk || busy} title={canAsk ? "Uses AI credit" : "AI needs a membership with AI turned on"} onClick={() => onExplain("note")}>Explain as a note</button>
      {symbol ? <button type="button" onClick={() => onWhole(!pane.whole)}>{pane.whole ? "Just this function" : "Whole file"}</button> : null}
      <a href={githubUrl(graph, pane.path, symbol ? { line: symbol.line, end: symbol.end } : undefined)} target="_blank" rel="noreferrer noopener">GitHub ↗</a>
    </div>
    <div ref={scrollRef} className="topic-explorer-pane-scroll repo-explorer-code message-content is-markdown">
      {error ? <p role="alert">{error}</p> : text === null ? <p>Reading the code from GitHub…</p> : <pre className="repo-explorer-pre"><span className="repo-explorer-gutter" aria-hidden="true">
        {Array.from({ length: count }, (_, offset) => `${range.line + offset}`).join("\n")}
      </span><code className={`hljs${language ? ` language-${language}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} /></pre>}
    </div>
  </aside>;
}

function DocPane({ note, canSave, onSave, onRemove, onClose, onShowCode }: { note: RepoNote; canSave: boolean; onSave(): void; onRemove(): void; onClose(): void; onShowCode?: () => void }) {
  const html = useMemo(() => renderMarkdownToHtml(note.markdown), [note.markdown]);
  const name = note.target.kind === "repo" ? "Architecture" : note.target.name || note.target.path;
  return <aside className="topic-explorer-pane repo-explorer-pane" aria-label={`AI explanation of ${name}`}>
    <header className="topic-explorer-pane-header repo-explorer-pane-header">
      <div><strong>{name}</strong><span>AI explanation{note.question ? ` · “${note.question}”` : ""}</span></div>
      <button type="button" className="topic-explorer-menu-close" aria-label="Close explanation" onClick={onClose}>×</button>
    </header>
    <div className="repo-explorer-pane-actions">
      {canSave ? <button type="button" onClick={onSave}>Save to my map</button> : null}
      {onShowCode ? <button type="button" onClick={onShowCode}>View code</button> : null}
      <button type="button" className="is-quiet" onClick={onRemove}>Remove</button>
    </div>
    <div className="topic-explorer-pane-scroll repo-explorer-doc message-content is-markdown" dangerouslySetInnerHTML={{ __html: html }} />
  </aside>;
}
