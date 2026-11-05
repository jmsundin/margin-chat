# Vault sync

The folder interface the vault engine runs on, shared by the browser and the
desktop app. `index.d.mts` documents `VaultFs`; `index.mjs` holds path checks
and an in-memory folder used in tests and as reference behaviour.

Adapters:

- Browser folder (File System Access): `client/src/lib/vaultFsAccess.ts`.
- In memory: `createMemoryVaultFs` here.
- `node:fs` for the desktop main process: phase 1 (see
  `docs/desktop-vault-sync.md`).

Every adapter must pass `tests/helpers/vaultFsConformance.ts`. The Markdown
codec stays in `packages/workspace-contracts`; import it, never copy it.
