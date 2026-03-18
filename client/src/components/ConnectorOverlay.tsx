import type { ConnectionLine, ConnectorOcclusionRect } from "../types";

interface ConnectorOverlayProps {
  connections: ConnectionLine[];
  occlusionRects: ConnectorOcclusionRect[];
}

function buildCurvePath(connection: ConnectionLine) {
  const horizontalGap = connection.end.x - connection.start.x;

  if (horizontalGap <= 24) {
    return `M ${connection.start.x} ${connection.start.y} L ${connection.end.x} ${connection.end.y}`;
  }

  const controlOffset = Math.min(
    horizontalGap - 12,
    Math.max(48, horizontalGap * 0.35),
  );

  return `M ${connection.start.x} ${connection.start.y} C ${
    connection.start.x + controlOffset
  } ${connection.start.y}, ${connection.end.x - controlOffset} ${
    connection.end.y
  }, ${connection.end.x} ${connection.end.y}`;
}

export default function ConnectorOverlay({
  connections,
  occlusionRects,
}: ConnectorOverlayProps) {
  return (
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
        {connections.map((connection) => {
          const path =
            connection.variant === "straight"
              ? `M ${connection.start.x} ${connection.start.y} L ${connection.end.x} ${connection.end.y}`
              : buildCurvePath(connection);

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
  );
}
