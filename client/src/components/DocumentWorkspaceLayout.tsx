import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { DocumentDockPosition } from "../types";

interface DocumentWorkspaceLayoutProps {
  dock: ReactNode;
  width: number;
  position?: DocumentDockPosition;
  onWidthChange: (width: number) => void;
  children: ReactNode;
}

const clampWidth = (value: number) => Math.max(0.2, Math.min(0.75, value));

/** The dock is a sibling of the horizontal canvas, so scrolling cannot move it. */
export default function DocumentWorkspaceLayout({ dock, width, position = "left", onWidthChange, children }: DocumentWorkspaceLayoutProps) {
  const layoutRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<(() => void) | null>(null);
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  const [stacked, setStacked] = useState(false);
  const reversed = position === "right" || position === "bottom";

  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    const measure = () => setStacked(window.getComputedStyle(layout).flexDirection.startsWith("column"));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    return () => { observer.disconnect(); dragRef.current?.(); };
  }, [position]);

  useEffect(() => { if (!dock) dragRef.current?.(); }, [Boolean(dock)]);

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.isPrimary === false || dragRef.current) return;
    const layout = layoutRef.current;
    if (!layout) return;
    const bounds = layout.getBoundingClientRect();
    const size = stacked ? bounds.height : bounds.width;
    if (!size) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    const origin = stacked ? event.clientY : event.clientX;
    let nextWidth = width;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = stacked ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    try { handle.setPointerCapture(pointerId); } catch { /* Window listeners also cover synthetic pointers. */ }
    function move(pointer: PointerEvent) {
      if (pointer.pointerId !== pointerId) return;
      pointer.preventDefault();
      nextWidth = clampWidth(width + (reversed ? -1 : 1) * ((stacked ? pointer.clientY : pointer.clientX) - origin) / size);
      setDraftWidth(nextWidth);
    }
    function cleanup() {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", abort);
      window.removeEventListener("keydown", escape);
      handle.removeEventListener("lostpointercapture", abort);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setDraftWidth(null);
    }
    function finish(pointer: PointerEvent) {
      if (pointer.pointerId !== pointerId) return;
      move(pointer);
      cleanup();
      onWidthChange(nextWidth);
    }
    function abort() { cleanup(); }
    function cancel(pointer: PointerEvent) { if (pointer.pointerId === pointerId) abort(); }
    function escape(key: KeyboardEvent) { if (key.key === "Escape") { key.preventDefault(); abort(); } }
    dragRef.current = abort;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", abort);
    window.addEventListener("keydown", escape);
    handle.addEventListener("lostpointercapture", abort);
  }

  const ratio = draftWidth ?? width;
  return <div ref={layoutRef} className={`document-workspace-layout dock-position-${position}${dock ? " has-pinned-documents" : ""}${draftWidth !== null ? " is-resizing-dock" : ""}`}
    style={{ "--document-dock-size": `${ratio * 100}%` } as CSSProperties}>
    {dock ? <>
      <div className="document-workspace-dock">{dock}</div>
      <div className="document-dock-boundary" role="separator" tabIndex={0}
        aria-label="Resize pinned document area" aria-orientation={stacked ? "horizontal" : "vertical"}
        aria-valuemin={20} aria-valuemax={75} aria-valuenow={Math.round(ratio * 100)}
        aria-valuetext={`${Math.round(ratio * 100)} percent of the workspace`}
        title="Drag to resize pinned area. Double-click to reset."
        onPointerDown={startResize} onDoubleClick={() => onWidthChange(0.4)}
        onKeyDown={(event) => {
          const decrease = stacked ? (reversed ? "ArrowDown" : "ArrowUp") : (reversed ? "ArrowRight" : "ArrowLeft");
          const increase = stacked ? (reversed ? "ArrowUp" : "ArrowDown") : (reversed ? "ArrowLeft" : "ArrowRight");
          if (![decrease, increase, "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          onWidthChange(event.key === "Home" ? 0.2 : event.key === "End" ? 0.75
            : clampWidth(width + (event.key === decrease ? -1 : 1) * (event.shiftKey ? 0.1 : 0.03)));
        }}><span /></div>
    </> : null}
    <div className="document-workspace-scrolling">{children}</div>
  </div>;
}
