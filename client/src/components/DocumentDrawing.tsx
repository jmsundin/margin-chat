import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaptureUpdateAction, convertToExcalidrawElements, Excalidraw, exportToSvg, hashElementsVersion, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { drawingMarkdown, readDrawing } from "../lib/documentDrawing";
import { BOARD_AI_COLOR, boardNotes, boundsOf, nearbyNotes, notesToAnswer, placeBeside, type BoardAIMark, type BoardElementLike, type BoardNote, type BoardNoteRequest } from "../lib/boardAI";
import "@excalidraw/excalidraw/index.css";
import "./DocumentDrawing.css";

Object.assign(window, { EXCALIDRAW_ASSET_PATH: "/excalidraw/" });

export function DrawingDialog({ markdown, error, onSave, onClose }: {
  markdown: string; error?: string; onSave: (markdown: string) => void; onClose: () => void;
}) {
  const initial = useMemo(() => ({ ...readDrawing(markdown), scrollToContent: true }), [markdown]);
  const pending = useRef(markdown);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>(".document-drawing-save")?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<div className="document-drawing-backdrop">
    <div ref={dialogRef} className="document-drawing-dialog" role="dialog" aria-modal="true" aria-label="Edit drawing" onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key !== "Tab") return;
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select, [tabindex="0"]')].filter((item) => item.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header><strong>Drawing</strong><div><button type="button" onClick={onClose}>Cancel</button><button type="button" className="document-drawing-save" onClick={() => onSave(pending.current)}>Save drawing</button></div></header>
      {error && <p role="alert">{error}</p>}
      <div className="document-drawing-canvas"><Excalidraw initialData={initial} handleKeyboardGlobally={false}
        onChange={(elements, appState, files) => { pending.current = drawingMarkdown(serializeAsJSON(elements, appState, files, "local")); }}
        UIOptions={{ canvasActions: { loadScene: true, saveToActiveFile: false, export: false, toggleTheme: true } }}
      /></div>
    </div>
  </div>, document.body);
}

type BoardScene = Parameters<typeof serializeAsJSON>;
const BOARD_SAVE_DELAY_MS = 400;

/** What a save would change: the shapes, the images and the background. Panning and selecting don't count. */
function boardSceneKey(elements: BoardScene[0], appState: Pick<BoardScene[1], "viewBackgroundColor">, files: BoardScene[2]) {
  return `${hashElementsVersion(elements)}:${appState.viewBackgroundColor ?? ""}:${Object.keys(files ?? {}).length}`;
}

const BOARD_AI_DELAY_MS = 900;
const BOARD_AI_SETTING = "margin-chat:board-ai-diagrams";

function readBoardAISetting() {
  try { return window.localStorage.getItem(BOARD_AI_SETTING) !== "off"; } catch { return true; }
}

type BoardAIStatus = { kind: "working"; count: number } | { kind: "error"; text: string; noteId: string } | null;

/**
 * A board document's canvas, full page. Changes are saved into the document's
 * drawing block a moment after they stop, and at once when the board closes or
 * the page is hidden. A newer copy from another device replaces the scene shown.
 *
 * With AI diagrams on, each new note answered draws a flow diagram beside it, in
 * green, as one step Undo removes. The AI never changes the person's shapes.
 */
export function BoardCanvas({ markdown, theme, readOnly = false, onChange, onAskNote }: {
  markdown: string; theme: "light" | "dark"; readOnly?: boolean; onChange: (markdown: string) => void;
  /** Ask the AI about a note; resolves to Mermaid flowchart source. */
  onAskNote?: (request: BoardNoteRequest) => Promise<string>;
}) {
  // Read once per board; later outside changes reach the canvas through updateScene below.
  const [parsed] = useState(() => {
    try { return { scene: readDrawing(markdown) }; }
    catch (error) { return { error: error instanceof Error ? error.message : "The board could not be opened." }; }
  });
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const saved = useRef(markdown);
  const savedKey = useRef<string | null>(null);
  const pending = useRef<BoardScene | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const save = useRef(onChange);
  save.current = onChange;
  const [aiOn, setAIOn] = useState(readBoardAISetting);
  const [aiStatus, setAIStatus] = useState<BoardAIStatus>(null);
  // Notes on the board when it opened (or arrived from another device) are never answered on their own.
  const knownNotes = useRef<Set<string> | null>(null);
  const askedNotes = useRef(new Set<string>());
  const running = useRef(new Set<AbortController>());
  const latest = useRef<{ elements: readonly BoardElementLike[]; editingId: string | null }>({ elements: [], editingId: null });
  const aiTimer = useRef<number | undefined>(undefined);
  const ask = useRef(onAskNote);
  ask.current = onAskNote;
  const aiEnabled = aiOn && Boolean(onAskNote) && !readOnly;
  const aiEnabledRef = useRef(aiEnabled);
  aiEnabledRef.current = aiEnabled;
  const flush = useRef(() => {
    window.clearTimeout(timer.current);
    const scene = pending.current;
    pending.current = null;
    if (!scene) return;
    const next = drawingMarkdown(serializeAsJSON(...scene));
    if (next === saved.current) return;
    saved.current = next;
    save.current(next);
  });
  const answer = useRef(async (note: BoardNote) => {
    const request = ask.current;
    if (!request) return;
    askedNotes.current.add(note.id);
    const controller = new AbortController();
    running.current.add(controller);
    setAIStatus({ kind: "working", count: running.current.size });
    try {
      const source = await request({ note: note.text, nearby: nearbyNotes(latest.current.elements, note), signal: controller.signal });
      // Comes with @excalidraw/excalidraw (its own Mermaid import uses it), loaded only when a note is answered.
      const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
      const diagram = await parseMermaidToExcalidraw(source, { themeVariables: { fontSize: "16px" } });
      const made = convertToExcalidrawElements(diagram.elements, { regenerateIds: true });
      const board = api.current;
      if (!board || controller.signal.aborted || !made.length) return;
      const scene = board.getSceneElementsIncludingDeleted();
      // The note may have moved, or been deleted, while the AI was thinking.
      const current = boardNotes(scene).find((item) => item.id === note.id);
      if (!current) return;
      const box = boundsOf(made);
      const spot = placeBeside(current, box, scene);
      const turn = `board-ai-${crypto.randomUUID()}`;
      const mark: BoardAIMark = { author: "ai", turn, answers: note.id };
      const placed = made.map((element) => ({ ...element, x: element.x + spot.x - box.x, y: element.y + spot.y - box.y,
        strokeColor: BOARD_AI_COLOR, groupIds: [...element.groupIds, turn],
        customData: { ...element.customData, marginChat: mark } }));
      if (diagram.files) board.addFiles(Object.values(diagram.files));
      // Recorded as one step, so a single Undo takes the whole answer away.
      board.updateScene({ elements: [...scene, ...placed], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    } catch (error) {
      if (controller.signal.aborted) return;
      const text = error instanceof Error && error.message ? error.message : "The AI couldn't draw a diagram.";
      running.current.delete(controller);
      setAIStatus({ kind: "error", text, noteId: note.id });
      return;
    } finally {
      running.current.delete(controller);
    }
    setAIStatus((status) => status?.kind === "error" ? status : running.current.size ? { kind: "working", count: running.current.size } : null);
  });
  const check = useRef(() => {
    window.clearTimeout(aiTimer.current);
    if (!aiEnabledRef.current || !knownNotes.current) return;
    const { elements, editingId } = latest.current;
    for (const note of notesToAnswer(elements, { known: knownNotes.current, editingId, asked: askedNotes.current })) void answer.current(note);
  });
  useEffect(() => {
    const hide = () => { if (document.visibilityState === "hidden") flush.current(); };
    const leave = () => flush.current();
    const controllers = running.current;
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", leave);
      window.clearTimeout(aiTimer.current);
      for (const controller of controllers) controller.abort();
      flush.current();
    };
  }, []);
  useEffect(() => {
    if (markdown === saved.current) return;
    // Another device, or an undo in the document's text, changed the scene: show that one.
    saved.current = markdown;
    savedKey.current = null;
    pending.current = null;
    window.clearTimeout(timer.current);
    let scene: ExcalidrawInitialDataState;
    try { scene = readDrawing(markdown); } catch { return; }
    // Notes written on another device were answered there, if at all.
    for (const note of boardNotes((scene.elements ?? []) as readonly BoardElementLike[])) knownNotes.current?.add(note.id);
    if (scene.files) api.current?.addFiles(Object.values(scene.files));
    api.current?.updateScene({ elements: scene.elements ?? [] });
  }, [markdown]);
  function toggleAI() {
    const next = !aiOn;
    setAIOn(next);
    try { window.localStorage.setItem(BOARD_AI_SETTING, next ? "on" : "off"); } catch { /* the choice lasts this visit */ }
    if (!next) { for (const controller of running.current) controller.abort(); running.current.clear(); setAIStatus(null); }
  }
  if ("error" in parsed) return <div className="document-board is-broken" role="alert"><p>{parsed.error}</p>
    <p>Turn off Board in the document menu to see and fix the drawing's source.</p></div>;
  return <div className="document-board" aria-label="Board">
    <Excalidraw initialData={{ ...parsed.scene, scrollToContent: true }} theme={theme} viewModeEnabled={readOnly}
      excalidrawAPI={(value) => { api.current = value; }} handleKeyboardGlobally={false}
      renderTopRightUI={onAskNote && !readOnly ? () => <button type="button" className="board-ai-toggle" aria-pressed={aiOn} onClick={toggleAI}
        title={aiOn ? "On: the AI answers each new note with a flow diagram beside it. Click to turn off." : "Off: notes stay yours alone. Click to have the AI answer new notes with a flow diagram."}>
        <span className="board-ai-dot" aria-hidden="true" />AI diagrams {aiOn ? "on" : "off"}
      </button> : undefined}
      onChange={(elements, appState, files) => {
        if (knownNotes.current === null) knownNotes.current = new Set(boardNotes(elements).map((note) => note.id));
        latest.current = { elements, editingId: appState.editingTextElement?.id ?? null };
        if (aiEnabledRef.current) { window.clearTimeout(aiTimer.current); aiTimer.current = window.setTimeout(() => check.current(), BOARD_AI_DELAY_MS); }
        const key = boardSceneKey(elements, appState, files);
        // The first call reports the scene as opened (or as replaced from outside): nothing to save.
        if (savedKey.current === null) { savedKey.current = key; return; }
        if (readOnly || key === savedKey.current) return;
        savedKey.current = key;
        pending.current = [elements, appState, files, "local"];
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => flush.current(), BOARD_SAVE_DELAY_MS);
      }}
      UIOptions={{ canvasActions: { loadScene: true, saveToActiveFile: false, export: false, toggleTheme: false } }}
    />
    {aiStatus ? <div className={`board-ai-status${aiStatus.kind === "error" ? " is-error" : ""}`} role={aiStatus.kind === "error" ? "alert" : "status"}>
      {aiStatus.kind === "working" ? <span>Drawing a diagram for your note…</span> : <>
        <span>{aiStatus.text}</span>
        <button type="button" onClick={() => { askedNotes.current.delete(aiStatus.noteId); setAIStatus(null); check.current(); }}>Try again</button>
        <button type="button" aria-label="Dismiss" onClick={() => setAIStatus(null)}>×</button>
      </>}
    </div> : null}
  </div>;
}

export default function DocumentDrawing({ markdown, readOnly, onEdit }: { markdown: string; readOnly: boolean; onEdit: () => void }) {
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    let active = true;
    let drawing: ExcalidrawInitialDataState;
    setError("");
    try { drawing = readDrawing(markdown); }
    catch (error) { setError(error instanceof Error ? error.message : "The drawing could not be opened."); return; }
    const elements = (drawing.elements ?? []).filter((element) => !element.isDeleted);
    setEmpty(!elements.length);
    if (!elements.length) { setPreview(""); return; }
    void exportToSvg({ elements, appState: { ...drawing.appState, exportBackground: true }, files: drawing.files ?? {} })
      .then((svg: SVGSVGElement) => { if (active) setPreview(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`); })
      .catch(() => { if (active) setError("The drawing preview could not be rendered. Open the drawing to edit it."); });
    return () => { active = false; };
  }, [markdown]);
  return <figure className="document-drawing" aria-label="Excalidraw drawing">
    {preview && !error ? <img src={preview} alt="Document drawing" onDoubleClick={readOnly ? undefined : onEdit} /> : <p>{error || (empty ? "Empty drawing" : "Loading drawing…")}</p>}
    <figcaption><span>Excalidraw</span><button type="button" disabled={readOnly} onClick={onEdit}>Edit drawing</button></figcaption>
  </figure>;
}
