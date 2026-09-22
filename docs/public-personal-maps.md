# Public and personal maps

The graph workspace now has **My map** and **Public** modes. Switching modes keeps each mounted map's selection, camera, and reader. Public exploration is also saved for the browser session under the workspace account key.

## Explore and collect

- Search Public for a topic, or choose a starting topic. Opening a new topic loads its first neighborhood.
- Nearby topic selections retain the camera and zoom; Center topic explicitly recenters. Back/Forward restores up to 30 navigation steps, including selection, graph, filters, and camera, during the mounted workspace session. Late topic requests are cancelled when navigating back or selecting another topic.
- Filters select types, parts, or other relationships. Wikimedia category, portal, and template links are hidden by default and can be restored with Include Wikimedia metadata. Filtering preserves loaded data, pagination, and provenance without fetching again. Counts and overview neighborhoods reflect the filtered view.
- Details & sources opens a resizable desktop dock or collapsible mobile bottom sheet. The canvas remains available beside or above it. Public search supports Arrow Up/Down and Escape; topic buttons support arrow-key spatial navigation.
- Each node's upper-right toolbar appears on hover, keyboard focus, and selection. **Expand** loads a bounded set of outgoing Wikidata relationships; **More** loads the next page. **Hide expansion** hides that branch while preserving nodes needed by other visible branches.
- **Add to my map** saves only the selected topic. It keeps Public open and changes to **Show in my map**.
- **Show in my map** reveals the existing saved node, including when its group was collapsed. Repeated saves use Wikidata identity rather than the displayed title.
- A saved personal node's globe button opens the same topic in Public. **Back to my map** returns to the previous personal view. Unmapped personal nodes offer **Find public topic** using their title as a public search query; results are not automatically treated as identity matches.

## Work in your map

- A saved public topic has **Expand with AI** and **Add child note** in its upper-right toolbar. AI expansion drafts 2–6 notes, up to two levels beneath the topic, and focuses the resulting subgraph. It uses the topic's title/description, up to 6,000 characters from that note, and existing child titles. It uses the configured AI provider and normal account billing; unrelated workspace content is excluded.
- AI-generated notes are editable drafts based on general knowledge and the supplied context. Their provenance banner distinguishes them from verified public relationships. Generated children do not inherit the parent's Wikidata identity. Cancel or a failed response leaves the workspace unchanged; retry is available. If the user switches to Public while generation runs, completion keeps Public open and the new neighborhood is revealed on returning to My map.
- **Add child note** creates a blank note with the selected node as its actual parent and immediately opens the editor. Child-note titles and content are editable. Notes without descendants can be removed and restored with Undo, including their parent relationship.
- **New note** creates an editable workspace note and reveals it on the map.
- The node's more-actions menu provides **New connected note**, **Connect to another node**, and **Open and edit**. Select the second node to complete a personal connection.
- Personal connections are labeled **My connection**, appear in focused neighborhoods in either direction, and can be inspected and removed without removing either note.
- **Add web source** creates a personal source note containing the supplied URL. It preserves meaningful query parameters and does not copy the page or identify it as a Wikidata topic.
- Notes without descendants can be removed from the node menu. **Undo** restores their content, position, connections, collections, and pin while preserving subsequent workspace edits. This immediate undo is available until another undoable map action replaces it; it is not a persistent trash archive. A deleted child is not restored if its parent was subsequently deleted.
- The reader separates the imported public description and source links from private editable notes. Renaming the note does not change its public identity.

## Identity and storage

`Conversation.publicTopic` stores canonical QID, known redirect aliases, public label/description, Wikidata and optional Wikipedia source links, retrieval time, and revision. New saved topics use deterministic IDs and an empty personal note. Repeated saves preserve the personal title, notes, links, and layout; newly learned redirects update identity metadata.

`Conversation.linkedConversationIds` stores user-created connections separately from parent/child chat ancestry. Both fields round-trip through current workspace JSON, Markdown files, ZIP exports/imports, cloud file commits, and fresh-device vault reloads. Public metadata appears in Markdown frontmatter; personal links appear under `Linked` relations. The legacy SQL adapter for clients predating Markdown vaults has not been extended.

## Public information coverage

Public search uses the [Wikidata entity search API](https://www.wikidata.org/w/api.php?action=help&modules=wbsearchentities). Known topics and outgoing item-valued statements use [entity access](https://www.wikidata.org/wiki/Wikidata:Data_access), with at most ten statements per expansion page, bounded caching, cancellation, timeout, and retry controls. The public SPARQL query service is not required. The scene limits expansion at 240 visible topics and asks the user to hide a branch to continue.

The graph shows a selection of direct relationships, not a complete graph of the internet. Dates, qualifiers, ranks, and references remain available through source links; the simplified edges should not be read as assertions that a relationship is current. Wikipedia articles are separately labeled source links when a sitelink exists. Wider-web discovery, article-link expansion, and full-page importing are outside this implementation; any web URL can be saved as a source note.

Wikidata structured data is CC0. This feature links to Wikipedia rather than copying article text or images. See [Wikimedia content reuse guidance](https://www.mediawiki.org/wiki/Wikimedia_APIs/Content_reuse).

## Validation

Automated coverage includes API redirects, pagination, cancellation, missing entities, persistence, duplicate prevention, personal-edit preservation, cloud vault reloads, focus traversal, layout stability, collapse reachability, and reversible workspace edits. AI expansion tests use mocked provider responses to check bounded trees, cancellation, request isolation, validation, and atomic note creation. The isolated preview at `tests/helpers/servePublicMapPreview.ts` uses a synthetic personal workspace, live public APIs, and a synthetic AI response for browser checks, with no access to a user's vault or paid AI calls.
