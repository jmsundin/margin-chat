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
