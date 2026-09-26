import type { ConnectionLine, ConnectorNavigationTarget, ConnectorOcclusionRect } from "../types";

export interface ConnectorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DocumentConnectorEndpoint {
  title: string;
  target: ConnectorNavigationTarget;
  panel: ConnectorRect | null;
  viewport: ConnectorRect | null;
  anchor: ConnectorRect | null;
}

export function intersectConnectorRects(...rects: ConnectorRect[]): ConnectorRect | null {
  if (!rects.length) return null;
  const result = {
    left: Math.max(...rects.map((rect) => rect.left)),
    top: Math.max(...rects.map((rect) => rect.top)),
    right: Math.min(...rects.map((rect) => rect.right)),
    bottom: Math.min(...rects.map((rect) => rect.bottom)),
  };
  return result.right > result.left && result.bottom > result.top ? result : null;
}

export function buildConnectorOcclusions(workspace: ConnectorRect, docks: ConnectorRect[], width: number, height: number): ConnectorOcclusionRect[] {
  const rects = [
    { id: "workspace-top", x: 0, y: 0, width, height: workspace.top },
    { id: "workspace-bottom", x: 0, y: workspace.bottom, width, height: height - workspace.bottom },
    { id: "workspace-left", x: 0, y: workspace.top, width: workspace.left, height: workspace.bottom - workspace.top },
    { id: "workspace-right", x: workspace.right, y: workspace.top, width: width - workspace.right, height: workspace.bottom - workspace.top },
    ...docks.map((dock, index) => ({ id: `pinned-dock-${index}`, x: dock.left, y: dock.top, width: dock.right - dock.left, height: dock.bottom - dock.top })),
  ];
  return rects.filter((rect) => rect.width > 0 && rect.height > 0);
}

function center(rect: ConnectorRect) {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

function visibleAnchor(endpoint: DocumentConnectorEndpoint) {
  return endpoint.anchor && endpoint.viewport && endpoint.panel
    ? intersectConnectorRects(endpoint.anchor, endpoint.viewport, endpoint.panel) : null;
}

function getHiddenDirection(hidden: DocumentConnectorEndpoint, visible: DocumentConnectorEndpoint) {
  // A missing panel means the document is minimized or in another family.
  if (!hidden.panel) return "open" as const;
  const anchor = hidden.anchor ?? hidden.panel;
  const viewport = hidden.viewport ?? visible.viewport;
  if (!viewport) return "open" as const;
  if (anchor.right <= viewport.left) return "left" as const;
  if (anchor.left >= viewport.right) return "right" as const;
  if (anchor.bottom <= viewport.top) return "up" as const;
  if (anchor.top >= viewport.bottom) return "down" as const;
  return "open" as const;
}

/** Only draw a curve when both passages are visible in their own scrollports. */
export function buildDocumentConnector({ id, source, target, active }: {
  id: string;
  source: DocumentConnectorEndpoint;
  target: DocumentConnectorEndpoint;
  active: boolean;
}): ConnectionLine | null {
  const sourceAnchor = visibleAnchor(source);
  const targetAnchor = visibleAnchor(target);
  if (!sourceAnchor && !targetAnchor) return null;

  if (!sourceAnchor || !targetAnchor) {
    const visible = sourceAnchor ? source : target;
    const hidden = sourceAnchor ? target : source;
    const anchor = sourceAnchor ?? targetAnchor!;
    const bounds = intersectConnectorRects(visible.panel!, visible.viewport!)!;
    // The label belongs to the visible passage, so it remains inside that pane.
    const width = Math.min(208, bounds.right - bounds.left - 16);
    if (width < 80 || bounds.bottom - bounds.top < 32) return null;
    const top = Math.max(bounds.top + 4, Math.min(center(anchor).y - 32, bounds.bottom - 30));
    const left = Math.max(bounds.left + 8, bounds.right - width - 8);
    return {
      id, active, start: center(anchor), end: center(anchor),
      continuation: {
        title: hidden.title,
        direction: getHiddenDirection(hidden, visible),
        relation: sourceAnchor ? "target" : "source",
        target: hidden.target,
        left, top, width,
      },
    };
  }

  const sourcePanel = source.panel!;
  const targetPanel = target.panel!;
  // Within one document, the passage highlight already exposes the relationship.
  // A curve across that same editor would obscure its content.
  if (source.target.conversationId === target.target.conversationId) return null;
  const start = center(sourceAnchor);
  const end = center(targetAnchor);
  if (sourcePanel.bottom <= targetPanel.top || targetPanel.bottom <= sourcePanel.top) {
    const downward = center(sourcePanel).y < center(targetPanel).y;
    start.y = downward ? sourcePanel.bottom : sourcePanel.top;
    end.y = downward ? targetPanel.top : targetPanel.bottom;
  } else {
    const rightward = center(sourcePanel).x < center(targetPanel).x;
    start.x = rightward ? sourcePanel.right : sourcePanel.left;
    end.x = rightward ? targetPanel.left : targetPanel.right;
  }
  return { id, start, end, active, variant: "curve" };
}

export function groupConnectorContinuations(connections: ConnectionLine[]) {
  const groups: { connections: ConnectionLine[]; left: number; top: number; width: number }[] = [];
  for (const connection of connections) {
    const label = connection.continuation;
    if (!label) continue;
    const group = groups.find((candidate) =>
      candidate.left < label.left + label.width && candidate.left + candidate.width > label.left && Math.abs(candidate.top - label.top) < 32);
    if (group) group.connections.push(connection);
    else groups.push({ connections: [connection], left: label.left, top: label.top, width: label.width });
  }
  return groups;
}

export function buildConnectorCurve(connection: Pick<ConnectionLine, "start" | "end">) {
  const { start, end } = connection;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
  // Control points follow the facing edges, including reordered/right-hand docks.
  const horizontal = Math.abs(dx) >= 24;
  const distance = horizontal ? dx : dy;
  const offset = Math.sign(distance) * Math.min(Math.abs(distance) * 0.5, 96);
  return horizontal
    ? `M ${start.x} ${start.y} C ${start.x + offset} ${start.y}, ${end.x - offset} ${end.y}, ${end.x} ${end.y}`
    : `M ${start.x} ${start.y} C ${start.x} ${start.y + offset}, ${end.x} ${end.y - offset}, ${end.x} ${end.y}`;
}
