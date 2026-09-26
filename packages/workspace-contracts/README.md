# Workspace formats

This package owns the versioned workspace document, Markdown codec, and their
domain types. The `.mjs` files are the canonical, editable implementation; the
`.d.mts` files describe its TypeScript API. There is no generated server copy or
build prerequisite. Node server startup, Bun watch mode, and Vite/Vercel imports
all resolve these same modules.

- `@margin-chat/workspace-contracts/markdown` provides the Markdown codec.
- `@margin-chat/workspace-contracts/server` defaults legacy document reads to
  `strict`: orphan annotations reject the document, and empty documents are valid.
- `@margin-chat/workspace-contracts/browser` defaults legacy document reads to
  `recovery`: orphan annotations are skipped, and empty documents return `null`
  so the browser can use its existing fallback.
- Both entry points accept `{ mode: "strict" | "recovery" }` explicitly. They
  share envelope, identity, and item-kind checks, optional-field defaults, and
  note ordering. Invalid item kinds and malformed envelope arrays are rejected
  in both modes. Full field validation remains at the persistence boundary.

These legacy document policies do not change Markdown discovery: an empty vault
remains empty, and temporarily orphaned annotation files remain preserved on disk.
Markdown updates preserve original source bytes outside fields actually edited by
the app. Keep those preservation tests when changing the codec.

New Markdown uses manifest version 4, while version 3 remains readable. The YAML
header's `margin-chat: |-` field contains an indented JSON registry with
`schemaVersion: 2`, the document metadata, and block/message metadata keyed by
stable ID. The body retains authoritative Markdown text and compact paired
`margin-chat-block` / `margin-chat-msg` identity comments. Document and attachment
boundaries remain. A compatibility comment in the header prevents older readers
from silently treating the new structure as a plain note.

`encodeReadableMarkdown`, `decodeReadableMarkdown`, and `isReadableMarkdown`
bridge the readable representation and legacy JSON-bearing marker format.
Readers accept both representations. Preserve legacy fixtures and test actual
readable-source edits as well: decoding every test input would miss regressions
in external editing, newline preservation, and header updates. Reading a legacy
file leaves it intact; an authored edit can migrate it to the current format.

Generated paths start with the title and always include a short stable ID suffix.
App-managed title changes rename the file and update managed incoming links;
external paths remain stable. Path aliases preserve old relationship targets.
Test same-title offline creation, renames, external filenames, and byte
preservation alongside codec round trips.

Run `bun test tests/workspace-contracts.test.ts tests/workspace-model.test.ts
tests/workspace-markdown.test.ts tests/vault-workspace.test.ts
tests/editable-document.test.ts tests/incremental-workspace.test.ts
tests/vault-merge-anchors.test.ts` after changes.
The contract tests include native Node loading, malformed input, read-policy
differences, and browser/server byte preservation parity.
