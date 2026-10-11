/**
 * Map view opens on Clusters the first time an account sees it. These
 * harnesses exercise the grouped presentation that was the first view before,
 * so they start each account as if it last left Map view there.
 */
export function startMapsInGroupedView(storage: Storage) {
  const getItem = storage.getItem.bind(storage);
  // The fields of the old first view; everything else takes its default.
  const grouped = JSON.stringify({ viewport: { x: 0, y: 0, scale: 1 }, scope: { kind: "all" }, documentViewMode: "topics",
    overviewPresentation: "map", groupOverviewVersion: 1, documentLayoutVersion: 1 });
  Object.defineProperty(storage, "getItem", {
    configurable: true,
    value: (key: string) => getItem(key) ?? (key.startsWith("margin-graph-last-view:") ? grouped : null),
  });
}
