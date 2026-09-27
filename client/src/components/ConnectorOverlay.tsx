import type { CSSProperties } from "react";
import type { ConnectionLine, ConnectorNavigationTarget, ConnectorOcclusionRect } from "../types";
import { buildConnectorCurve, CONNECTOR_MARKER_SIZE, groupConnectorContinuations } from "../lib/documentConnectors";
import "./ConnectorOverlay.css";

interface ConnectorOverlayProps {
  connections: ConnectionLine[];
  occlusionRects: ConnectorOcclusionRect[];
  onNavigate?: (target: ConnectorNavigationTarget) => void;
}

const directionArrows = { up: "↑", down: "↓", left: "←", right: "→", open: "↗" };
const directionLabels = { up: "above", down: "below", left: "to the left", right: "to the right", open: "in another document" };

function markerStyle(continuation: Pick<NonNullable<ConnectionLine["continuation"]>, "left" | "top" | "width" | "marginSide">): CSSProperties {
  return {
    left: continuation.left + (continuation.marginSide === "right" ? CONNECTOR_MARKER_SIZE : 0),
    top: continuation.top + (continuation.top > window.innerHeight / 2 ? CONNECTOR_MARKER_SIZE : 0),
    "--connector-detail-width": `${continuation.width}px`,
  } as CSSProperties;
}

function continuationDetail(continuation: NonNullable<ConnectionLine["continuation"]>) {
  return <span className="connector-continuation-detail">
    <span className="connector-continuation-relation">{continuation.relation === "source" ? "From" : "To"} · {directionLabels[continuation.direction]}</span>
    <span className="connector-continuation-title">{continuation.title}</span>
  </span>;
}

export default function ConnectorOverlay({
  connections,
  occlusionRects,
  onNavigate,
}: ConnectorOverlayProps) {
  function renderContinuation(connection: ConnectionLine, inList = false) {
    const continuation = connection.continuation!;
    return <button
      key={connection.id}
      type="button"
      className={`connector-continuation margin-${continuation.marginSide}${continuation.top > window.innerHeight / 2 ? " opens-up" : ""}${connection.active ? " is-active" : ""}${inList ? " is-in-list" : ""}`}
      style={inList ? undefined : markerStyle(continuation)}
      aria-label={`Reveal ${continuation.relation === "source" ? "source" : "linked"} passage: ${continuation.title}, ${directionLabels[continuation.direction]}`}
      title={`${continuation.relation === "source" ? "Source" : "Linked"} passage ${directionLabels[continuation.direction]} · ${continuation.title}. Click to reveal.`}
      onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onNavigate?.(continuation.target); }}
    >
      <span className="connector-continuation-arrow" aria-hidden="true">{directionArrows[continuation.direction]}</span>
      {continuationDetail(continuation)}
    </button>;
  }
  return (
    <>
    <svg
      aria-hidden="true"
      className="connector-overlay"
      viewBox={`0 0 ${window.innerWidth} ${window.innerHeight}`}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="connector-gradient" x1="0%" x2="100%">
          <stop offset="0%" stopColor="var(--connector-start)" />
          <stop offset="100%" stopColor="var(--connector-end)" />
        </linearGradient>
        <mask id="connector-visibility-mask">
          <rect
            fill="white"
            height={window.innerHeight}
            width={window.innerWidth}
            x={0}
            y={0}
          />
          {occlusionRects.map((rect) => (
            <rect
              key={rect.id}
              fill="black"
              height={rect.height}
              rx={rect.radius ?? 0}
              ry={rect.radius ?? 0}
              width={rect.width}
              x={rect.x}
              y={rect.y}
            />
          ))}
        </mask>
      </defs>
      <g mask="url(#connector-visibility-mask)">
        {connections.filter((connection) => !connection.continuation).map((connection) => {
          const path =
            connection.variant === "straight"
              ? `M ${connection.start.x} ${connection.start.y} L ${connection.end.x} ${connection.end.y}`
              : buildConnectorCurve(connection);

          return (
            <g key={connection.id}>
              <path
                className={
                  connection.active
                    ? "connector-path is-active"
                    : "connector-path"
                }
                d={path}
              />
              <circle
                className={
                  connection.active
                    ? "connector-node is-active"
                    : "connector-node"
                }
                cx={connection.start.x}
                cy={connection.start.y}
                r={4}
              />
              <circle
                className={
                  connection.active
                    ? "connector-node is-active"
                    : "connector-node"
                }
                cx={connection.end.x}
                cy={connection.end.y}
                r={4}
              />
            </g>
          );
        })}
      </g>
    </svg>
    <div className="connector-continuations" aria-label="Document relationships">
      {groupConnectorContinuations(connections).map((group) => {
        const first = group.connections[0];
        const continuation = first.continuation!;
        if (group.connections.length === 1) return renderContinuation(first);
        return <details
          className={`connector-continuation-group margin-${group.marginSide}${group.top > window.innerHeight / 2 ? " opens-up" : ""}`}
          key={first.id}
          style={markerStyle(group)}
          onMouseEnter={(event) => event.currentTarget.setAttribute("open", "")}
          onMouseLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) event.currentTarget.removeAttribute("open"); }}
          onFocus={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.setAttribute("open", ""); }}
          onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.removeAttribute("open"); event.currentTarget.querySelector("summary")?.focus(); } }}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.removeAttribute("open"); }}
        >
          <summary className={`connector-continuation${group.connections.some((connection) => connection.active) ? " is-active" : ""}`} aria-label={`Show ${group.connections.length} document relationships`}
            onClick={(event) => { event.preventDefault(); event.currentTarget.parentElement?.setAttribute("open", ""); }}>
            <span className="connector-continuation-arrow" aria-hidden="true">{directionArrows[continuation.direction]}</span>
            {continuationDetail(continuation)}
            <span className="connector-continuation-count">{group.connections.length}</span>
          </summary>
          <div className="connector-continuation-list">{group.connections.map((connection) => renderContinuation(connection, true))}</div>
        </details>;
      })}
    </div>
    </>
  );
}
