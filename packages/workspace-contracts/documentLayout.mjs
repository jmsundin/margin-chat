/** Optional display preferences must never prevent recovery of document content. */
export function normalizeDocumentLayout(input, rootId, conversations) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !Array.isArray(input.order) || !Array.isArray(input.minimizedIds)
    || !Object.hasOwn(conversations, rootId) || conversations[rootId].parentId != null) return undefined;

  const membership = new Map([[rootId, true]]);
  function belongsToFamily(id) {
    const path = new Set();
    let current = id;
    while (typeof current === "string" && Object.hasOwn(conversations, current)
      && !membership.has(current) && !path.has(current)) {
      path.add(current);
      current = conversations[current].parentId;
    }
    const belongs = membership.get(current) === true;
    for (const visited of path) membership.set(visited, belongs);
    return belongs;
  }
  const normalizeIds = (ids) => [...new Set(ids.filter((id) => typeof id === "string" && belongsToFamily(id)))];
  const widthsById = input.widthsById && typeof input.widthsById === "object" && !Array.isArray(input.widthsById)
    ? Object.fromEntries(Object.entries(input.widthsById)
      .filter(([id, width]) => belongsToFamily(id) && typeof width === "number" && Number.isFinite(width))
      .map(([id, width]) => [id, Math.max(320, Math.min(980, width))]))
    : {};
  return {
    order: normalizeIds(input.order),
    minimizedIds: normalizeIds(input.minimizedIds).filter((id) => id !== rootId),
    ...(Object.keys(widthsById).length ? { widthsById } : {}),
  };
}
