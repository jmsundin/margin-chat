import type { DocumentDockNode } from "../types";

export type DocumentDockEdge = "left" | "right" | "top" | "bottom";

export const MIN_DOCK_SPLIT_RATIO = 0.2;
export const MAX_DOCK_SPLIT_RATIO = 0.8;

export function listPinnedDocumentIds(tree: DocumentDockNode | null): string[] {
  if (!tree) return [];
  if (tree.type === "pane") return [tree.documentId];
  return [...listPinnedDocumentIds(tree.first), ...listPinnedDocumentIds(tree.second)];
}

/** Hide panes without mutating the saved layout; retained split IDs stay stable. */
export function filterDocumentDock(tree: DocumentDockNode | null, include: (documentId: string) => boolean): DocumentDockNode | null {
  if (!tree) return null;
  if (tree.type === "pane") return include(tree.documentId) ? tree : null;
  const first = filterDocumentDock(tree.first, include);
  const second = filterDocumentDock(tree.second, include);
  if (!first) return second;
  if (!second) return first;
  return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
}

function split(first: DocumentDockNode, second: DocumentDockNode, direction: "horizontal" | "vertical"): DocumentDockNode {
  return { type: "split", id: `dock-split-${crypto.randomUUID()}`, direction, ratio: 0.5, first, second };
}

/** New pins stack below the existing grid until the user chooses another placement. */
export function addPinnedDocument(tree: DocumentDockNode | null, documentId: string): DocumentDockNode {
  if (tree && listPinnedDocumentIds(tree).includes(documentId)) return tree;
  const pane: DocumentDockNode = { type: "pane", documentId };
  return tree ? split(tree, pane, "vertical") : pane;
}

/** Collapsing empty branches retains the remaining panes' split IDs and sizes. */
export function removePinnedDocument(tree: DocumentDockNode | null, documentId: string): DocumentDockNode | null {
  if (!tree) return null;
  if (tree.type === "pane") return tree.documentId === documentId ? null : tree;
  const first = removePinnedDocument(tree.first, documentId);
  const second = removePinnedDocument(tree.second, documentId);
  if (!first) return second;
  if (!second) return first;
  return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
}

/** Move an existing pane beside the target, preserving unrelated branches. */
export function movePinnedDocument(tree: DocumentDockNode | null, documentId: string, targetId: string, edge: DocumentDockEdge): DocumentDockNode | null {
  const ids = listPinnedDocumentIds(tree);
  if (documentId === targetId || !ids.includes(documentId) || !ids.includes(targetId)) return tree;
  const remaining = removePinnedDocument(tree, documentId);
  const pane = filterDocumentDock(tree, (id) => id === documentId)!;
  function insert(node: DocumentDockNode): DocumentDockNode {
    if (node.type === "pane") {
      if (node.documentId !== targetId) return node;
      return edge === "left" || edge === "top"
        ? split(pane, node, edge === "left" ? "horizontal" : "vertical")
        : split(node, pane, edge === "right" ? "horizontal" : "vertical");
    }
    const first = insert(node.first);
    const second = insert(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  }
  return remaining ? insert(remaining) : tree;
}

export function resizeDocumentDockSplit(tree: DocumentDockNode | null, splitId: string, ratio: number): DocumentDockNode | null {
  if (!tree || tree.type === "pane" || !Number.isFinite(ratio)) return tree;
  if (tree.id === splitId) {
    const bounded = Math.min(MAX_DOCK_SPLIT_RATIO, Math.max(MIN_DOCK_SPLIT_RATIO, ratio));
    return bounded === tree.ratio ? tree : { ...tree, ratio: bounded };
  }
  const first = resizeDocumentDockSplit(tree.first, splitId, ratio)!;
  const second = resizeDocumentDockSplit(tree.second, splitId, ratio)!;
  return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
}

/** Normalized edge distances make placement predictable for wide and tall panes. */
export function getDocumentDockDropEdge(rect: Pick<DOMRect, "left" | "top" | "width" | "height">, x: number, y: number): DocumentDockEdge {
  const horizontal = (x - rect.left) / Math.max(rect.width, 1);
  const vertical = (y - rect.top) / Math.max(rect.height, 1);
  const edges: [DocumentDockEdge, number][] = [["left", horizontal], ["right", 1 - horizontal], ["top", vertical], ["bottom", 1 - vertical]];
  return edges.reduce((nearest, candidate) => candidate[1] < nearest[1] ? candidate : nearest)[0];
}

/** Vertical endpoints mean header-only; keep values inside the existing persisted range. */
export function getDockSplitFraction(node: Extract<DocumentDockNode, { type: "split" }>): number {
  return node.direction === "vertical"
    ? Math.max(0, Math.min(1, (node.ratio - MIN_DOCK_SPLIT_RATIO) / (MAX_DOCK_SPLIT_RATIO - MIN_DOCK_SPLIT_RATIO))) : node.ratio;
}

export const DOCK_DIVIDER_SIZE = 7;
export const DOCK_HEADER_HEIGHT = 37;

/** A compressed subtree must still have room for every header and divider. */
export function getDockMinimumHeight(node: DocumentDockNode, headers: Record<string, number> = {}): number {
  if (node.type === "pane") return headers[node.documentId] ?? DOCK_HEADER_HEIGHT;
  const first = getDockMinimumHeight(node.first, headers);
  const second = getDockMinimumHeight(node.second, headers);
  return node.direction === "vertical" ? first + DOCK_DIVIDER_SIZE + second : Math.max(first, second);
}

export function findDockNode(tree: DocumentDockNode | null, splitId: string): DocumentDockNode | null {
  if (!tree || tree.type === "pane") return null;
  return tree.id === splitId ? tree : findDockNode(tree.first, splitId) ?? findDockNode(tree.second, splitId);
}

/** Apply visible split changes without removing temporarily hidden family pins. */
export function applyDockRatios(tree: DocumentDockNode | null, resized: DocumentDockNode): DocumentDockNode | null {
  if (resized.type === "pane") return tree;
  return applyDockRatios(applyDockRatios(resizeDocumentDockSplit(tree, resized.id, resized.ratio), resized.first), resized.second);
}

/** A divider can push through adjacent content, leaving a stack of visible headers. */
export function resizeVerticalDockStack(stack: DocumentDockNode, splitId: string, offset: number, height: number,
  headers: Record<string, number> = {}): DocumentDockNode {
  if (!Number.isFinite(offset) || !Number.isFinite(height) || height <= 0) return stack;
  const rows: { node: DocumentDockNode; size: number; min: number }[] = [];
  let boundary = -1;
  function measure(node: DocumentDockNode, size: number) {
    if (node.type === "pane" || node.direction !== "vertical") {
      rows.push({ node, size, min: getDockMinimumHeight(node, headers) });
      return;
    }
    const usable = Math.max(0, size - DOCK_DIVIDER_SIZE);
    const minFirst = getDockMinimumHeight(node.first, headers);
    const minSecond = getDockMinimumHeight(node.second, headers);
    const first = Math.max(minFirst, Math.min(usable - minSecond, usable * getDockSplitFraction(node)));
    measure(node.first, first);
    if (node.id === splitId) boundary = rows.length;
    measure(node.second, Math.max(minSecond, usable - first));
  }
  measure(stack, Math.max(height, getDockMinimumHeight(stack, headers)));
  if (boundary < 1 || boundary >= rows.length) return stack;
  const current = rows.slice(0, boundary).reduce((sum, row) => sum + row.size, 0) + (boundary - 1) * DOCK_DIVIDER_SIZE;
  const delta = offset - current;
  const receiver = delta > 0 ? boundary - 1 : boundary;
  let remaining = Math.abs(delta);
  let transferred = 0;
  for (let index = delta > 0 ? boundary : boundary - 1; index >= 0 && index < rows.length && remaining > 0.01; index += delta > 0 ? 1 : -1) {
    const row = rows[index];
    const available = Math.max(0, row.size - row.min);
    let take = Math.min(available, remaining);
    // Snap the last sliver of content shut rather than leaving an unreadable strip.
    if (available - take < 24) take = available;
    row.size -= take;
    remaining -= take;
    transferred += take;
  }
  if (!transferred) return stack;
  rows[receiver].size += transferred;
  let index = 0;
  function rebuild(node: DocumentDockNode): { node: DocumentDockNode; size: number } {
    if (node.type === "pane" || node.direction !== "vertical") return { node, size: rows[index++].size };
    const first = rebuild(node.first);
    const second = rebuild(node.second);
    const firstCollapsed = first.size <= getDockMinimumHeight(first.node, headers) + .01;
    const secondCollapsed = second.size <= getDockMinimumHeight(second.node, headers) + .01;
    const fraction = firstCollapsed && !secondCollapsed ? 0 : secondCollapsed && !firstCollapsed ? 1 : first.size / (first.size + second.size);
    const ratio = MIN_DOCK_SPLIT_RATIO + fraction * (MAX_DOCK_SPLIT_RATIO - MIN_DOCK_SPLIT_RATIO);
    return { node: { ...node, first: first.node, second: second.node, ratio },
      size: first.size + second.size + DOCK_DIVIDER_SIZE };
  }
  return rebuild(stack).node;
}
