# Map search, previews and explored history

The map has one search box ("Search, ask, or paste a link…") instead of separate My map, Public and Map a URL modes. It reads what was typed and offers the matching kind of lookup. Whatever a lookup finds appears on the user's own map as dashed previews until the user keeps or removes them.

## What the search box does

- **Words**: matching documents come first. Under **Look further**, the top Wikipedia articles each offer **Preview**, followed by a full-text Wikipedia search link and **Ask AI**.
- **A question** (ends in `?` or starts with how, what, why…): **Ask AI** comes first. Enter asks it.
- **A web address**: **Map this page** (members) reads the page and previews its main topics; **Save as a source note** (free) adds a linked note; the host link opens the page.
- Enter with no matching document previews the first Wikipedia article; with a match it opens that document.
- Pasting a link anywhere on the map (outside a text field), or dropping one onto it, fills the search box.

## Previews

- Previews are drawn as dashed cards with dashed lines. They sit beside the document they relate to: the search's top match, or a document whose title the search mentions. Otherwise they sit in open space to the right of the map.
- Each card opens its details and has **Keep** (✓) and **Remove from the map** (×). The bar at the bottom counts previews not in the workspace and offers **Keep all** and **Clear from map**.
- Details offer **Keep in my map**, **Keep without connecting** (when anchored to a document) and **Remove from map**. A Wikipedia topic shows its connections, its Wikipedia summary and members' shared answers. A page shows its summary, supporting passage and source. An AI answer shows the answer. Pages and answers have a private **Ask AI** form.
- **Keep** turns a preview into a note. A Wikipedia topic is saved as a topic note and connected to what it was found from; a page topic as a source note; an AI answer as a child note of its document. Keeping a preview whose parent is also a preview keeps the parent as well.
- Previews are never removed automatically. Removing one from the map only hides it; it stays in history.
- A document's node menu has **Show what's around it**, and its globe action shows the Wikipedia topics around it.

## Explored history

- The clock button beside **+** (Add) opens everything explored and not kept, grouped by search, newest first. Each item can be shown on or hidden from the map, kept, or forgotten. Each search can be hidden, kept or forgotten as a whole. **Clear history** asks first.
- Kept items leave history. If a kept note is deleted, its previews stay in history without a parent.
- History is saved on the device and, for signed-in accounts, in the account record that held the old public map (`/api/public-map/state`), so it follows the user across devices. The old public map's topics move into history once.
- History keeps the newest 400 items and the newest 20 mapped pages. When it is full, the oldest items that are not on the map go first. Pages with something still on the map are kept.

## Verification

Run `bun test tests/map-exploration.test.ts tests/map-exploration-interactions.test.ts` and `bun run build`.

For browser checks, `bun tests/helpers/serveUrlMapPreview.ts` serves a fixture workspace at `http://127.0.0.1:5184`. It answers AI questions and keeps the account record in memory, one per `?user=` value. Try `https://example.org/trees` for a page. URLs containing `slow` exercise Cancel, and URLs containing `failure` exercise errors. Wikipedia requests go to the real site unless the browser mocks them.

## Explore mode

**Explore** in the map toolbar swaps the person's own map for a scratch map of any topic. Nothing in it reaches the workspace until a node is saved. **My map** (or Escape) goes back.

- An empty explorer shows a topic search with suggested topics and recent document titles underneath. For members with AI, the results list has two parts: **AI** first (AI's best-matching topics, asked once typing pauses for 0.9 s; each search is remembered so the same words are not asked twice) and **Wikipedia** articles underneath (articles AI already named are not repeated). Enter picks the top AI topic, else the top article. A picked topic becomes a starting node; more can be added from the search in the bar.
- Clicking a node opens a small menu: **Wikipedia subgraph** adds the article's main linked topics (broader topics and topics already on the map are left out; pressing it again reads the next page), **AI subgraph** asks AI for the topic's subtopics (members with AI; each ask names what is already there), **Save to my map**, **Save with its branches**, **Read on Wikipedia** and **Remove**.
- Saving uses the same code as keeping previews: the node becomes a topic note, along with the nodes that lead to it, each connected to its parent. Saved nodes show "In your map".
- **Arrange** picks how the same topics are drawn: **Tree** (branches right and left of each starting topic), **Radial** (each branch a cluster around its starting topic), **Network** (force-directed), **Grid** (rows in branch order; only the chosen topic's lines show), **Focus** (TheBrain style: one topic in the middle, parent above, branches below, siblings to the right; clicking a topic moves it to the middle) and **Canvas** (drag cards anywhere; starts from the arrangement on screen).
- Drag empty space to pan, wheel to scroll, pinch or Ctrl+wheel to zoom.
- The explorer is kept on the device (`margin-topic-explorer:<workspaceKey>`, plus `:canvas` for dragged spots) until **Start over**. Code: `client/src/lib/topicExplorer.ts`, `client/src/components/TopicExplorer.tsx`. Tests: `tests/topic-explorer.test.ts`.

### Reading panes

- **Read on Wikipedia** in a node's menu opens the article in a pane on the left of the explore map, looking like the mobile Wikipedia page: Wikipedia's mobile page HTML and its own stylesheets (light or dark, following the app's theme), images and infobox included. It sits in a frame that shares Margin Chat's origin but runs no scripts (`sandbox="allow-same-origin allow-popups…"`), and the HTML is cleaned first (`sanitizePageHtml` in `client/src/lib/wikipediaReader.ts`: scripts, event attributes, frames, forms and non-Wikimedia images removed; images Wikipedia loads with script become plain images). That lets the pane read selections and draw marks inside it. Links to other articles open in the same pane, footnote links scroll to the note, and **↗** opens the article on wikipedia.org.
- Selecting article text shows the documents' selection toolbar (`SelectionToolbarRow`): **Margin note** and **Highlight** (More) are pinned beside the passage with a margin marker and stay in Explore (`margin-topic-explorer:<key>:passages`) until **Save to my map**. **Side document** makes a vault document with the quote and source, under the article's saved topic note when there is one, and opens it in a second pane. **Explore** adds the selected words as a topic under the article's node. **Copy**, **Explain** and **Ask AI** (members) are also offered. An answer appears beside the passage and can be saved as a document, or its topics can be added to the map.
- **Document** in the bar opens any of the person's documents in a pane with the full editor. A saved node's menu offers **Open the note beside**. On phones one pane shows above the map at a time.
- **AI subgraph** opens an optional prompt ("what about this topic should it cover?"). Each request also sends the node's path from the starting topic, its siblings and its existing branches (`aiSubgraphContext`), so the subtopics fit the direction being explored.
