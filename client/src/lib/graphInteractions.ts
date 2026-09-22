import type { ConversationGraphNodePlacement } from "./conversationGraph";

export type GraphViewport = { scale: number; x: number; y: number };
export type GraphPointer = { pointerId: number; clientX: number; clientY: number };
export type GraphSelectionBounds = { height: number; width: number; x: number; y: number };
export type GraphNodeMove = {
  conversationId: string;
  conversationIds: string[];
  deltaX: number;
  deltaY: number;
};

// Keep the camera's zoom and move only enough to expose the requested content.
export function revealGraphBounds(
  bounds: GraphSelectionBounds,
  viewport: GraphViewport,
  size: { width: number; height: number },
  padding = 24,
): GraphViewport {
  function offset(start: number, length: number, available: number) {
    const end = start + length;
    if (length > available - padding * 2) return padding - start;
    if (start < padding) return padding - start;
    if (end > available - padding) return available - padding - end;
    return 0;
  }
  return {
    ...viewport,
    x: viewport.x + offset(bounds.x * viewport.scale + viewport.x, bounds.width * viewport.scale, size.width),
    y: viewport.y + offset(bounds.y * viewport.scale + viewport.y, bounds.height * viewport.scale, size.height),
  };
}

export function getGraphNodesInSelectionBounds(
  placements: ConversationGraphNodePlacement[],
  bounds: GraphSelectionBounds,
) {
  return placements.filter((placement) =>
    placement.x < bounds.x + bounds.width &&
    placement.x + placement.width > bounds.x &&
    placement.y < bounds.y + bounds.height &&
    placement.y + placement.height > bounds.y,
  ).map((placement) => placement.conversationId);
}

export interface GraphInteractionCallbacks {
  getViewport: () => GraphViewport;
  toWorld: (point: GraphPointer) => { x: number; y: number };
  getSelection: (bounds: GraphSelectionBounds) => Iterable<string>;
  onViewport: (viewport: GraphViewport) => void;
  onPanning: (panning: boolean) => void;
  onNodePreview: (move: GraphNodeMove | null) => void;
  onNodeCommit: (move: GraphNodeMove) => void;
  onMarquee: (bounds: GraphSelectionBounds | null) => void;
  onSelection: (ids: Set<string>) => void;
}

type Interaction = { start: GraphPointer; latest: GraphPointer } & (
  | { kind: "node"; conversationId: string; conversationIds: string[] }
  | { kind: "pan"; origin: GraphViewport }
  | { kind: "pinch"; secondStart: GraphPointer; secondLatest: GraphPointer; origin: GraphViewport; anchor: { x: number; y: number }; minimumScale: number; maximumScale: number }
  | { kind: "marquee"; startWorld: { x: number; y: number }; additive: boolean; initialIds: Set<string> }
);

const snapshot = ({ pointerId, clientX, clientY }: GraphPointer): GraphPointer => ({ pointerId, clientX, clientY });

export function createGraphInteractionController(
  read: () => GraphInteractionCallbacks,
  scheduler: { request: (callback: () => void) => number; cancel: (frame: number) => void },
) {
  let interaction: Interaction | null = null;
  let frame: number | null = null;

  function cancelFrame() {
    if (frame !== null) scheduler.cancel(frame);
    frame = null;
  }

  function nodeMove(current: Extract<Interaction, { kind: "node" }>): GraphNodeMove {
    const scale = Math.max(read().getViewport().scale, 0.001);
    return {
      conversationId: current.conversationId,
      conversationIds: current.conversationIds,
      deltaX: (current.latest.clientX - current.start.clientX) / scale,
      deltaY: (current.latest.clientY - current.start.clientY) / scale,
    };
  }

  function preview(current: Interaction) {
    const callbacks = read();
    if (current.kind === "node") {
      callbacks.onNodePreview(nodeMove(current));
    } else if (current.kind === "pan") {
      callbacks.onViewport({
        ...callbacks.getViewport(),
        x: current.origin.x + current.latest.clientX - current.start.clientX,
        y: current.origin.y + current.latest.clientY - current.start.clientY,
      });
    } else if (current.kind === "pinch") {
      const startDistance = Math.max(1, Math.hypot(current.secondStart.clientX - current.start.clientX, current.secondStart.clientY - current.start.clientY));
      const distance = Math.hypot(current.secondLatest.clientX - current.latest.clientX, current.secondLatest.clientY - current.latest.clientY);
      const scale = Math.min(current.maximumScale, Math.max(current.minimumScale, current.origin.scale * distance / startDistance));
      callbacks.onViewport({
        scale,
        x: current.origin.x + (current.latest.clientX + current.secondLatest.clientX - current.start.clientX - current.secondStart.clientX) / 2 + current.anchor.x * (current.origin.scale - scale),
        y: current.origin.y + (current.latest.clientY + current.secondLatest.clientY - current.start.clientY - current.secondStart.clientY) / 2 + current.anchor.y * (current.origin.scale - scale),
      });
    } else {
      const point = callbacks.toWorld(current.latest);
      const bounds = {
        x: Math.min(point.x, current.startWorld.x),
        y: Math.min(point.y, current.startWorld.y),
        width: Math.abs(point.x - current.startWorld.x),
        height: Math.abs(point.y - current.startWorld.y),
      };
      const ids = new Set(current.additive ? current.initialIds : []);
      for (const id of callbacks.getSelection(bounds)) ids.add(id);
      callbacks.onMarquee(bounds);
      callbacks.onSelection(ids);
    }
  }

  function finish(commit: boolean) {
    const current = interaction;
    if (!current) return false;
    interaction = null;
    cancelFrame();
    const callbacks = read();
    if (current.kind === "node") {
      callbacks.onNodePreview(null);
      if (commit) callbacks.onNodeCommit(nodeMove(current));
    } else if (current.kind === "marquee") {
      if (commit) preview(current);
      else callbacks.onSelection(current.initialIds);
      callbacks.onMarquee(null);
    } else {
      if (commit) preview(current);
      callbacks.onPanning(false);
    }
    return true;
  }

  return {
    isActive: () => interaction !== null,
    startNode(point: GraphPointer, conversationId: string, conversationIds: string[]) {
      finish(false);
      const start = snapshot(point);
      interaction = { kind: "node", start, latest: start, conversationId, conversationIds: [...conversationIds] };
      read().onNodePreview(nodeMove(interaction));
    },
    startPan(point: GraphPointer) {
      finish(false);
      const start = snapshot(point);
      interaction = { kind: "pan", start, latest: start, origin: { ...read().getViewport() } };
      read().onPanning(true);
    },
    startPinch(first: GraphPointer, second: GraphPointer, minimumScale: number, maximumScale: number) {
      finish(false);
      const start = snapshot(first);
      const secondStart = snapshot(second);
      const callbacks = read();
      interaction = {
        kind: "pinch", start, latest: start, secondStart, secondLatest: secondStart,
        origin: { ...callbacks.getViewport() }, minimumScale, maximumScale,
        anchor: callbacks.toWorld({ pointerId: first.pointerId, clientX: (first.clientX + second.clientX) / 2, clientY: (first.clientY + second.clientY) / 2 }),
      };
      callbacks.onPanning(true);
    },
    startMarquee(point: GraphPointer, additive: boolean, initialIds: Iterable<string>) {
      finish(false);
      const start = snapshot(point);
      const startWorld = read().toWorld(start);
      interaction = { kind: "marquee", start, latest: start, startWorld, additive, initialIds: new Set(initialIds) };
      read().onMarquee({ ...startWorld, width: 0, height: 0 });
      if (!additive) read().onSelection(new Set());
    },
    move(point: GraphPointer) {
      if (!interaction) return false;
      if (interaction.start.pointerId === point.pointerId) interaction.latest = snapshot(point);
      else if (interaction.kind === "pinch" && interaction.secondStart.pointerId === point.pointerId) interaction.secondLatest = snapshot(point);
      else return false;
      if (frame === null) {
        frame = scheduler.request(() => {
          frame = null;
          if (interaction) preview(interaction);
        });
      }
      return true;
    },
    end(point: GraphPointer, commit = true) {
      if (!interaction) return false;
      if (interaction.start.pointerId === point.pointerId) interaction.latest = snapshot(point);
      else if (interaction.kind === "pinch" && interaction.secondStart.pointerId === point.pointerId) interaction.secondLatest = snapshot(point);
      else return false;
      return finish(commit);
    },
    cancel: () => finish(false),
    dispose() {
      interaction = null;
      cancelFrame();
    },
  };
}
