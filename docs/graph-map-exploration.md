# Exploring themes and sources

The map now supports a continuous path from named topics to focused conversations and original passages. The design follows [the exploration research](graph-map-exploration-research.md).

## Using the map

The mode bar provides four primary document views. **More views** opens analysis tools; **Content** opens curated concepts or claims and evidence. Returning to Documents from Evidence restores the previous document mode.

| View | Use | Relationship meaning |
| --- | --- | --- |
| Canvas | Arrange, compare, zoom into, scroll, and edit documents in place | Saved spatial positions; branches and authored links |
| Focus | Start at the selected document and expand its neighborhood | Explicit relationships in either direction; depth can be expanded |
| Topics | Browse groups and progressively reveal their documents | Existing collections, with cross-group connection counts |
| Lineage | Follow a branch from parent to descendants | Parent → child ancestry only; never inferred dependency or taxonomy |
| Network | Find hubs and bridges; relax the layout on demand | Frozen force layout of explicit connections; drag to pin |
| Evidence | Gather passages around a concept, claim, or question | Manually assigned support, challenges, examples, questions, or references |
| Timeline | Browse creation or editing activity | Stored creation/last-edited timestamps; undated items remain available |
| Matrix | Inspect dense directed connections | Rows are sources, columns are targets; branch and authored-link cells stay distinct |
| Link flow | Compare connection counts between groups | One count per directed relationship, with inspectable underlying documents |

Mode switching retains the selected source, docked editor, search, relationship filters, and reader scroll. Each document mode remembers its camera in the current tab; Back/Forward restores complete navigation state. Lineage, Focus, and Network layouts do not write Canvas positions. Network pins are separate from Canvas positions, and pinning or moving one card leaves other cards still until the next relaxation. The older **Documents and connections** arrangements remain available as **Document layouts**.

Branch ancestry and authored links can be filtered independently. Lineage always shows ancestry; returning to another mode restores the shared filter choices. Related suggestions remain a separate optional overlay. Matrix pages both axes independently. Flow pages group pairs and uses one membership combination for documents belonging to several groups, so each relationship is counted once. Flow is a count of stored links, not a claim about causality or information transfer.

- **Overview** opens readable topic cards for concepts, groups, and ungrouped material. Activity categories remain available in the explorer; category cards also provide an overview when there are no named collections. **Show map** opens the spatial graph.
- Select a topic to see connections. Shared-source counts measure conversations present in both topics. Directed branch counts measure conversation ancestry crossing between topics. **Inspect** lists the original sources; these links do not imply agreement or causality.
- **Explore** narrows the map and source list to a group, concept, or category. **Focus here** shows a conversation, its ancestry, and nearby branches. **Expand branches** adds another generation.
- Zooming into a document progressively reveals its title, a content preview, and the editable document inside its map card. Continue zooming for more reading space, or use **Expand** to open it in place. Scroll inside the document to read, and edit with the same editor as document view; pinch or Ctrl/Command-wheel still zooms the map. Ordinary document scrolling stays inside the card, including at either end. A document already open in the split view keeps its editor there until that split view closes.
- Document contents load only for cards intersecting the visible canvas. Incoming cards show skeletons while the camera moves, then load one at a time after movement settles. Offscreen cards release their document contents; saved edits remain available when you return. Documents that stay visible retain their editors during panning and zooming within the same detail level.
- Selecting or expanding a conversation temporarily moves nearby cards aside. Escape, clicking the selected card again, or clicking empty canvas returns them to their original positions. Deliberate drags remain saved layout edits; temporary spacing is never saved. Motion respects reduced-motion settings.
- The explorer keeps its heading and search field visible while its lists scroll independently of the map. A new query or scope starts at the top; selecting a source or revealing more results retains the list position.
- Search titles, messages, and primary standalone-note content in the current scope. Search includes every loaded conversation and message, including older material. Lists show forty results at a time, with an explicit action to reveal more; the page size does not limit search coverage. Private margin notes are excluded.
- Select a search result, concept reference, or branch-source action to open the source reader. Matching passages are highlighted with context. If a quote moved, a unique matching occurrence can be recovered. Edited, ambiguous, and missing references are identified instead of highlighting unrelated text.
- **Back** and **Forward** restore scope, search, source selection, viewport, expanded groups, reader scroll position, and overview presentation. Navigation history is retained per account in the current browser tab, including while leaving and returning to the map.
- Collapsed groups retain inspectable external branch links with counts. Fit and the minimap account for negative coordinates and large layouts. Exploration does not rewrite authored node positions; explicit layout actions continue to do so.

## Curated concepts

Create a concept with a name and optional description. When a source is selected, creating a concept includes that source. Add further selected conversations or exact passages through **Add selected source**. Concepts can overlap without duplicating the underlying conversations. Edit descriptions, remove references, or delete a concept through the explorer.

Concepts are stored locally for the signed-in account on this device. They are not yet synchronized, exported with the workspace, or automatically generated. Deleted or stale source references remain visible for review. Storage failure displays an in-view notice.

In **Content → Concepts**, create a concept or entity and attach passages from several documents. **Evidence** uses the same canonical references around a claim or question, grouped into manually assigned roles. Search all loaded primary source text, review a result, select the exact characters to attach, and choose a role. Whole-document references are also supported and explicitly identified as having no passage anchor. Open any source in the editable dock without leaving the analytical view. Quote status updates as the source changes; moved, stale, and missing passages are labeled. Source similarity never assigns an evidence role.

The optional **Possibly related** overlay uses existing Jev suggestions when available. It is labeled separately from structural branches, identifies its active conversation, and states the existing coverage of up to forty recent items. It adds no new AI extraction calls.

Automatic concept discovery, generated evidence summaries, concept merge/split tools, richer inferred relationships, saved named exploration views, and cross-device concept storage remain follow-on work from the research roadmap.

## Verification

Behavior coverage includes overlapping memberships, account isolation, old-message search beyond forty items, safe source recovery, collapsed-edge counts, negative bounds, bounded list rendering, topic exploration, connection inspection, navigation/remount restoration, external search reveal, and source-reader focus. A loopback-only synthetic preview exercises the actual graph component without workspace data or authentication changes:

```sh
bun tests/helpers/serveGraphExplorationPreview.ts
```

Open the printed preview URL. The fixture includes negative coordinates, two groups, collapsed branches, standalone notes, an exact source passage, related suggestions, and a light/dark switch. Desktop and phone-sized layouts were checked with this fixture. Production authenticated data was not used for the visual review.
