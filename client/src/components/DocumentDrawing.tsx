import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Excalidraw, exportToSvg, hashElementsVersion, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { drawingMarkdown, readDrawing } from "../lib/documentDrawing";
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

/**
 * A board document's canvas, full page. Changes are saved into the document's
 * drawing block a moment after they stop, and at once when the board closes or
 * the page is hidden. A newer copy from another device replaces the scene shown.
 */
export function BoardCanvas({ markdown, theme, readOnly = false, onChange }: {
  markdown: string; theme: "light" | "dark"; readOnly?: boolean; onChange: (markdown: string) => void;
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
  useEffect(() => {
    const hide = () => { if (document.visibilityState === "hidden") flush.current(); };
    const leave = () => flush.current();
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    return () => { document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", leave); flush.current(); };
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
    if (scene.files) api.current?.addFiles(Object.values(scene.files));
    api.current?.updateScene({ elements: scene.elements ?? [] });
  }, [markdown]);
  if ("error" in parsed) return <div className="document-board is-broken" role="alert"><p>{parsed.error}</p>
    <p>Turn off Board in the document menu to see and fix the drawing's source.</p></div>;
  return <div className="document-board" aria-label="Board">
    <Excalidraw initialData={{ ...parsed.scene, scrollToContent: true }} theme={theme} viewModeEnabled={readOnly}
      excalidrawAPI={(value) => { api.current = value; }} handleKeyboardGlobally={false}
      onChange={(elements, appState, files) => {
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
