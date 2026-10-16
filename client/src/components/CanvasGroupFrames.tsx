import type { CSSProperties } from "react";
import type { CanvasGroupFrame } from "../lib/canvasGroupFrames";
import { getMapTerritoryScreenBounds, type MapNodeFootprint } from "../lib/graphPresentation";
import type { GraphViewport } from "../lib/graphInteractions";

const NAME_ROOM_TRIM = 26;
const FRAME_PADDING = 22;

/** Canvas draws each of your groups as a frame around its cards, at every zoom. */
export default function CanvasGroupFrames({ frames, viewport, nodeFootprint, selectedNodeId, onOpen }: {
  frames: CanvasGroupFrame[];
  viewport: GraphViewport;
  nodeFootprint?: MapNodeFootprint;
  selectedNodeId?: string | null;
  onOpen: (frame: CanvasGroupFrame) => void;
}) {
  return <div className="canvas-group-frames" aria-label="Your groups">
    {frames.map((frame) => {
      const room = getMapTerritoryScreenBounds(frame, viewport, selectedNodeId, nodeFootprint);
      // The name straddles the top edge, so a frame needs less room above its cards than a map region does.
      // Zoomed out, cards sit closer on screen, so frames hug them tighter instead of overlapping each other.
      const inset = FRAME_PADDING * (1 - Math.min(1, Math.max(0.35, viewport.scale / 0.8)));
      const bounds = { x: room.x + inset, y: room.y + NAME_ROOM_TRIM + inset * 2,
        width: room.width - inset * 2, height: room.height - NAME_ROOM_TRIM - inset * 3 };
      const count = `${frame.nodes.length} ${frame.nodes.length === 1 ? "document" : "documents"}`;
      return <div key={frame.id} className={`canvas-group-frame is-${frame.kind}`} data-group-id={frame.id}
        style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, "--group-color": frame.color } as CSSProperties}>
        <button type="button" data-graph-ui="true" className="canvas-group-frame-tab"
          aria-label={`Zoom to ${frame.label}, ${count}`} title={`Zoom to ${frame.label}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onOpen(frame); }}>
          <strong>{frame.label}</strong><span>{count}</span>
        </button>
      </div>;
    })}
  </div>;
}
