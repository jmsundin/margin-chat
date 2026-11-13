import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import type { CanvasBlock, CanvasGroupBox, CanvasThemeBox } from "../lib/canvasGroupBoxes";
import type { GraphViewport } from "../lib/graphInteractions";
import type { MapZoomLevel } from "../lib/mapZoomLevels";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const countOf = (box: Pick<CanvasGroupBox, "conversationIds">) => plural(box.conversationIds.length, "document", "documents");

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

/** A topic tile this big has room for its one-sentence summary under its name. */
const SUMMARY_MIN_WIDTH = 220, SUMMARY_MIN_HEIGHT = 124;
const BLOCK_LABEL_HEIGHT = 16;
/** A block narrower than this on screen has no room for a name. */
const BLOCK_LABEL_MIN_WIDTH = 44;

/**
 * Where a block's name sits, in screen pixels from the map's origin (add the camera's x and y):
 * just above the block's first row of circles, starting at its left edge.
 */
export function blockLabelFrame(block: Pick<CanvasBlock, "x" | "y" | "width">, name: string, scale: number, cardHeight: number) {
  const room = block.width * scale - 6;
  if (room < BLOCK_LABEL_MIN_WIDTH) return null;
  const width = Math.min(room, Math.ceil(name.length * 6.4) + 12);
  // A block starts half a row gap above its cards; the circle sits in the middle of its card, and the name ends a little above it.
  const circleTop = (block.y + 8 + cardHeight / 2) * scale - 9;
  return { x: block.x * scale + 3, y: circleTop - BLOCK_LABEL_HEIGHT - 1, width, height: BLOCK_LABEL_HEIGHT, maxWidth: room };
}

/** Where a box sits on screen for a camera. */
function boxFrame(box: { x: number; y: number; width: number; height: number }, viewport: GraphViewport) {
  return { left: viewport.x + box.x * viewport.scale, top: viewport.y + box.y * viewport.scale,
    width: box.width * viewport.scale, height: box.height * viewport.scale };
}

/**
 * The Map draws each topic, or each of your groups, as a box that owns its space, and steps through
 * levels as you zoom. Zoomed far out, broad themes stand in for the topic boxes inside them; closer,
 * each topic is a tile with its name, count and a one-sentence summary; closer still the documents
 * show, with each block of alike documents named.
 *
 * While you pan or zoom by hand, the map moves its cards outside React every frame and tells React
 * only now and then. The boxes follow the same camera through `subscribeCamera`, so they move with
 * the cards instead of jumping to catch up each time React hears where the camera is.
 */
export default function CanvasGroupBoxes({ boxes, themes = NO_THEMES, level, collapsed, viewport, cardHeight = 96, summaries, blockNames, onOpen, onOpenTheme, onOpenBlock, subscribeCamera, liveCamera }: {
  boxes: CanvasGroupBox[];
  themes?: CanvasThemeBox[];
  /** The zoom level the map is at; without it, `collapsed` alone says whether boxes are tiles. */
  level?: MapZoomLevel;
  viewport: GraphViewport;
  /** The camera right now; a render that React commits late must not put the boxes back where the camera was. */
  liveCamera?: () => GraphViewport;
  collapsed: boolean;
  /** A card's height on the map, to place block names above their circles. */
  cardHeight?: number;
  /** One sentence for a theme or a box, by id. */
  summaries?: ReadonlyMap<string, string>;
  /** Names for blocks of alike documents, by block id; blocks without a name are not drawn. */
  blockNames?: ReadonlyMap<string, string>;
  onOpen: (box: CanvasGroupBox) => void;
  onOpenTheme?: (theme: CanvasThemeBox) => void;
  onOpenBlock?: (block: CanvasBlock) => void;
  subscribeCamera?: (listener: (viewport: GraphViewport) => void) => () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const themeLayerRef = useRef<HTMLDivElement>(null), boxLayerRef = useRef<HTMLDivElement>(null), blockLayerRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef(viewport);
  const themesClosed = level === "themes" && themes.length > 0;
  const blocks = useMemo(() => level === "themes" || level === "topics" || collapsed || !blockNames?.size ? NO_BLOCKS
    : boxes.flatMap((box) => (box.blocks ?? []).filter((block) => block.kind === "alike" && blockNames.has(block.id))
      .map((block) => ({ block, color: box.color, name: blockNames.get(block.id)! }))), [boxes, blockNames, level, collapsed]);
  const propsRef = useRef({ boxes, themes, blocks, collapsed, themesClosed, summaries, cardHeight });
  propsRef.current = { boxes, themes, blocks, collapsed, themesClosed, summaries, cardHeight };
  /** What the boxes were last laid out for, one by one. */
  const placedRef = useRef<{ camera: GraphViewport; props: typeof propsRef.current; width: number; height: number } | null>(null);
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
    const current = propsRef.current;
    const placed = placedRef.current;
    // The pan uses the screen size measured at the last layout: reading it again would make the
    // browser lay out the page in the middle of every frame.
    if (placed && placed.width > 0 && placed.height > 0 && placed.camera.scale === camera.scale
      && placed.props.boxes === current.boxes && placed.props.themes === current.themes && placed.props.blocks === current.blocks
      && placed.props.collapsed === current.collapsed && placed.props.themesClosed === current.themesClosed && placed.props.summaries === current.summaries) {
      const dx = camera.x - placed.camera.x, dy = camera.y - placed.camera.y;
      if (Math.abs(dx) < placed.width && Math.abs(dy) < placed.height) {
        host.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : "";
        return;
      }
    }
    const screenWidth = host.clientWidth, screenHeight = host.clientHeight, measured = screenWidth > 0 && screenHeight > 0;
    host.style.transform = "";
    // Zoomed out, a box's name tag would cover the name of its first block; it moves up onto the box's top edge.
    host.classList.toggle("is-tags-raised", current.blocks.length > 0 && camera.scale < 0.46);
    placedRef.current = { camera, props: current, width: screenWidth, height: screenHeight };
    /** Puts an element on its frame, or leaves it out of the page when it is more than a screen away. */
    const frameOn = (element: HTMLElement, frame: ReturnType<typeof boxFrame>) => {
      const offscreen = measured && (frame.left > 2 * screenWidth || frame.left + frame.width < -screenWidth
        || frame.top > 2 * screenHeight || frame.top + frame.height < -screenHeight);
      element.style.display = offscreen ? "none" : "";
      if (offscreen) return false;
      element.style.left = `${frame.left}px`; element.style.top = `${frame.top}px`;
      element.style.width = `${frame.width}px`; element.style.height = `${frame.height}px`;
      return true;
    };
    const themeElements = themeLayerRef.current?.children;
    current.themes.forEach((theme, index) => {
      const element = themeElements?.[index] as HTMLElement | undefined;
      if (!element) return;
      const frame = boxFrame(theme, camera);
      if (!frameOn(element, frame)) return;
      // As a tile, a theme shows as much as fits: its name, then its summary, then its topics.
      const summary = !!current.summaries?.get(theme.id);
      element.classList.toggle("is-tiny", frame.width < 24 || frame.height < 28);
      element.classList.toggle("is-narrow", frame.width < 150);
      // Too narrow for words side by side: the name runs down the tile, like a book's spine.
      element.classList.toggle("is-spine", frame.width < 76 && frame.height > frame.width * 1.6);
      element.classList.toggle("has-summary", summary && frame.width >= 190 && frame.height >= 104);
      element.classList.toggle("has-topics", frame.width >= 170 && frame.height >= (summary ? 168 : 96));
      element.style.setProperty("--label-size", `${Math.round(Math.min(24, Math.max(13, Math.min(frame.height * 0.16, frame.width * 0.085))))}px`);
    });
    const shownBoxes = current.themesClosed ? current.boxes.filter((box) => !box.themeId) : current.boxes;
    const labels = current.collapsed ? planCollapsedLabels(shownBoxes, camera) : null;
    const boxElements = boxLayerRef.current?.children;
    current.boxes.forEach((box, index) => {
      const element = boxElements?.[index] as HTMLElement | undefined;
      if (!element) return;
      // A theme shown as one tile stands in for its topic boxes.
      if (current.themesClosed && box.themeId) { element.style.display = "none"; return; }
      const frame = boxFrame(box, camera);
      if (!frameOn(element, frame)) return;
      const name = element.firstElementChild as HTMLElement | null;
      if (!name) return;
      const label = labels?.get(box.id);
      const summary = !!label && !!current.summaries?.get(box.id) && frame.width >= SUMMARY_MIN_WIDTH && frame.height >= SUMMARY_MIN_HEIGHT;
      name.classList.toggle("is-unlabeled", !!labels && !label);
      name.classList.toggle("hides-count", !!label && !label.showCount);
      name.classList.toggle("has-summary", summary);
      if (label) {
        name.style.setProperty("--label-width", `${summary ? Math.max(label.width, Math.min(340, frame.width - 20)) : label.width}px`);
        name.style.setProperty("--label-size", `${summary ? Math.min(label.fontSize, 18) : label.fontSize}px`);
      } else { name.style.removeProperty("--label-width"); name.style.removeProperty("--label-size"); }
    });
    const blockElements = blockLayerRef.current?.children;
    current.blocks.forEach(({ block, name }, index) => {
      const element = blockElements?.[index] as HTMLElement | undefined;
      if (!element) return;
      if (!frameOn(element, boxFrame(block, camera))) return;
      const label = element.firstElementChild as HTMLElement | null;
      const frame = blockLabelFrame(block, name, camera.scale, current.cardHeight);
      if (!label) return;
      label.style.display = frame ? "" : "none";
      if (!frame) return;
      label.style.left = `${frame.x - block.x * camera.scale}px`; label.style.top = `${frame.y - block.y * camera.scale}px`;
      label.style.maxWidth = `${frame.maxWidth}px`;
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
  const boxById = useMemo(() => new Map(boxes.map((box) => [box.id, box])), [boxes]);
  return <div ref={hostRef} className={`canvas-group-boxes${collapsed ? " is-collapsed" : ""}${themesClosed ? " is-themes-closed" : ""}${level ? ` is-level-${level}` : ""}`} aria-label="Map boxes">
    <div ref={themeLayerRef} className="canvas-theme-boxes">
      {themes.map((theme) => {
        const count = `${countOf(theme)} · ${plural(theme.boxIds.length, "topic", "topics")}`, summary = summaries?.get(theme.id);
        return <div key={theme.id} className="canvas-theme-box" data-theme-id={theme.id} style={{ "--group-color": theme.color } as CSSProperties}>
          <button type="button" data-graph-ui="true" className="canvas-theme-name"
            aria-label={`Zoom to ${theme.label}, ${count}${summary ? `. ${summary}` : ""}`} title={summary ? `${theme.label}: ${summary}` : `Zoom to ${theme.label}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); onOpenTheme?.(theme); }}>
            <strong>{theme.label}</strong><span>{count}</span>
            {summary ? <em>{summary}</em> : null}
            <span className="canvas-theme-topics" aria-hidden="true">{theme.boxIds.slice(0, 8).map((id) => <i key={id}>{boxById.get(id)?.label}</i>)}</span>
          </button>
        </div>;
      })}
    </div>
    <div ref={boxLayerRef} className="canvas-group-box-layer">
      {boxes.map((box) => {
        const count = countOf(box), summary = summaries?.get(box.id);
        return <div key={box.id} className={`canvas-group-box is-${box.kind}`} data-group-id={box.id} title={collapsed ? `${box.label} · ${count}${summary ? `. ${summary}` : ""}` : undefined}
          style={{ "--group-color": box.color } as CSSProperties}>
          <button type="button" data-graph-ui="true" className="canvas-group-box-name"
            aria-label={`Zoom to ${box.label}, ${count}${summary ? `. ${summary}` : ""}`} title={`Zoom to ${box.label}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); onOpen(box); }}>
            <strong>{box.label}</strong><span>{count}</span>
            {summary ? <em>{summary}</em> : null}
          </button>
        </div>;
      })}
    </div>
    <div ref={blockLayerRef} className="canvas-block-layer">
      {blocks.map(({ block, color, name }) => <div key={block.id} className="canvas-block" data-block-id={block.id} style={{ "--group-color": color } as CSSProperties}>
        <button type="button" data-graph-ui="true" className="canvas-block-name"
          aria-label={`Zoom to ${name}, ${countOf(block)}`} title={`${name} · ${countOf(block)}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onOpenBlock?.(block); }}>{name}</button>
      </div>)}
    </div>
  </div>;
}

const NO_THEMES: CanvasThemeBox[] = [];
const NO_BLOCKS: Array<{ block: CanvasBlock; color: string; name: string }> = [];
