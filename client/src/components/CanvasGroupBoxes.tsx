import { useMemo, type CSSProperties } from "react";
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

/**
 * The Map draws each topic, or each of your groups, as a box that owns its space. Zoomed out too far
 * to read the cards, a box is just its colored space with its name and count, and the cards are hidden.
 */
export default function CanvasGroupBoxes({ boxes, viewport, collapsed, onOpen }: {
  boxes: CanvasGroupBox[];
  viewport: GraphViewport;
  collapsed: boolean;
  onOpen: (box: CanvasGroupBox) => void;
}) {
  const labels = useMemo(() => collapsed ? planCollapsedLabels(boxes, viewport) : null, [collapsed, boxes, viewport]);
  return <div className={`canvas-group-boxes${collapsed ? " is-collapsed" : ""}`} aria-label="Map boxes">
    {boxes.map((box) => {
      const count = countOf(box);
      const label = labels?.get(box.id);
      return <div key={box.id} className={`canvas-group-box is-${box.kind}`} data-group-id={box.id} title={collapsed ? `${box.label} · ${count}` : undefined}
        style={{ left: viewport.x + box.x * viewport.scale, top: viewport.y + box.y * viewport.scale,
          width: box.width * viewport.scale, height: box.height * viewport.scale, "--group-color": box.color } as CSSProperties}>
        <button type="button" data-graph-ui="true" className={`canvas-group-box-name${labels && !label ? " is-unlabeled" : ""}`}
          aria-label={`Zoom to ${box.label}, ${count}`} title={`Zoom to ${box.label}`}
          style={label ? { "--label-width": `${label.width}px`, "--label-size": `${label.fontSize}px` } as CSSProperties : undefined}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onOpen(box); }}>
          {labels && !label ? null : <><strong>{box.label}</strong>{label && !label.showCount ? null : <span>{count}</span>}</>}
        </button>
      </div>;
    })}
  </div>;
}
