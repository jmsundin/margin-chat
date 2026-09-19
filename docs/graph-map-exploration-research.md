# Exploring concepts and details in the Margin map

Research date: September 19, 2026

**Recommendation: keep one map workspace, but let people change what it represents—from named themes, to a focused set of connections, to the exact passages behind them.** Give search and browsing equal standing. Reuse the existing reader, groups, saved positions, and rendering work; prioritize scope, meaning, and provenance before adding visual complexity.

This is a research recommendation, not a validated redesign. The audit used the repository knowledge graph, current source, and existing test definitions, including uncommitted work. Primary visualization research and official product documentation informed the proposals. The local browser preview showed the signed-out landing page, so no authenticated map walkthrough or usability study was performed. No application code was changed or tests run for this report.

## What the current map already does

| Capability | Current behavior | Implication |
| --- | --- | --- |
| Semantic zoom | Four representations: territory, compact, summary, detail. | Extend the meaning of each level; more zoom stops alone will not solve the problem. |
| Reading | A selected card previews a branch quote and content excerpt, expands inline, or docks beside the map. | The existing dock is a strong starting point for source inspection. |
| Organization | Flat manual groups; groups collapse at the farthest zoom. Topics rearranges threads into eight broad categories. | Useful navigation sets exist, but these are not a workspace-specific concept model. |
| Orientation | Ancestry breadcrumbs, saved node positions, Fit, automatic layout, minimap. | Add exploration history and scope restoration around these foundations. |
| Scale | Viewport culling, spatial indexing, bounded minimap sampling, optimized drag handling. | No evidence yet that replacing the renderer should be the first investment. |

Implementation: [zoom levels](/Users/jon/src/infoverse-projects/margin-chat/client/src/components/ConversationGraphView.tsx:66), [preview content](/Users/jon/src/infoverse-projects/margin-chat/client/src/components/ConversationGraphView.tsx:172), [group collapse](/Users/jon/src/infoverse-projects/margin-chat/client/src/components/ConversationGraphView.tsx:725), [Topics action](/Users/jon/src/infoverse-projects/margin-chat/client/src/components/ConversationGraphView.tsx:1724).

The central limitation is the underlying meaning of the map. Nodes are conversations/notes or manual groups; edges represent parent–child conversation ancestry. “Coding,” “Research,” and “Planning” describe broad activities. They cannot express a concept such as “retrieval quality” that appears in multiple unrelated discussions. A branch also receives its root thread's category badge. [Edges](/Users/jon/src/infoverse-projects/margin-chat/client/src/lib/conversationGraph.ts:358), [categories](/Users/jon/src/infoverse-projects/margin-chat/client/src/lib/threadCategories.ts:10), [inherited badge](/Users/jon/src/infoverse-projects/margin-chat/client/src/components/ConversationGraphView.tsx:1625).

The current “summary” representation shows an excerpt of the latest assistant message, or note content. It does not summarize the discussion's main idea or select evidence relevant to the concept being explored. A valuable passage earlier in a long discussion can therefore remain hard to discover.

## What the research supports

| Evidence | Finding | Application to Margin |
| --- | --- | --- |
| [Pad++ semantic zoom, 1996](https://www.cs.umd.edu/projects/hcil/pad%2B%2B/papers/jvlc-96-pad/zoom-4.html) | Scale can change an object's representation; search markers and visual bookmarks help navigate a multiscale space. | At overview, show named themes and representative content. At detail, show the relevant source. Preserve selection through transitions. |
| [Search, Show Context, Expand on Demand, 2009](https://dig.cmu.edu/publications/2009-doigraphs.html) | Whole-graph overviews are not always useful for a partly known information need. Contextual subgraphs can bound complexity around a selected item. | Search directly into a local neighborhood; expand selectively instead of exposing every connection. |
| [GrouseFlocks, 2008](https://www.cs.ubc.ca/labs/imager/tr/2008/Archambault_GrouseFlocks_TVCG/) | Several useful, editable hierarchies can exist over the same graph. | Keep topic organization separate from conversation ancestry; allow users to correct groupings. |
| [Group visualization evaluation, 2014](https://openaccess.city.ac.uk/id/eprint/15379/) | Group encodings helped some membership tasks but impaired tested network tasks; prominent labels helped memorability. | Use clear labels in overview, then reduce region decoration when users trace exact connections. |
| [Mental-map review, 2013](https://eprints.gla.ac.uk/108356/) | Evidence then available did not establish a universal comprehension benefit from minimizing movement in dynamic graph series. | Preserve orientation, but allow local reflow for readability. Test return navigation instead of treating fixed coordinates as a sufficient usability solution. |
| [Obsidian official graph documentation](https://obsidian.md/help/plugins/graph) | Global and local graphs serve different scopes; local depth exposes successive connections. | Offer “Explore around this” from both map and reader, with deliberate expansion. |
| [Neo4j official scene documentation](https://neo4j.com/docs/aura/explore/explore-visual-tour/scene-interactions/) | Supports selective expansion, inspectors, grouped relationships with counts, and path exploration. | Make aggregate links inspectable and let users choose which relationship types to reveal. |
| [ResearchRabbit official search guide](https://learn.researchrabbit.ai/en/articles/12454528-how-to-search-in-researchrabbit) | Exploration grows iteratively from selected seed items, with navigation between search steps. | Let a useful conversation become the starting point for another local exploration, with a reliable route back. |

These sources justify design hypotheses. They do not establish that this exact interface will outperform Margin's current map. Product precedents demonstrate available interactions, not independent evidence of effectiveness.

## Recommended experience

Use coordinated levels within the same workspace. Scope changes through visible actions and breadcrumbs; wheel zoom remains a convenient secondary route. Users should not have to hit a narrow zoom threshold to reveal essential content.

| Level | Question it answers | What appears | Primary action |
| --- | --- | --- | --- |
| Theme overview | “What have I been thinking about?” | Named groups or concepts, a short description, unique-source counts, representative titles, and a few inspectable connections. | Open a theme. |
| Focused connections | “What is this idea connected to?” | Relevant conversations, subtopics where meaningful, explicit relationship labels, and a count of additional results. | Select a connection or expand nearby material. |
| Source detail | “Where was that said, and in what context?” | The exact message/note passage in the docked reader, surrounding context, origin, and related source list. | Read, compare, or return to the previous scope. |

An illustrative journey is **Workspace → Retrieval quality → Chunk size tradeoffs → a specific passage in a conversation**. Those are example labels, not findings extracted from this user's workspace. A second entrance is **Search “chunk size” → relevant passage → nearby discussions → broader concept**.

### 1. Give the overview meaningful content

Initially, show user-named groups with counts and representative titles, plus an explicit ungrouped set. Broad categories can remain optional filters. Keep the distinction between user collections, activity categories, and inferred concepts visible.

Later, add concepts with concise, source-linked summaries. Permit one conversation or passage to belong to several concepts. Keep a canonical source identity so appearing under two themes does not create duplicate conversations or inflated source counts. Provide rename, merge, split, and membership correction when concept editing becomes available.

A hierarchy can organize the display without claiming every idea has exactly one parent. Preserve cross-topic links. For a tiny workspace, a readable list of conversations may be a better overview than empty thematic regions.

Hierarchical topic representations are technically feasible: [BERTopic's documentation](https://maartengr.github.io/BERTopic/getting_started/visualization/visualize_hierarchy.html) demonstrates topic trees and documents at different hierarchy levels. [GraphRAG research](https://www.microsoft.com/en-us/research/publication/from-local-to-global-a-graph-rag-approach-to-query-focused-summarization/) uses community summaries for global questions. These are architectural precedents, not a recommendation to adopt either stack immediately or evidence that automated clusters equal human concepts.

### 2. Make the local view selective and reversible

Add “Focus here” to a conversation, group, and eventually concept. Start with a readable neighborhood and expose further branches, related material, or supporting sources on demand. Show hidden-result counts and an explicit expansion action so omitted material does not look nonexistent.

Store exploration scope, selection, filters, viewport, and reader position in back/forward history. Existing ancestry breadcrumbs show where a conversation was created; exploration history should additionally show how the user arrived there. Preserve authored positions separately from temporary topic layouts and local reflow.

Provide a synchronized list/outline for the same scope. It supports scanning, keyboard access, narrow screens, and known-item retrieval. The graph is most valuable when relationships are the question; the reader establishes what the sources say.

### 3. Explain every connection

Use distinct meanings for:

- **Branched from:** an existing structural relationship.
- **Discusses concept:** membership backed by identified passages or explicitly added by the user.
- **Possibly related:** a relevance suggestion, with an explanation when available.
- **Shared source:** only when explicit source metadata supports it.

Do not infer agreement, contradiction, causality, or support from similarity or spatial proximity. More ambitious relationship types should require their own source evidence and evaluation.

When a group collapses, replace its external member links with aggregate links. Retain underlying edge IDs and counts, distinguish relationship types, omit internal links from external totals, and let selecting an aggregate reveal its contributing links. Today the rendering code drops edges touching hidden group members; no aggregate edge replaces them. [Current filtering](/Users/jon/src/infoverse-projects/margin-chat/client/src/components/ConversationGraphView.tsx:819).

### 4. Make detail passage-specific

Clicking a concept should list relevant passages, not only whole conversations. Clicking a relationship should explain its basis and provide source jumps. Reuse the docked reader and existing branch anchors to scroll to a source message and highlight its quote. Preserve enough context to distinguish a question, tentative suggestion, and adopted conclusion.

Anchors need an edit-aware fallback: source ID, message/note ID, quote, offsets, and a content revision or digest. If text changes, recover the quote if possible and visibly mark unresolved anchors. Do not silently highlight unrelated text. Existing branch anchors provide much of the initial structure. [Branch anchor contract](/Users/jon/src/infoverse-projects/margin-chat/packages/workspace-contracts/types.d.mts:75).

## Delivery sequence

| Priority | Deliverable | Why first / dependency |
| --- | --- | --- |
| P0 | Search result reveal, back/return state, source jumps, correct Fit/minimap bounds. | Makes current content reachable and orientation reliable. |
| P1 | Named-group overview, focused branch view, synchronized source list, aggregate group links. | Tests overview-to-detail navigation using existing data. No automatic concept extraction required. |
| P2 | User-curated concepts and optional suggested memberships, evidence-backed concept summaries, related-item overlay. | Adds actual conceptual exploration after the navigation foundation works. |
| P3 | Broader indexing, richer relationship discovery, comparisons across concepts, saved exploration views. | Depends on measured demand, reliable evidence, and representative performance tests. |

The smallest useful release is P0 plus a focused slice of P1: **open a group, focus a conversation's branches, read its source, and return to the same place**. Preserve an ungrouped route and search throughout. Add inspectable aggregate links before treating collapsed groups as a relationship overview.

### Concrete integration points

1. **Search reveal:** search selection currently calls the general conversation selector; sidebar selection additionally issues `graphFocusRequest`. Route map search through equivalent reveal behavior and expand the result's containing collapsed group when necessary. [Search selection](/Users/jon/src/infoverse-projects/margin-chat/client/src/WorkspaceApp.tsx:2500), [sidebar reveal](/Users/jon/src/infoverse-projects/margin-chat/client/src/WorkspaceApp.tsx:2544).
2. **Focused scope:** `getFocusedConversationGraphIds()` already collects ancestry and neighboring branches. The live forest currently uses overview mode for all threads. Reuse the helper for structural focus, then extend the scene model for optional semantic neighbors. [Focus helper](/Users/jon/src/infoverse-projects/margin-chat/client/src/lib/conversationGraph.ts:152), [forest](/Users/jon/src/infoverse-projects/margin-chat/client/src/lib/conversationGraph.ts:527).
3. **Overview geometry:** `buildGraphCategoryRegions()` already describes category hubs, bounds, labels, and counts but is not called by the current map. It is a useful geometry reference, not a substitute for concept semantics. [Region builder](/Users/jon/src/infoverse-projects/margin-chat/client/src/lib/graphCategories.ts:241).
4. **World bounds:** Fit has a minimum scale of 0.38, preventing sufficiently large worlds from fitting. The minimap uses zero-based bounds despite layouts permitting negative coordinates. Share measured world bounds between both and fit the appropriate visible scope. [Fit](/Users/jon/src/infoverse-projects/margin-chat/client/src/components/ConversationGraphView.tsx:207), [minimap bounds](/Users/jon/src/infoverse-projects/margin-chat/client/src/components/ConversationGraphView.tsx:1468).
5. **Existing related suggestions:** Jev returns IDs and scores, and selecting one currently opens chat view. Add an “Explore on map” path before deriving richer edges. Current results have no evidence spans or typed relation explanations. [Result contract](/Users/jon/src/infoverse-projects/margin-chat/client/src/lib/jevAssistance.ts:18), [selection behavior](/Users/jon/src/infoverse-projects/margin-chat/client/src/WorkspaceApp.tsx:3304).

These are source-based findings to verify in an authenticated interaction pass before implementation, particularly selection and viewport behavior.

## Concept data and analysis constraints

Keep a derived exploration model separate from conversation parentage. Its minimum useful records are concept identity/label, source memberships, source references, and typed relationships. Generated records need provenance, freshness, and a distinction between suggested and user-confirmed organization. Stable IDs become important once people rename, pin, or correct concepts.

The present Jev snapshot contains **at most 40 items total, including the current item**, prioritized by recency, with bounded excerpts and at most five related results. It excludes private margin and side notes. That can power bounded suggestions, but it cannot honestly represent complete workspace coverage. [Snapshot and result limits](/Users/jon/src/infoverse-projects/margin-chat/client/src/lib/jevAssistance.ts:49).

A later complete concept overview needs incremental indexing, coverage/freshness indicators, and clear behavior for unprocessed material. Preserve current assistance preferences and exclusions. Manual groups and structural exploration should remain useful when analysis is off or unavailable. Avoid per-zoom model calls; generate or refresh derived content when sources change, with explicit refresh where appropriate.

## How to validate the recommendation

Compare the current map, the proposed coordinated experience, and a searchable outline using the same representative content. Include small workspaces, dense branch trees, overlapping themes, ungrouped items, long discussions, and edited/deleted evidence. Separate seeded tasks with known answers from open-ended discovery. Counterbalance task order to reduce learning effects.

| Task | Measure |
| --- | --- |
| Identify the collection's main themes. | Coverage, incorrect generalizations, time, confidence versus accuracy. |
| Find a discussion from an imprecise recollection. | Retrieval success, time, reformulations, unnecessary navigation. |
| Find the passage behind a displayed connection. | Correct source selection and correct explanation of the relationship. |
| Trace how a discussion branched. | Lineage accuracy; confusion between structural and semantic edges. |
| Explore elsewhere and return to an earlier passage. | Successful context recovery, repeated searches, lost selection/scroll state. |
| Discover a connection across groups. | Useful findings and unsupported relationships inferred. |
| Complete these paths using the keyboard/list. | Equivalent content access and completion, without canvas-only actions. |

Set quantitative targets after recording a baseline. More clicks, zooming, or time on the map are not success measures by themselves. For semantic features, separately measure membership quality, missing concepts, false relationships, source-anchor accuracy, and analysis coverage. Track interaction latency and rendering work with representative large fixtures before deciding whether another renderer is needed.

For implementation, add focused checks for aggregate-edge counts, search revealing hidden items, scope/history restoration, world bounds, and source-anchor recovery. Existing tests already cover zoom sizing, collapse, breadcrumbs, culling, gestures, minimap sampling, and layout behavior; those checks establish mechanics, not conceptual understanding. [Graph tests](/Users/jon/src/infoverse-projects/margin-chat/tests/conversation-graph-view.test.tsx:338).

The design decision to test first is whether users can move from a meaningful group to an exact passage and back with less effort and fewer mistakes. A successful result establishes the navigation foundation. Validate demand, coverage, and evidence quality before investing in automatic concept discovery.
