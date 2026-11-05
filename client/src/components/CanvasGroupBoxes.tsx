import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import type { CanvasGroupBox } from "../lib/canvasGroupBoxes";
import type { GraphViewport } from "../lib/graphInteractions";

const countOf = (box: CanvasGroupBox) => `${box.conversationIds.length} ${box.conversationIds.length === 1 ? "document" : "documents"}`;

/**
 * Zoomed out, each box's name sits in its middle at full length, wrapping onto more lines when the
 * box is narrow and spilling past its edge only when one word is wider than the box, so names never
 * get cut off. Bigger boxes are named first; a name that would cover one
 * already shown is left off (the box still says it on hover and to screen readers).
 */
export function planCollapsedLabels(boxes: CanvasGroupBox[], viewport: GraphViewport) {
  type Rect = { x: number; y: number; width: number; height: number };
  const placed: Rect[] = [];
  const plan = new Map<string, { fontSize: number; width: number; showCount: boolean } | null>();
  const ordered = [...boxes].sort((a, b) => b.conversationIds.length - a.conversationIds.length || b.width * b.height - a.width * a.height);
  for (const box of ordered) {
    const screenWidth = box.width * viewport.scale, screenHeight = box.height * viewport.scale;
    const fontSize = Math.round(Math.min(24, Math.max(13, Math.min(screenHeight * 0.24, screenWidth * 0.12))));
    const showCount = screenHeight >= 46;
    // A long name wraps onto more lines inside its box before it spills over the edge;
    // only a single word wider than the box makes the label wider than the box.
    const charWidth = fontSize * 0.58;
    const textWidth = box.label.length * charWidth;
    const longestWord = Math.max(...box.label.split(/\s+/).map((word) => word.length)) * charWidth;
    const room = Math.max(64, screenWidth - 12, longestWord);
    const countWidth = showCount ? countOf(box).length * 6.8 : 0;
    const width = Math.ceil(Math.min(Math.max(textWidth, countWidth), Math.max(room, countWidth)) + 20);
    const lines = Math.ceil(textWidth / Math.max(1, width - 20));
    const height = lines * fontSize * 1.25 + (showCount ? 18 : 0) + 8;
    const centerX = viewport.x + (box.x + box.width / 2) * viewport.scale, centerY = viewport.y + (box.y + box.height / 2) * viewport.scale;
    const rect = { x: centerX - width / 2, y: centerY - height / 2, width, height };
    const clash = placed.some((other) => rect.x < other.x + other.width && other.x < rect.x + rect.width && rect.y < other.y + other.height && other.y < rect.y + rect.height);
    plan.set(box.id, clash ? null : { fontSize, width, showCount });
    if (!clash) placed.push(rect);
  }
  return plan;
}

/** Where a box sits on screen for a camera. */
function boxFrame(box: CanvasGroupBox, viewport: GraphViewport) {
  return { left: viewport.x + box.x * viewport.scale, top: viewport.y + box.y * viewport.scale,
    width: box.width * viewport.scale, height: box.height * viewport.scale };
}

/**
 * The Map draws each topic, or each of your groups, as a box that owns its space. Zoomed out too far
 * to read the cards, a box is just its colored space with its name and count, and the cards are hidden.
 *
 * While you pan or zoom by hand, the map moves its cards outside React every frame and tells React
 * only now and then. The boxes follow the same camera through `subscribeCamera`, so they move with
 * the cards instead of jumping to catch up each time React hears where the camera is.
 */
export default function CanvasGroupBoxes({ boxes, viewport, collapsed, onOpen, subscribeCamera, liveCamera }: {
  boxes: CanvasGroupBox[];
  viewport: GraphViewport;
  /** The camera right now; a render that React commits late must not put the boxes back where the camera was. */
  liveCamera?: () => GraphViewport;
  collapsed: boolean;
  onOpen: (box: CanvasGroupBox) => void;
  subscribeCamera?: (listener: (viewport: GraphViewport) => void) => () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef(viewport);
  const propsRef = useRef({ boxes, collapsed });
  propsRef.current = { boxes, collapsed };
  /** What the boxes were last laid out for, one by one. */
  const placedRef = useRef<{ camera: GraphViewport; boxes: CanvasGroupBox[]; collapsed: boolean; width: number; height: number } | null>(null);
  /**
   * Moves the boxes, and sizes or hides the zoomed-out names, for this camera. A pan at the same zoom
   * moves every box by the same amount, so it moves them all at once with one transform on the host;
   * only a zoom, new boxes, or a pan further than a screen lays them out one by one again. Boxes more
   * than a screen away are left out of the page until then.
   */
  const place = useCallback((camera: GraphViewport) => {
    cameraRef.current = camera;
    const host = hostRef.current;
    if (!host) return;
    const { boxes: current, collapsed: isCollapsed } = propsRef.current;
    const placed = placedRef.current;
    // The pan uses the screen size measured at the last layout: reading it again would make the
    // browser lay out the page in the middle of every frame.
    if (placed && placed.width > 0 && placed.height > 0 && placed.boxes === current && placed.collapsed === isCollapsed && placed.camera.scale === camera.scale) {
      const dx = camera.x - placed.camera.x, dy = camera.y - placed.camera.y;
      if (Math.abs(dx) < placed.width && Math.abs(dy) < placed.height) {
        host.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : "";
        return;
      }
    }
    const screenWidth = host.clientWidth, screenHeight = host.clientHeight, measured = screenWidth > 0 && screenHeight > 0;
    host.style.transform = "";
    placedRef.current = { camera, boxes: current, collapsed: isCollapsed, width: screenWidth, height: screenHeight };
    const labels = isCollapsed ? planCollapsedLabels(current, camera) : null;
    const elements = host.children;
    current.forEach((box, index) => {
      const element = elements[index] as HTMLElement | undefined;
      if (!element) return;
      const frame = boxFrame(box, camera);
      const offscreen = measured && (frame.left > 2 * screenWidth || frame.left + frame.width < -screenWidth
        || frame.top > 2 * screenHeight || frame.top + frame.height < -screenHeight);
      element.style.display = offscreen ? "none" : "";
      if (offscreen) return;
      element.style.left = `${frame.left}px`; element.style.top = `${frame.top}px`;
      element.style.width = `${frame.width}px`; element.style.height = `${frame.height}px`;
      const name = element.firstElementChild as HTMLElement | null;
      if (!name) return;
      const label = labels?.get(box.id);
      name.classList.toggle("is-unlabeled", !!labels && !label);
      name.classList.toggle("hides-count", !!label && !label.showCount);
      if (label) { name.style.setProperty("--label-width", `${label.width}px`); name.style.setProperty("--label-size", `${label.fontSize}px`); }
      else { name.style.removeProperty("--label-width"); name.style.removeProperty("--label-size"); }
    });
  }, []);
  // Every commit re-places the boxes for the camera as it is now, not as it was when React rendered.
  useLayoutEffect(() => {
    // A resized map lays the boxes out afresh for its new size.
    const host = hostRef.current, placed = placedRef.current;
    if (host && placed && (host.clientWidth !== placed.width || host.clientHeight !== placed.height)) placedRef.current = null;
    place(liveCamera?.() ?? viewport);
  });
  useEffect(() => subscribeCamera?.(place), [subscribeCamera, place]);
  return <div ref={hostRef} className={`canvas-group-boxes${collapsed ? " is-collapsed" : ""}`} aria-label="Map boxes">
    {boxes.map((box) => {
      const count = countOf(box);
      return <div key={box.id} className={`canvas-group-box is-${box.kind}`} data-group-id={box.id} title={collapsed ? `${box.label} · ${count}` : undefined}
        style={{ "--group-color": box.color } as CSSProperties}>
        <button type="button" data-graph-ui="true" className="canvas-group-box-name"
          aria-label={`Zoom to ${box.label}, ${count}`} title={`Zoom to ${box.label}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onOpen(box); }}>
          <strong>{box.label}</strong><span>{count}</span>
        </button>
      </div>;
    })}
  </div>;
}
