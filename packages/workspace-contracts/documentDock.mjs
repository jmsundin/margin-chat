/** Optional pane positions must never prevent recovery of document content. */
export function normalizeDocumentDock(input, conversations) {
  if (!isRecord(input) || !Object.hasOwn(input, "tree")) return undefined;
  const documents = new Set();
  const splits = new Set();
  const visited = new WeakSet();
  let remaining = 127;

  function readNode(node, depth, path) {
    if (!isRecord(node) || depth > 24 || remaining-- <= 0 || visited.has(node)) return null;
    visited.add(node);
    if (node.type === "pane") {
      if (typeof node.documentId !== "string" || !Object.hasOwn(conversations, node.documentId)
        || documents.has(node.documentId)) return null;
      documents.add(node.documentId);
      return { type: "pane", documentId: node.documentId,
        ...(node.scope === "workspace" || node.scope === "family" ? { scope: node.scope } : {}) };
    }
    if (node.type !== "split" || (node.direction !== "horizontal" && node.direction !== "vertical")) return null;
    const first = readNode(node.first, depth + 1, `${path}-first`);
    const second = readNode(node.second, depth + 1, `${path}-second`);
    if (!first) return second;
    if (!second) return first;
    let id = typeof node.id === "string" && node.id.length > 0 && node.id.length <= 200 ? node.id : `dock-${path}`;
    let suffix = 0;
    while (splits.has(id)) id = `dock-${path}-${++suffix}`;
    splits.add(id);
    return { type: "split", id, direction: node.direction, ratio: clampRatio(node.ratio, .2, .8, .5), first, second };
  }

  return {
    tree: readNode(input.tree, 0, "root"),
    width: clampRatio(input.width, .2, .75, .4),
    ...(["left", "right", "top", "bottom"].includes(input.position) ? { position: input.position } : {}),
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampRatio(value, min, max, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
