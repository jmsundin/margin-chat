# Refactoring review

Reviewed the client orchestration, workspace serialization and recovery, API routing, chat streaming, and existing tests. This pass preserves the work already in progress on Markdown workspaces, cloud revisions, and the sidebar.

The largest maintenance problem is the concentration of unrelated responsibilities in `client/src/App.tsx`. Its 5,783 lines mixed authentication, saved-state recovery, search, model context, streaming, persistence, and layout. This pass reduces it to 5,072 lines and introduces independently testable boundaries.

## Changes made

| Finding | Change |
| --- | --- |
| Saved-state recovery was embedded in the React entry point. | Moved hydration, account-specific storage keys, and stored-state loading to `client/src/lib/appState.ts`. Preserved legacy defaults, root selection, and note content. |
| Thread summaries scanned all conversations again for each root; search also ran while its dialog was closed. | Moved queries and their result type to `client/src/lib/conversationSearch.ts`. Group conversations by root once per summary build, skip closed-dialog search, and reuse summaries for empty queries. |
| Building model context depended on a function closed over component state. | Added `client/src/lib/chatContext.ts` with explicit conversation inputs. Tests cover ancestor cutoffs, new branches, standalone notes, and exclusion of private margin annotations. |
| The stream reader kept its lock after completion and did not cancel the response after parsing or callback failures. | Added `client/src/lib/chatStream.ts`, cancellation on failure, and unconditional lock release. Kept the original error if cancellation also fails. Existing imports of `ApiError` and `ChatReplyResponse` remain compatible. |
| Unused layout code obscured the active implementation. | Removed the unused anchor-alignment helper, graph-layout application path, associated merge helper, and unused imports/constants from `App.tsx`. Moved tree recovery/traversal helpers to `client/src/lib/tree.ts`. |

## Recommended next steps

1. **Extract workspace persistence.** `WorkspaceApp` still coordinates startup recovery, a pending-save queue, cloud revisions, reconciliation, and manual backup through shared refs. Put that lifecycle behind a dedicated hook/controller. First add deterministic tests for editing during reconciliation, concurrent writes, revision conflicts, and logout during a pending request. Preserve the current local-master policy explicitly.
2. **Share workspace transformations.** `client/src/lib/workspaceModel.ts` and `server/db/workspaceDocument.mjs` implement overlapping document conversions. A shared runtime module with a typed client interface would reduce contract drift. Extend the existing parity tests before moving this code, especially around annotation ordering and invalid documents.
3. **Separate authentication from workspace loading.** The production entry bundle remains about 1.11 MB minified (359 KB gzip). Profile a lazy workspace boundary and editor/view boundaries. ELK and Mermaid already use dynamic imports, so further splitting should target the remaining entry bundle and be measured against login and first-open behavior.

## Verification

- Baseline: 126 tests passed and the production build succeeded.
- After refactoring: 142 tests passed, including 16 new tests; the production build succeeded.
- The three new stream cleanup tests failed against the old reader and passed after the fix.
- Compared original and refactored search behavior in 300 checks across 50 generated workspaces, including nested branches, tied timestamps, standalone notes, and empty searches. Results matched.
- `git diff --check` passed. The build's existing large-chunk warning remains.
- An optional `tsc --noUnusedLocals` audit still reports existing unused symbols in `ChatPanel.tsx`, `ConversationGraphView.tsx`, and `graphAutoLayout.ts`; the project's configured TypeScript check passes.

Validation was local and automated. Live browser interactions, provider calls, and external database operations were not exercised.
