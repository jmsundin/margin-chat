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
