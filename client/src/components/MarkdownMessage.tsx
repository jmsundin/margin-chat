import { useLayoutEffect, useRef } from "react";
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
  messageId: string;
  pendingSelection: SelectionDraft | null;
  registerAnchorRef: (
    branchConversationId: string,
    element: HTMLSpanElement | null,
  ) => void;
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
  messageId,
  pendingSelection,
  registerAnchorRef,
}: MarkdownMessageProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const registeredAnchorIdsRef = useRef<string[]>([]);
  const renderedHtml = renderMarkdownToHtml(content);
  const decorations = buildDecorations(anchors, pendingSelection);

  useLayoutEffect(() => {
    const root = contentRef.current;

    if (!root) {
      return;
    }

    for (const branchConversationId of registeredAnchorIdsRef.current) {
      registerAnchorRef(branchConversationId, null);
    }

    root.innerHTML = renderedHtml;
    registeredAnchorIdsRef.current = applyDecorations(
      root,
      decorations,
      registerAnchorRef,
    );

    return () => {
      for (const branchConversationId of registeredAnchorIdsRef.current) {
        registerAnchorRef(branchConversationId, null);
      }

      registeredAnchorIdsRef.current = [];
    };
  }, [decorations, registerAnchorRef, renderedHtml]);

  return (
    <div
      ref={contentRef}
      className={className ? `${className} is-markdown` : "message-content is-markdown"}
      data-message-bubble="true"
      data-conversation-id={conversationId}
      data-message-id={messageId}
    />
  );
}
