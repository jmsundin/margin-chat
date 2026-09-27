import { useEffect, useId, useRef, useState, type HTMLAttributes } from "react";
import "./MarginDocumentFrame.css";

export type MarginDocumentSize = { width: number; height: number };
const DEFAULT_SIZE = { width: 280, height: 380 };
const MIN_SIZE = { width: 220, height: 180 };
const MAX_SIZE = { width: 640, height: 1000 };

export function getMarginDocumentSize(size?: MarginDocumentSize): MarginDocumentSize {
  return {
    width: Math.round(Math.max(MIN_SIZE.width, Math.min(MAX_SIZE.width, Number.isFinite(size?.width) ? size!.width : DEFAULT_SIZE.width))),
    height: Math.round(Math.max(MIN_SIZE.height, Math.min(MAX_SIZE.height, Number.isFinite(size?.height) ? size!.height : DEFAULT_SIZE.height))),
  };
}

type Props = Omit<HTMLAttributes<HTMLDivElement>, "onResize"> & {
  size?: MarginDocumentSize;
  label?: string;
  onResize: (size: MarginDocumentSize) => void;
  onResizePreview?: (size: MarginDocumentSize | null) => void;
};

export default function MarginDocumentFrame({ size, label = "margin note", onResize, onResizePreview, className = "", style, children, ...props }: Props) {
  const instructionsId = useId();
  const [preview, setPreview] = useState<MarginDocumentSize | null>(null);
  const renderedSize = preview ?? getMarginDocumentSize(size);
  const callbacks = useRef({ onResize, onResizePreview });
  callbacks.current = { onResize, onResizePreview };
  const drag = useRef<{
    pointerId: number; x: number; y: number; start: MarginDocumentSize; next: MarginDocumentSize;
    element: HTMLButtonElement; cursor: string; userSelect: string;
  } | null>(null);

  useEffect(() => {
    const finish = (commit: boolean) => {
      const current = drag.current;
      if (!current) return;
      drag.current = null;
      if (current.element.hasPointerCapture?.(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
      document.body.style.cursor = current.cursor;
      document.body.style.userSelect = current.userSelect;
      if (commit && (current.next.width !== current.start.width || current.next.height !== current.start.height)) callbacks.current.onResize(current.next);
      callbacks.current.onResizePreview?.(null);
      setPreview(null);
    };
    const move = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      event.preventDefault();
      current.next = getMarginDocumentSize({ width: current.start.width + event.clientX - current.x, height: current.start.height + event.clientY - current.y });
      setPreview(current.next);
      callbacks.current.onResizePreview?.(current.next);
    };
    const end = (event: PointerEvent) => { if (event.pointerId === drag.current?.pointerId) finish(true); };
    const cancel = (event: PointerEvent) => { if (event.pointerId === drag.current?.pointerId) finish(false); };
    const blur = () => finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", blur);
      finish(false);
    };
  }, []);

  return <div {...props} className={`margin-document margin-document-frame${preview ? " is-resizing" : ""}${className ? ` ${className}` : ""}`} style={{ ...style, width: renderedSize.width, height: renderedSize.height, maxHeight: "none" }}>
    {children}
    <button type="button" className="margin-document-resize" aria-label={`Resize ${label}`} aria-describedby={instructionsId}
      title="Drag to resize. Use arrow keys for width and height, Shift for larger steps. Double-click to reset."
      onPointerDown={(event) => {
        if (event.button !== 0 || event.isPrimary === false || drag.current) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: renderedSize, next: renderedSize, element: event.currentTarget, cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
        document.body.style.cursor = "nwse-resize";
        document.body.style.userSelect = "none";
        setPreview(renderedSize);
      }}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 80 : 20;
        const next = event.key === "Home" ? MIN_SIZE : event.key === "End" ? MAX_SIZE : {
          width: renderedSize.width + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
          height: renderedSize.height + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0),
        };
        onResize(getMarginDocumentSize(next));
      }}
      onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); onResize({ ...DEFAULT_SIZE }); }}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 13 13 5M10 13l3-3" /></svg>
    </button>
    <span id={instructionsId} className="margin-document-resize-instructions">{renderedSize.width} pixels wide, {renderedSize.height} pixels tall. Drag or use arrow keys to resize. Hold Shift for larger steps. Home sets the minimum size; End sets the maximum.</span>
  </div>;
}
