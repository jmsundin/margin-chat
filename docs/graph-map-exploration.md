# Exploring themes and sources

The map now supports a continuous path from named topics to focused conversations and original passages. The design follows [the exploration research](graph-map-exploration-research.md).

## Using the map

- **Overview** opens readable topic cards for concepts, groups, and ungrouped material. Activity categories remain available in the explorer; category cards also provide an overview when there are no named collections. **Show map** opens the spatial graph.
- Select a topic to see connections. Shared-source counts measure conversations present in both topics. Directed branch counts measure conversation ancestry crossing between topics. **Inspect** lists the original sources; these links do not imply agreement or causality.
- **Explore** narrows the map and source list to a group, concept, or category. **Focus here** shows a conversation, its ancestry, and nearby branches. **Expand branches** adds another generation.
- Selecting or expanding a conversation temporarily moves nearby cards aside. Escape, clicking the selected card again, or clicking empty canvas returns them to their original positions. Deliberate drags remain saved layout edits; temporary spacing is never saved. Motion respects reduced-motion settings.
- The explorer keeps its heading and search field visible while its lists scroll independently of the map. A new query or scope starts at the top; selecting a source or revealing more results retains the list position.
- Search titles, messages, and primary standalone-note content in the current scope. Search includes every loaded conversation and message, including older material. Lists show forty results at a time, with an explicit action to reveal more; the page size does not limit search coverage. Private margin notes are excluded.
- Select a search result, concept reference, or branch-source action to open the source reader. Matching passages are highlighted with context. If a quote moved, a unique matching occurrence can be recovered. Edited, ambiguous, and missing references are identified instead of highlighting unrelated text.
- **Back** and **Forward** restore scope, search, source selection, viewport, expanded groups, reader scroll position, and overview presentation. Navigation history is retained per account in the current browser tab, including while leaving and returning to the map.
- Collapsed groups retain inspectable external branch links with counts. Fit and the minimap account for negative coordinates and large layouts. Exploration does not rewrite authored node positions; explicit layout actions continue to do so.

## Curated concepts

Create a concept with a name and optional description. When a source is selected, creating a concept includes that source. Add further selected conversations or exact passages through **Add selected source**. Concepts can overlap without duplicating the underlying conversations. Edit descriptions, remove references, or delete a concept through the explorer.

Concepts are stored locally for the signed-in account on this device. They are not yet synchronized, exported with the workspace, or automatically generated. Deleted or stale source references remain visible for review. Storage failure displays an in-view notice.

The optional **Possibly related** overlay uses existing Jev suggestions when available. It is labeled separately from structural branches, identifies its active conversation, and states the existing coverage of up to forty recent items. It adds no new AI extraction calls.

Automatic concept discovery, generated evidence summaries, concept merge/split tools, richer inferred relationships, saved named exploration views, and cross-device concept storage remain follow-on work from the research roadmap.

## Verification

Behavior coverage includes overlapping memberships, account isolation, old-message search beyond forty items, safe source recovery, collapsed-edge counts, negative bounds, bounded list rendering, topic exploration, connection inspection, navigation/remount restoration, external search reveal, and source-reader focus. A loopback-only synthetic preview exercises the actual graph component without workspace data or authentication changes:

```sh
bun tests/helpers/serveGraphExplorationPreview.ts
```

Open the printed preview URL. The fixture includes negative coordinates, two groups, collapsed branches, standalone notes, an exact source passage, related suggestions, and a light/dark switch. Desktop and phone-sized layouts were checked with this fixture. Production authenticated data was not used for the visual review.
