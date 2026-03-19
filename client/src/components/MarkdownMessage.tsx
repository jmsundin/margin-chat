import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import type { MermaidConfig } from "mermaid";
import { renderMarkdownToHtml } from "../lib/markdown";
import type { MessageAnchorLink, SelectionDraft } from "../types";

type Decoration =
  | {
      type: "anchor";
      startOffset: number;
      endOffset: number;
      branchConversationId: string;
    }
  | {
      type: "preview";
      startOffset: number;
      endOffset: number;
    };

interface MarkdownMessageProps {
  anchors: MessageAnchorLink[];
  className?: string;
  content: string;
  conversationId: string;
  enableMermaidRendering: boolean;
  messageId: string;
  pendingSelection: SelectionDraft | null;
  registerAnchorRef: (
    branchConversationId: string,
    element: HTMLSpanElement | null,
  ) => void;
  theme: "light" | "dark";
}

const MERMAID_BLOCK_SELECTOR = ".message-mermaid-block";
const INTERACTIVE_MERMAID_SELECTOR =
  '.message-mermaid-diagram[data-mermaid-interactive="true"]';
const MERMAID_VIEWER_PADDING_PX = 24;
const MERMAID_VIEWER_MAX_SCALE = 4;
const MERMAID_VIEWER_MIN_SCALE = 0.35;

type MermaidViewerState = {
  height: number;
  source: string;
  width: number;
};

type MermaidViewerTransform = {
  scale: number;
  x: number;
  y: number;
};

type MermaidViewerDragState = {
  originX: number;
  originY: number;
  pointerId: number;
  startX: number;
  startY: number;
};

function buildMermaidRenderId(messageId: string, index: number) {
  return `mermaid-${messageId.replace(/[^a-z0-9_-]/gi, "-")}-${index}`;
}

function buildDecorationKey(decorations: Decoration[]) {
  return decorations
    .map((decoration) =>
      decoration.type === "anchor"
        ? `a:${decoration.startOffset}:${decoration.endOffset}:${decoration.branchConversationId}`
        : `p:${decoration.startOffset}:${decoration.endOffset}`,
    )
    .join("|");
}

function clampMermaidScale(scale: number) {
  return Math.min(MERMAID_VIEWER_MAX_SCALE, Math.max(MERMAID_VIEWER_MIN_SCALE, scale));
}

function parseNumericAttribute(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseFloat(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function getMermaidDiagramSize(diagram: HTMLElement) {
  const svg = diagram.querySelector("svg");

  if (svg) {
    const viewBox = svg.getAttribute("viewBox");

    if (viewBox) {
      const [left, top, width, height] = viewBox
        .trim()
        .split(/[\s,]+/)
        .map((value) => Number.parseFloat(value));

      if (
        Number.isFinite(left) &&
        Number.isFinite(top) &&
        Number.isFinite(width) &&
        Number.isFinite(height) &&
        width > 0 &&
        height > 0
      ) {
        return { height, width };
      }
    }

    const width = parseNumericAttribute(svg.getAttribute("width"));
    const height = parseNumericAttribute(svg.getAttribute("height"));

    if (width && height) {
      return { height, width };
    }

    const rect = svg.getBoundingClientRect();

    if (rect.width > 0 && rect.height > 0) {
      return { height: rect.height, width: rect.width };
    }
  }

  const fallbackRect = diagram.getBoundingClientRect();

  return {
    height: Math.max(fallbackRect.height, 240),
    width: Math.max(fallbackRect.width, 320),
  };
}

function buildMermaidViewerTransform(
  viewportWidth: number,
  viewportHeight: number,
  diagramWidth: number,
  diagramHeight: number,
): MermaidViewerTransform {
  const safeDiagramWidth = Math.max(diagramWidth, 1);
  const safeDiagramHeight = Math.max(diagramHeight, 1);
  const safeViewportWidth = Math.max(viewportWidth, MERMAID_VIEWER_PADDING_PX * 2);
  const safeViewportHeight = Math.max(viewportHeight, MERMAID_VIEWER_PADDING_PX * 2);
  const fitScale = clampMermaidScale(
    Math.min(
      (safeViewportWidth - MERMAID_VIEWER_PADDING_PX * 2) / safeDiagramWidth,
      (safeViewportHeight - MERMAID_VIEWER_PADDING_PX * 2) / safeDiagramHeight,
    ),
  );

  return {
    scale: fitScale,
    x: (safeViewportWidth - safeDiagramWidth * fitScale) / 2,
    y: (safeViewportHeight - safeDiagramHeight * fitScale) / 2,
  };
}

function findInteractiveMermaidDiagram(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return null;
  }

  return target.closest<HTMLElement>(INTERACTIVE_MERMAID_SELECTOR);
}

function getMermaidConfig(theme: "light" | "dark"): MermaidConfig {
  return {
    darkMode: theme === "dark",
    deterministicIds: true,
    deterministicIDSeed: `margin-chat-${theme}`,
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    htmlLabels: false,
    securityLevel: "strict",
    startOnLoad: false,
    theme: theme === "dark" ? "dark" : "neutral",
  };
}

function setMermaidStatus(block: HTMLElement, message: string | null) {
  const existingStatus = block.querySelector<HTMLElement>(".message-mermaid-status");

  if (!message) {
    existingStatus?.remove();
    return;
  }

  const status = existingStatus ?? document.createElement("p");
  status.className = "message-mermaid-status";
  status.textContent = message;

  if (!existingStatus) {
    block.append(status);
  }
}

function buildDecorations(
  anchors: MessageAnchorLink[],
  pendingSelection: SelectionDraft | null,
) {
  const canRenderPendingSelection =
    pendingSelection &&
    pendingSelection.endOffset > pendingSelection.startOffset &&
    !anchors.some(
      (link) =>
        pendingSelection.startOffset < link.anchor.endOffset &&
        pendingSelection.endOffset > link.anchor.startOffset,
    );
  const decorations: Decoration[] = anchors.map((link) => ({
    type: "anchor",
    startOffset: link.anchor.startOffset,
    endOffset: link.anchor.endOffset,
    branchConversationId: link.branchConversationId,
  }));

  if (canRenderPendingSelection) {
    decorations.push({
      type: "preview",
      startOffset: pendingSelection.startOffset,
      endOffset: pendingSelection.endOffset,
    });
  }

  return decorations.sort((left, right) => left.startOffset - right.startOffset);
}

function applyDecorations(
  root: HTMLDivElement,
  decorations: Decoration[],
  registerAnchorRef: (
    branchConversationId: string,
    element: HTMLSpanElement | null,
  ) => void,
) {
  if (!decorations.length) {
    return [];
  }

  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.length) {
      textNodes.push(node as Text);
    }
  }

  const anchorElements = new Map<string, HTMLSpanElement>();
  let globalOffset = 0;

  for (const textNode of textNodes) {
    const text = textNode.textContent ?? "";
    const textLength = text.length;
    const nodeStart = globalOffset;
    const nodeEnd = nodeStart + textLength;
    const overlappingDecorations = decorations.filter(
      (decoration) =>
        decoration.startOffset < nodeEnd && decoration.endOffset > nodeStart,
    );

    globalOffset = nodeEnd;

    if (!overlappingDecorations.length) {
      continue;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;

    for (const decoration of overlappingDecorations) {
      const localStart = Math.max(0, decoration.startOffset - nodeStart);
      const localEnd = Math.min(textLength, decoration.endOffset - nodeStart);

      if (localEnd <= localStart) {
        continue;
      }

      if (localStart > cursor) {
        fragment.append(text.slice(cursor, localStart));
      }

      const mark = document.createElement("mark");
      mark.className =
        decoration.type === "preview"
          ? "message-anchor is-pending-selection"
          : "message-anchor";

      const innerSpan = document.createElement("span");
      innerSpan.textContent = text.slice(localStart, localEnd);
      mark.append(innerSpan);
      fragment.append(mark);

      if (
        decoration.type === "anchor" &&
        !anchorElements.has(decoration.branchConversationId)
      ) {
        anchorElements.set(decoration.branchConversationId, innerSpan);
      }

      cursor = localEnd;
    }

    if (cursor < textLength) {
      fragment.append(text.slice(cursor));
    }

    textNode.replaceWith(fragment);
  }

  for (const [branchConversationId, element] of anchorElements) {
    registerAnchorRef(branchConversationId, element);
  }

  return [...anchorElements.keys()];
}

export default function MarkdownMessage({
  anchors,
  className,
  content,
  conversationId,
  enableMermaidRendering,
  messageId,
  pendingSelection,
  registerAnchorRef,
  theme,
}: MarkdownMessageProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const decorationsRef = useRef<Decoration[]>([]);
  const registerAnchorRefRef = useRef(registerAnchorRef);
  const registeredAnchorIdsRef = useRef<string[]>([]);
  const viewerDragRef = useRef<MermaidViewerDragState | null>(null);
  const viewerRenderCountRef = useRef(0);
  const viewerTransformRef = useRef<MermaidViewerTransform>({
    scale: 1,
    x: 0,
    y: 0,
  });
  const viewerViewportRef = useRef<HTMLDivElement>(null);
  const [activeViewer, setActiveViewer] = useState<MermaidViewerState | null>(null);
  const [isViewerDragging, setViewerDragging] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [viewerSvgMarkup, setViewerSvgMarkup] = useState<string | null>(null);
  const [viewerTransform, setViewerTransform] = useState<MermaidViewerTransform>({
    scale: 1,
    x: 0,
    y: 0,
  });
  const renderedHtml = renderMarkdownToHtml(content);
  const decorations = buildDecorations(anchors, pendingSelection);
  const decorationsKey = buildDecorationKey(decorations);

  decorationsRef.current = decorations;
  registerAnchorRefRef.current = registerAnchorRef;
  viewerTransformRef.current = viewerTransform;

  function resetViewerTransform(nextViewer = activeViewer) {
    const viewport = viewerViewportRef.current;

    if (!viewport || !nextViewer) {
      return;
    }

    setViewerTransform(
      buildMermaidViewerTransform(
        viewport.clientWidth,
        viewport.clientHeight,
        nextViewer.width,
        nextViewer.height,
      ),
    );
  }

  function closeViewer() {
    viewerDragRef.current = null;
    setViewerDragging(false);
    setViewerError(null);
    setViewerSvgMarkup(null);
    setActiveViewer(null);
  }

  function updateViewerScale(nextScale: number, anchorX?: number, anchorY?: number) {
    setViewerTransform((current) => {
      const viewport = viewerViewportRef.current;
      const clampedScale = clampMermaidScale(nextScale);

      if (!viewport || clampedScale === current.scale) {
        return current;
      }

      const nextAnchorX = anchorX ?? viewport.clientWidth / 2;
      const nextAnchorY = anchorY ?? viewport.clientHeight / 2;
      const contentX = (nextAnchorX - current.x) / current.scale;
      const contentY = (nextAnchorY - current.y) / current.scale;

      return {
        scale: clampedScale,
        x: nextAnchorX - contentX * clampedScale,
        y: nextAnchorY - contentY * clampedScale,
      };
    });
  }

  function openViewer(diagram: HTMLElement) {
    const block = diagram.closest<HTMLElement>(MERMAID_BLOCK_SELECTOR);
    const source = block?.querySelector("code")?.textContent?.trim() ?? "";

    if (!source) {
      return;
    }

    const nextViewer = {
      ...getMermaidDiagramSize(diagram),
      source,
    };

    setViewerError(null);
    setViewerSvgMarkup(null);
    setActiveViewer(nextViewer);
    setViewerTransform({
      scale: 1,
      x: 0,
      y: 0,
    });
  }

  function handleMarkdownClick(event: ReactMouseEvent<HTMLDivElement>) {
    const diagram = findInteractiveMermaidDiagram(event.target);

    if (!diagram) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    openViewer(diagram);
  }

  function handleMarkdownKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    const diagram = findInteractiveMermaidDiagram(event.target);

    if (!diagram) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    openViewer(diagram);
  }

  function handleViewerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    const viewport = viewerViewportRef.current;

    if (!viewport) {
      return;
    }

    event.preventDefault();
    viewport.setPointerCapture(event.pointerId);
    viewerDragRef.current = {
      originX: viewerTransformRef.current.x,
      originY: viewerTransformRef.current.y,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    setViewerDragging(true);
  }

  function handleViewerPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = viewerDragRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    setViewerTransform((current) => ({
      ...current,
      x: dragState.originX + event.clientX - dragState.startX,
      y: dragState.originY + event.clientY - dragState.startY,
    }));
  }

  function finishViewerDrag(pointerId?: number) {
    if (
      pointerId !== undefined &&
      viewerDragRef.current &&
      viewerDragRef.current.pointerId !== pointerId
    ) {
      return;
    }

    viewerDragRef.current = null;
    setViewerDragging(false);
  }

  function handleViewerWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const viewport = viewerViewportRef.current;

    if (!viewport) {
      return;
    }

    event.preventDefault();

    const rect = viewport.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const nextScale =
      event.deltaY < 0
        ? viewerTransformRef.current.scale * 1.12
        : viewerTransformRef.current.scale / 1.12;

    updateViewerScale(nextScale, anchorX, anchorY);
  }

  useLayoutEffect(() => {
    const root = contentRef.current;
    const nextRegisterAnchorRef = registerAnchorRefRef.current;

    if (!root) {
      return;
    }

    for (const branchConversationId of registeredAnchorIdsRef.current) {
      nextRegisterAnchorRef(branchConversationId, null);
    }

    root.innerHTML = renderedHtml;
    registeredAnchorIdsRef.current = applyDecorations(
      root,
      decorationsRef.current,
      nextRegisterAnchorRef,
    );

    return () => {
      const currentRegisterAnchorRef = registerAnchorRefRef.current;

      for (const branchConversationId of registeredAnchorIdsRef.current) {
        currentRegisterAnchorRef(branchConversationId, null);
      }

      registeredAnchorIdsRef.current = [];
    };
  }, [decorationsKey, renderedHtml]);

  useEffect(() => {
    const root = contentRef.current;

    if (!root || !enableMermaidRendering) {
      return;
    }

    const mermaidBlocks = [
      ...root.querySelectorAll<HTMLElement>(MERMAID_BLOCK_SELECTOR),
    ];

    if (!mermaidBlocks.length) {
      return;
    }

    let cancelled = false;

    const renderMermaidBlocks = async () => {
      const { default: mermaid } = await import("mermaid");

      if (cancelled) {
        return;
      }

      mermaid.initialize(getMermaidConfig(theme));

      for (const [index, block] of mermaidBlocks.entries()) {
        const source = block.querySelector("code")?.textContent ?? "";
        const diagram = block.querySelector<HTMLElement>(".message-mermaid-diagram");

        if (!source.trim() || !diagram) {
          continue;
        }

        try {
          const { svg, bindFunctions } = await mermaid.render(
            buildMermaidRenderId(messageId, index),
            source,
          );

          if (cancelled) {
            return;
          }

          diagram.innerHTML = svg;
          bindFunctions?.(diagram);
          diagram.dataset.mermaidInteractive = "true";
          diagram.tabIndex = 0;
          diagram.setAttribute("aria-label", "Open Mermaid diagram fullscreen");
          diagram.setAttribute("role", "button");
          block.classList.add("is-rendered");
          block.classList.remove("has-error");
          setMermaidStatus(block, null);
        } catch (error) {
          if (cancelled) {
            return;
          }

          block.classList.remove("is-rendered");
          block.classList.add("has-error");
          diagram.innerHTML = "";
          delete diagram.dataset.mermaidInteractive;
          diagram.removeAttribute("aria-label");
          diagram.removeAttribute("role");
          diagram.removeAttribute("tabindex");
          setMermaidStatus(
            block,
            error instanceof Error && error.message
              ? `Mermaid render error: ${error.message}`
              : "Mermaid render error: diagram source is shown instead.",
          );
        }
      }
    };

    void renderMermaidBlocks();

    return () => {
      cancelled = true;
    };
  }, [
    decorationsKey,
    enableMermaidRendering,
    messageId,
    renderedHtml,
    theme,
  ]);

  useLayoutEffect(() => {
    if (!activeViewer) {
      return;
    }

    resetViewerTransform(activeViewer);
  }, [activeViewer]);

  useEffect(() => {
    if (!activeViewer) {
      return;
    }

    let cancelled = false;

    const renderViewerDiagram = async () => {
      const { default: mermaid } = await import("mermaid");

      if (cancelled) {
        return;
      }

      mermaid.initialize(getMermaidConfig(theme));

      try {
        const { svg } = await mermaid.render(
          buildMermaidRenderId(
            `${messageId}-viewer-${viewerRenderCountRef.current}`,
            viewerRenderCountRef.current,
          ),
          activeViewer.source,
        );

        if (cancelled) {
          return;
        }

        viewerRenderCountRef.current += 1;
        setViewerSvgMarkup(svg);
        setViewerError(null);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setViewerSvgMarkup(null);
        setViewerError(
          error instanceof Error && error.message
            ? error.message
            : "Unable to open this Mermaid diagram fullscreen.",
        );
      }
    };

    void renderViewerDiagram();

    return () => {
      cancelled = true;
    };
  }, [activeViewer, messageId, theme]);

  useEffect(() => {
    if (!activeViewer) {
      return;
    }

    const previousOverflow = document.body.style.overflow;

    function handleWindowKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeViewer();
      }
    }

    function handleWindowResize() {
      resetViewerTransform();
    }

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleWindowKeyDown);
    window.addEventListener("resize", handleWindowResize);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleWindowKeyDown);
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [activeViewer]);

  const viewerOverlay =
    activeViewer && typeof document !== "undefined"
      ? createPortal(
          <div
            className="mermaid-viewer-backdrop"
            onClick={closeViewer}
            role="presentation"
          >
            <div
              aria-label="Mermaid diagram viewer"
              aria-modal="true"
              className="mermaid-viewer"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
            >
              <div className="mermaid-viewer-head">
                <div className="mermaid-viewer-copy">
                  <strong>Mermaid Diagram</strong>
                  <span>Drag to move. Use the wheel or controls to zoom.</span>
                </div>

                <div className="mermaid-viewer-actions">
                  <span className="mermaid-viewer-zoom-label">
                    {Math.round(viewerTransform.scale * 100)}%
                  </span>
                  <button
                    className="mermaid-viewer-button"
                    onClick={() => updateViewerScale(viewerTransform.scale / 1.18)}
                    type="button"
                  >
                    -
                  </button>
                  <button
                    className="mermaid-viewer-button"
                    onClick={() => resetViewerTransform()}
                    type="button"
                  >
                    Fit
                  </button>
                  <button
                    className="mermaid-viewer-button"
                    onClick={() => updateViewerScale(viewerTransform.scale * 1.18)}
                    type="button"
                  >
                    +
                  </button>
                  <button
                    className="mermaid-viewer-button is-primary"
                    onClick={closeViewer}
                    type="button"
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="mermaid-viewer-stage">
                <div
                  ref={viewerViewportRef}
                  className={
                    isViewerDragging
                      ? "mermaid-viewer-viewport is-dragging"
                      : "mermaid-viewer-viewport"
                  }
                  onLostPointerCapture={(event) => finishViewerDrag(event.pointerId)}
                  onPointerCancel={(event) => finishViewerDrag(event.pointerId)}
                  onPointerDown={handleViewerPointerDown}
                  onPointerMove={handleViewerPointerMove}
                  onPointerUp={(event) => finishViewerDrag(event.pointerId)}
                  onWheel={handleViewerWheel}
                >
                  {viewerError ? (
                    <div className="mermaid-viewer-state is-error" role="alert">
                      {viewerError}
                    </div>
                  ) : viewerSvgMarkup ? (
                    <div
                      className="mermaid-viewer-canvas"
                      style={{
                        height: `${activeViewer.height}px`,
                        transform: `translate(${viewerTransform.x}px, ${viewerTransform.y}px) scale(${viewerTransform.scale})`,
                        width: `${activeViewer.width}px`,
                      }}
                    >
                      <div
                        className="mermaid-viewer-diagram"
                        dangerouslySetInnerHTML={{ __html: viewerSvgMarkup }}
                      />
                    </div>
                  ) : (
                    <div className="mermaid-viewer-state">Rendering diagram…</div>
                  )}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div
        ref={contentRef}
        className={className ? `${className} is-markdown` : "message-content is-markdown"}
        data-message-bubble="true"
        data-conversation-id={conversationId}
        data-message-id={messageId}
        onClick={handleMarkdownClick}
        onKeyDown={handleMarkdownKeyDown}
      />
      {viewerOverlay}
    </>
  );
}
