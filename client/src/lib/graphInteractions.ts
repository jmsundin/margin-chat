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
    startMarquee(point: GraphPointer, additive: boolean, initialIds: Iterable<string>) {
      finish(false);
      const start = snapshot(point);
      const startWorld = read().toWorld(start);
      interaction = { kind: "marquee", start, latest: start, startWorld, additive, initialIds: new Set(initialIds) };
      read().onMarquee({ ...startWorld, width: 0, height: 0 });
      if (!additive) read().onSelection(new Set());
    },
    move(point: GraphPointer) {
      if (!interaction || interaction.start.pointerId !== point.pointerId) return false;
      interaction.latest = snapshot(point);
      if (frame === null) {
        frame = scheduler.request(() => {
          frame = null;
          if (interaction) preview(interaction);
        });
      }
      return true;
    },
    end(point: GraphPointer, commit = true) {
      if (!interaction || interaction.start.pointerId !== point.pointerId) return false;
      interaction.latest = snapshot(point);
      return finish(commit);
    },
    cancel: () => finish(false),
    dispose() {
      interaction = null;
      cancelFrame();
    },
  };
}
