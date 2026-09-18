# Refactoring implementation — September 18, 2026

Implemented the first pass across the eight areas identified in the review. The changes separate state transitions, request lifecycles, shared formats, and interaction logic while retaining existing Markdown recovery and paid-request behavior.

## Changes

| Area | Result |
| --- | --- |
| API routing | `server/routes/registry.mjs` defines 32 routes for the shared handler. One `api/handler.mjs` deployment adapter and an explicit nested-path rewrite replace 24 wrappers. Request bodies remain intact for uploads and signed webhooks. |
| Workspace orchestration | `App.tsx` now contains the authentication/billing shell and loads `WorkspaceApp.tsx` lazily. `workspaceCommands.ts` provides pure transitions for creating roots and children, deleting threads, and appending messages. Summaries are memoized; backup-size calculation runs only while the profile is open. |
| Chat lifecycle | `chatExecution.ts` owns pending requests, buffered deltas, stop/delete/unmount cleanup, and stale-callback protection. Server execution separates HTTP streaming from credit reservation, refunds, and trial accounting. Cancellation reaches provider requests, stream readers, agent rounds, and retrieval embeddings. |
| Workspace formats | `packages/workspace-contracts` owns the JSON and Markdown codecs and domain types. Client recovery and strict server validation use explicit policies. The generated server codec and its build step are removed. |
| Persistence | The incremental renderer reuses unchanged documents between immutable editor snapshots. Navigation alone no longer triggers authored-file saves. Local storage reuses verified blobs and hashes within a locked operation, then clears that cache so later operations still detect corruption. BOM-prefixed text has a regression test for byte identity. |
| Graph interaction | A controller owns pan, node drag, and marquee gestures, coalesces pointer updates, and handles cancellation. Drag previews use bounded spatial neighborhoods; release retains the full layout settle. |
| Message annotations | Plain-text and Markdown adapters share decoration types, overlap partitioning, and invalidation keys. Branch-title changes update labels; note identifiers remain distinct from branch identifiers. |
| Capture contracts | Client and extension responses pass through shared runtime parsers. Malformed session data is rejected, malformed capture receipts remain retryable, and supported legacy optional fields and additive response fields remain compatible. |

Development commands still use Bun. `bun run dev:server` starts Node's watch mode because Node's HTTP disconnect events match the production runtime; cancellation is verified against a real local Node server.

## Validation

- **359 tests passed**, with 1,692 assertions across 59 files; the baseline was 265 tests.
- Production client build and extension build passed. The client build includes its configured TypeScript check.
- An isolated Vercel build confirmed that the rewrite matches every registered API path, including nested routes. No deployment or cloud configuration was changed.
- Browser checks using a local fixture covered login, lazy workspace loading, streamed replies, stopping output, note editing, graph dragging, and saved-note recovery after reload.
- Golden comparisons cover incremental versus full Markdown output, external edits and renames, custom YAML and CRLF, existing relationship aliases, annotation changes, malformed metadata recovery, and binary companions.
- Graph tests cover final pointer coordinates, cleanup, and bounded preview work with 10,000 distant nodes. Annotation tests exercise both rendering adapters, keyboard actions, and title-only updates.
- `git diff --check` passed.

## Measurements and remaining boundaries

The production entry bundle decreased from **1,152.48 kB to 217.44 kB minified**, or **375.64 kB to 67.46 kB gzip**. The workspace is now a separate **938.66 kB** chunk. This reduces the entry bundle's parsing work; the service worker still precaches application assets for offline use, so this is not a claim about total downloaded bytes. The existing large-chunk warning remains, including the ELK chunk.

A local synthetic benchmark with 1,000 chats, 10,000 messages, and 9.23 MB of Markdown measured a single-conversation edit at a median **2.03 ms** for incremental rendering versus **32.60 ms** for full rendering. These are renderer-only timings after warmup, not end-to-end save latency.

External snapshots, conversation structure/title changes, and workspaces containing managed plain Markdown use the full recovery path. These conservative fallbacks preserve source formatting and inherited settings. Incremental rendering assumes the application's immutable state updates.

`WorkspaceApp.tsx` still coordinates substantial UI behavior. Further work can extract focused feature controllers and split editor/view chunks after measuring first-open latency. Full graph settling on release remains proportional to the complete scene and is a separate optimization opportunity.

Live provider calls, production deployment, and external database operations were not exercised. No commits or deployments were made.
