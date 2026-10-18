import type { CSSProperties } from "react";
import type { CanvasGroupBox } from "../lib/canvasGroupBoxes";
import type { GraphViewport } from "../lib/graphInteractions";

/**
 * Canvas draws each of your groups as a box that owns its space. Zoomed out too far to read the
 * cards, a box is just its colored space with its name and count, and the cards are hidden.
 */
export default function CanvasGroupBoxes({ boxes, viewport, collapsed, onOpen }: {
  boxes: CanvasGroupBox[];
  viewport: GraphViewport;
  collapsed: boolean;
  onOpen: (box: CanvasGroupBox) => void;
}) {
  return <div className={`canvas-group-boxes${collapsed ? " is-collapsed" : ""}`} aria-label="Your groups">
    {boxes.map((box) => {
      const count = `${box.conversationIds.length} ${box.conversationIds.length === 1 ? "document" : "documents"}`;
      return <div key={box.id} className={`canvas-group-box is-${box.kind}`} data-group-id={box.id}
        style={{ left: viewport.x + box.x * viewport.scale, top: viewport.y + box.y * viewport.scale,
          width: box.width * viewport.scale, height: box.height * viewport.scale, "--group-color": box.color } as CSSProperties}>
        <button type="button" data-graph-ui="true" className="canvas-group-box-name"
          aria-label={`Zoom to ${box.label}, ${count}`} title={`Zoom to ${box.label}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onOpen(box); }}>
          <strong>{box.label}</strong>{collapsed && box.height * viewport.scale < 46 ? null : <span>{count}</span>}
        </button>
      </div>;
    })}
  </div>;
}
