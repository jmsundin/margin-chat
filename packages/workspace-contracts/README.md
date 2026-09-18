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

Run `bun test tests/workspace-contracts.test.ts tests/workspace-model.test.ts
tests/workspace-markdown.test.ts tests/vault-workspace.test.ts` after changes.
The contract tests include native Node loading, malformed input, read-policy
differences, and browser/server byte preservation parity.
