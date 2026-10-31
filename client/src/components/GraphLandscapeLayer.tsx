import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { GraphViewport } from "../lib/graphInteractions";
import "./GraphLandscapeLayer.css";

export interface LandscapePoint {
  id: string;
  x: number;
  y: number;
  /** Region hue, or null for the neutral color. */
  hue: number | null;
}

export interface LandscapeLabel {
  id: string;
  label: string;
  x: number;
  y: number;
  radius: number;
  count: number;
}

const VERTEX = `#version 300 es
in vec2 a_position;
in vec4 a_color;
in float a_size;
uniform vec3 u_view;
uniform vec2 u_canvas;
uniform float u_ratio;
out vec4 v_color;
void main() {
  vec2 screen = a_position * u_view.z + u_view.xy;
  gl_Position = vec4(screen.x / u_canvas.x * 2.0 - 1.0, 1.0 - screen.y / u_canvas.y * 2.0, 0.0, 1.0);
  gl_PointSize = a_size * u_ratio;
  v_color = a_color;
}`;
const FRAGMENT = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 color;
void main() {
  float distance = length(gl_PointCoord - vec2(0.5));
  if (distance > 0.5) discard;
  color = vec4(v_color.rgb, v_color.a * smoothstep(0.5, 0.38, distance));
}`;

/** Screen size of a point: small far out, about a card's dot up close. */
export function landscapePointSize(scale: number) {
  return Math.max(3, Math.min(10, 3 + Math.sqrt(Math.max(0, scale)) * 9));
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const k = (n: number) => (n + hue / 30) % 12;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const f = (n: number) => lightness - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function compile(gl: WebGL2RenderingContext) {
  const shader = (type: number, source: string) => {
    const item = gl.createShader(type)!;
    gl.shaderSource(item, source); gl.compileShader(item);
    if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(item) ?? "Shader failed");
    return item;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "Program failed");
  return program;
}

/** Region names shown at once, largest regions first. */
const MAX_LABELS = 24;
/** World cell for the hover index; a few cards wide. */
const CELL = 400;

/**
 * Every document of the landscape as a point, drawn by the GPU in one call so
 * tens of thousands stay smooth, with region names over them far out. Follows
 * the camera outside React through `subscribeCamera`. Cards drawn by the map
 * sit on top up close.
 */
export function GraphLandscapeLayer({ points, matched, glowing, emphasized = null, selectedId, viewport, size, subscribeCamera, labels, showLabels, hostRef, titleOf, onSelect, onOpenLabel }: {
  points: LandscapePoint[];
  /** Documents that pass the map's filters; the rest are drawn faint. Null is every document. */
  matched: Set<string> | null;
  /** Found by the map search: drawn larger and bright. */
  glowing: Set<string> | null;
  /** Your documents among a field's papers: drawn larger and brighter than the papers around them. */
  emphasized?: Set<string> | null;
  selectedId: string | null;
  viewport: GraphViewport;
  size: { width: number; height: number };
  subscribeCamera: (listener: (viewport: GraphViewport) => void) => () => void;
  labels: LandscapeLabel[];
  showLabels: boolean;
  /** The map's viewport element, for hover and click. */
  hostRef: RefObject<HTMLElement | null>;
  titleOf: (id: string) => string;
  onSelect: (id: string) => void;
  onOpenLabel: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef(viewport);
  const drawRef = useRef<() => void>(() => {});
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const width = size.width || 1000, height = size.height || 700;

  const index = useMemo(() => {
    const cells = new Map<string, number[]>();
    points.forEach((point, at) => {
      const key = `${Math.floor(point.x / CELL)}:${Math.floor(point.y / CELL)}`;
      (cells.get(key) ?? cells.set(key, []).get(key)!).push(at);
    });
    return cells;
  }, [points]);

  // Buffers: position, then color and size, rebuilt only when points or highlights change.
  const buffers = useMemo(() => {
    const positions = new Float32Array(points.length * 2), colors = new Float32Array(points.length * 4), sizes = new Float32Array(points.length);
    points.forEach((point, at) => {
      positions[at * 2] = point.x; positions[at * 2 + 1] = point.y;
      const own = emphasized?.has(point.id) ?? false, background = !!emphasized && !own;
      const dim = matched && !background ? !matched.has(point.id) : false, glow = glowing?.has(point.id) ?? false, selected = point.id === selectedId;
      const [r, g, b] = own ? hslToRgb(point.hue ?? 160, 0.85, 0.7) : selected || glow ? hslToRgb(point.hue ?? 160, 0.75, 0.55)
        : point.hue === null ? [0.55, 0.55, 0.55] : hslToRgb(point.hue, 0.5, 0.52);
      colors.set([r, g, b, dim ? 0.18 : glow || selected || own ? 1 : background ? 0.68 : 0.78], at * 4);
      sizes[at] = selected ? 2.2 : own ? 2 : glow ? 1.8 : dim ? 0.8 : 1;
    });
    return { positions, colors, sizes };
  }, [points, matched, glowing, emphasized, selectedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, antialias: false });
    let draw: () => void;
    if (gl) {
      const program = compile(gl);
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const attribute = (name: string, data: Float32Array, components: number) => {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        const location = gl.getAttribLocation(program, name);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, components, gl.FLOAT, false, 0, 0);
        return buffer;
      };
      const made = [attribute("a_position", buffers.positions, 2), attribute("a_color", buffers.colors, 4)];
      const sizeBuffer = gl.createBuffer();
      const sizeData = new Float32Array(buffers.sizes.length);
      gl.bindBuffer(gl.ARRAY_BUFFER, sizeBuffer);
      const sizeLocation = gl.getAttribLocation(program, "a_size");
      gl.enableVertexAttribArray(sizeLocation);
      gl.vertexAttribPointer(sizeLocation, 1, gl.FLOAT, false, 0, 0);
      const view = gl.getUniformLocation(program, "u_view"), canvasSize = gl.getUniformLocation(program, "u_canvas"), pointRatio = gl.getUniformLocation(program, "u_ratio");
      let lastPointSize = -1;
      draw = () => {
        const camera = cameraRef.current, pointSize = landscapePointSize(camera.scale);
        if (pointSize !== lastPointSize) {
          for (let at = 0; at < sizeData.length; at++) sizeData[at] = buffers.sizes[at] * pointSize;
          gl.bindBuffer(gl.ARRAY_BUFFER, sizeBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, sizeData, gl.DYNAMIC_DRAW);
          lastPointSize = pointSize;
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.uniform3f(view, camera.x, camera.y, camera.scale);
        gl.uniform2f(canvasSize, width, height);
        gl.uniform1f(pointRatio, ratio);
        gl.drawArrays(gl.POINTS, 0, points.length);
      };
      drawRef.current = draw;
      draw();
      return () => {
        drawRef.current = () => {};
        for (const buffer of [...made, sizeBuffer]) gl.deleteBuffer(buffer);
        gl.deleteVertexArray(vao); gl.deleteProgram(program);
      };
    }
    // Without WebGL, the same points on a 2D canvas.
    const context = canvas.getContext("2d");
    if (!context) return;
    draw = () => {
      const camera = cameraRef.current, pointSize = landscapePointSize(camera.scale);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      for (let at = 0; at < points.length; at++) {
        const x = buffers.positions[at * 2] * camera.scale + camera.x, y = buffers.positions[at * 2 + 1] * camera.scale + camera.y;
        if (x < -10 || y < -10 || x > width + 10 || y > height + 10) continue;
        const [r, g, b, a] = buffers.colors.subarray(at * 4, at * 4 + 4);
        context.fillStyle = `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
        context.beginPath();
        context.arc(x, y, buffers.sizes[at] * pointSize / 2, 0, Math.PI * 2);
        context.fill();
      }
    };
    drawRef.current = draw;
    draw();
    return () => { drawRef.current = () => {}; };
  }, [buffers, points.length, width, height]);

  // Region names: the largest first, each kept only where it does not cover a larger one.
  const placeLabels = useRef<() => void>(() => {});
  // Sizes are read once per set of names: reading them every frame would make the browser lay the page out each frame.
  const labelSizes = useRef(new WeakMap<HTMLElement, { width: number; height: number }>());
  placeLabels.current = () => {
    const container = labelsRef.current;
    if (!container) return;
    const camera = cameraRef.current;
    const taken: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    for (const element of container.children as HTMLCollectionOf<HTMLElement>) {
      const x = Number(element.dataset.x) * camera.scale + camera.x, y = Number(element.dataset.y) * camera.scale + camera.y;
      let measured = labelSizes.current.get(element);
      if (!measured) labelSizes.current.set(element, measured = { width: element.offsetWidth, height: element.offsetHeight });
      const halfWidth = measured.width / 2 + 6, halfHeight = measured.height / 2 + 4;
      const box = { x0: x - halfWidth, y0: y - halfHeight, x1: x + halfWidth, y1: y + halfHeight };
      // A region drawn smaller than its name is left unlabelled until zoomed in.
      const visible = showLabels && taken.length < MAX_LABELS && Number(element.dataset.radius) * camera.scale > halfWidth
        && box.x1 > 0 && box.y1 > 0 && box.x0 < width && box.y0 < height
        && !taken.some((other) => box.x0 < other.x1 && other.x0 < box.x1 && box.y0 < other.y1 && other.y0 < box.y1);
      element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
      // Hidden by visibility, not display, so a hidden name keeps the size the next placement measures.
      element.style.visibility = visible ? "visible" : "hidden";
      element.tabIndex = visible ? 0 : -1;
      if (visible) taken.push(box);
    }
  };
  useLayoutEffect(() => { labelSizes.current = new WeakMap(); placeLabels.current(); }, [labels, showLabels, width, height]);

  useEffect(() => {
    cameraRef.current = viewport;
    drawRef.current();
    placeLabels.current();
  }, [viewport]);
  useEffect(() => subscribeCamera((next) => {
    cameraRef.current = next;
    drawRef.current();
    placeLabels.current();
    setHover(null);
  }), [subscribeCamera]);

  // Hover shows a point's title; a click selects it. Cards and controls on top keep their own clicks.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const nearest = (event: PointerEvent | MouseEvent) => {
      const rect = host.getBoundingClientRect(), camera = cameraRef.current;
      const sx = event.clientX - rect.left, sy = event.clientY - rect.top;
      const wx = (sx - camera.x) / camera.scale, wy = (sy - camera.y) / camera.scale;
      const reach = Math.max(8, landscapePointSize(camera.scale)) / camera.scale;
      let best = -1, bestDistance = reach;
      const cx = Math.floor(wx / CELL), cy = Math.floor(wy / CELL), span = Math.ceil(reach / CELL);
      for (let x = cx - span; x <= cx + span; x++) for (let y = cy - span; y <= cy + span; y++) {
        for (const at of index.get(`${x}:${y}`) ?? []) {
          const distance = Math.hypot(points[at].x - wx, points[at].y - wy);
          if (distance < bestDistance) { bestDistance = distance; best = at; }
        }
      }
      return best < 0 ? null : { id: points[best].id, x: points[best].x * camera.scale + camera.x, y: points[best].y * camera.scale + camera.y };
    };
    const onCards = (event: Event) => !!(event.target as Element).closest?.("[data-conversation-id], [data-graph-ui], button, a, input, summary");
    let down: { x: number; y: number } | null = null;
    const move = (event: PointerEvent) => {
      if (event.buttons || onCards(event)) { setHover(null); return; }
      const found = nearest(event);
      setHover((current) => current?.id === found?.id ? current : found);
    };
    const press = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
    const click = (event: MouseEvent) => {
      const start = down; down = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5 || onCards(event)) return;
      const found = nearest(event);
      if (found) onSelect(found.id);
    };
    const leave = () => setHover(null);
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerdown", press, true);
    host.addEventListener("click", click);
    host.addEventListener("pointerleave", leave);
    return () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerdown", press, true);
      host.removeEventListener("click", click);
      host.removeEventListener("pointerleave", leave);
    };
  }, [hostRef, index, points, onSelect]);

  return <div className="graph-landscape">
    <canvas ref={canvasRef} className="graph-landscape-points" aria-hidden="true" style={{ width, height }} data-landscape-points={points.length} />
    <div ref={labelsRef} className="graph-landscape-labels" data-graph-ui="true">
      {labels.map((label) => <button key={label.id} type="button" className="graph-landscape-label" data-x={label.x} data-y={label.y} data-radius={label.radius}
        style={{ fontSize: `${Math.round(12 + Math.min(8, Math.log2(Math.max(1, label.count))))}px` }}
        onClick={() => onOpenLabel(label.id)} aria-label={`Zoom to ${label.label}, ${label.count} documents`}>{label.label}</button>)}
    </div>
    {hover ? <div className="graph-landscape-tooltip" role="status" style={{ transform: `translate(${Math.round(hover.x)}px, ${Math.round(hover.y - 14)}px) translate(-50%, -100%)` }}>{titleOf(hover.id)}</div> : null}
  </div>;
}
