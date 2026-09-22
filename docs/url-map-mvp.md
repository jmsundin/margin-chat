# Map a URL

Graph view → **Map a URL** reads one public webpage and creates a small AI-generated topic map. The optional focus guides concept selection. The form collapses after success to leave room for exploration.

- Select a topic to inspect its summary and supporting passage. Select a relationship to see its direction, source passage, or explicit AI-inference label.
- Overview cards retain readable titles and hide secondary text/actions. At working zoom, each topic has top-right actions to explore the source's links or add the topic to My map; these actions are always available in details. Fit respects the minimum readable footprint, so larger maps remain pannable on narrow screens.
- Zoom retains the focal point; touch supports one-finger pan and two-finger pinch. With the canvas focused, arrows pan (Shift doubles the step), +/− zoom, and Home or 0 fits.
- Details resize or collapse on desktop and form a collapsible bottom sheet on mobile, keeping map context visible.
- Adding saves only that topic as an editable note with source URL, page title, retrieval date, summary, evidence, and attributed relationships. The user stays in the URL map. The action becomes **Show in my map**; repeating it reveals the same note without overwriting edits.
- **Explore linked pages** lists links found in the readable source. **Map page** builds another single-page map using the selected topic as its focus. Previous/Next returns to maps already built. This version does not crawl links automatically or merge multiple pages into one graph.
- **Find public topic** opens the existing public-map search. It does not assume a same-named Wikidata topic is an identity match.
- The last eight page maps are retained in account-scoped session storage. Saved topic notes use the normal Markdown vault and sync paths. The full graph is not a durable cross-device workspace object yet.

## Implementation

`POST /api/graph/url` uses the shared API registry, session authentication, expected-account validation, and request cancellation. The response is NDJSON with `progress`, `done`, or `error` events. The existing chat execution service performs generation, honoring provider restrictions and hosted usage metering. Only page text and the optional focus are supplied; personal workspace context is excluded.

The reader requests HTTP(S) text using Node's HTTP client, validates every DNS answer and redirect, and pins the validated address for the connection. It does not send cookies, run scripts, or load page subresources. Downloads are limited to 1.5 MB with a 20-second deadline and four redirects. Readability extracts article content with a text fallback. At most the first 12,000 readable characters and 24 outgoing links are retained. Pages requiring sign-in, browser execution, unsupported encodings, or binary document extraction return an actionable error.

Generation requests 3–7 concepts and at most nine relationships. Output is validated and bounded; quotes for concepts and stated relationships must occur in the text actually supplied. The UI says that verified quote matching is not verification of the AI's interpretation. Inferences use dashed edges and have no purported source quote. Invalid or unsupported items are omitted, and unusable outputs report an error. Total map execution has a 50-second deadline; concurrent work is bounded per process and per user.

Topic identity is a hash of the final page URL and normalized concept label. Regenerating the same label on the same page reuses its saved note, including after renaming. Different pages remain separate; changed AI concept labels can create separate notes. This MVP does not infer cross-page identity or automatically add source relationships as personal connections.

## Verification

Run `bun test tests/url-map.test.ts tests/url-map-api.test.ts tests/url-map-interactions.test.ts tests/api-deployment.test.ts` and `bun run build`.

For browser verification, `bun tests/helpers/serveUrlMapPreview.ts` starts an isolated fixture at `http://127.0.0.1:5184`. Use `https://example.org/trees`; URLs containing `slow` exercise Stop, and URLs containing `failure` exercise retry. The fixture uses the real API orchestration, extraction, validation, client, and workspace-saving path with deterministic AI output; it does not invoke a paid provider.
