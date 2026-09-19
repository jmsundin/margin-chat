import { useEffect, useRef, useState, type ReactNode } from "react";
import "./ResizableSidebar.css";

const STORAGE_KEY = "margin-chat-sidebar-width";
const DEFAULT_WIDTH = 272;
const MIN_WIDTH = 220;
const MAX_WIDTH = 480;
const clampWidth = (width: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));

export default function ResizableSidebar({ children, collapsed, mobile, onResizingChange }: {
  children: ReactNode;
  collapsed: boolean;
  mobile: boolean;
  onResizingChange: (resizing: boolean) => void;
}) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY) ?? DEFAULT_WIDTH);
      return Number.isFinite(saved) ? clampWidth(saved) : DEFAULT_WIDTH;
    } catch { return DEFAULT_WIDTH; }
  });
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; x: number; width: number; element: HTMLDivElement; cursor: string; userSelect: string } | null>(null);
  const resizingCallback = useRef(onResizingChange);
  resizingCallback.current = onResizingChange;

  function stopResize() {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    document.body.style.cursor = current.cursor;
    document.body.style.userSelect = current.userSelect;
    setResizing(false);
    resizingCallback.current(false);
  }

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(width)); } catch { /* Keep the current session usable without storage. */ }
  }, [width]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      event.preventDefault();
      setWidth(clampWidth(current.width + event.clientX - current.x));
    };
    const end = (event: PointerEvent) => { if (event.pointerId === drag.current?.pointerId) stopResize(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("lostpointercapture", end);
    window.addEventListener("blur", stopResize);
    window.addEventListener("resize", stopResize);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("lostpointercapture", end);
      window.removeEventListener("blur", stopResize);
      window.removeEventListener("resize", stopResize);
      stopResize();
    };
  }, []);

  useEffect(() => { if (collapsed || mobile) stopResize(); }, [collapsed, mobile]);

  return <div className={`workspace-sidebar-pane${collapsed ? " is-collapsed" : ""}${resizing ? " is-resizing" : ""}`} style={{ width, flexBasis: width }}>
    {children}
    {!collapsed && !mobile ? <div
      aria-label="Resize navigation sidebar"
      aria-orientation="vertical"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      aria-valuenow={Math.round(width)}
      aria-valuetext={`${Math.round(width)} pixels wide`}
      className="sidebar-resize-handle"
      onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        setWidth((current) => event.key === "Home" ? MIN_WIDTH : event.key === "End" ? MAX_WIDTH : clampWidth(current + (event.key === "ArrowRight" ? 24 : -24)));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary || drag.current) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, width, element: event.currentTarget, cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        setResizing(true);
        resizingCallback.current(true);
      }}
      role="separator"
      tabIndex={0}
      title="Drag to resize the sidebar. Double-click to reset."
    ><span /></div> : null}
  </div>;
}
