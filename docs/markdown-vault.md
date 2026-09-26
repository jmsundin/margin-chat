# Markdown vault

Margin Chat saves workspace content as Markdown and synchronizes individual files. Each browser keeps an independent local copy; Postgres workspace tables are derived from committed cloud files. Account, billing, API-key, and capture-inbox records still live in Postgres. This change does not introduce a graph database or a separate search service.

## Storage setup

For Vercel, create a **private** Blob store in the project's Storage tab and connect it to the deployment environments that should use it. The current Blob SDK supports project-provided `BLOB_STORE_ID` with OIDC authentication, or `BLOB_READ_WRITE_TOKEN`. Keep both server-only. The adapter uses private reads without the Blob cache and conditional writes for the vault manifest. See [Vercel private storage](https://vercel.com/docs/vercel-blob/private-storage).

For local development, set this in your untracked `.env`:

```dotenv
VAULT_STORAGE_DIR=.margin-chat-vault
```

The directory is a durable local object store, relative to the server's working directory. It takes precedence over Blob credentials. **Do not set it on Vercel:** function filesystems are not the durable vault; the server explicitly rejects this combination. A locally configured server remains reachable only while it is running and reachable by the client.

Keep the existing Postgres configuration for authentication and features. With no vault storage configured, local Markdown saving still works, but cloud file synchronization reports that setup is required. Legacy state writes remain available only for accounts that have not migrated and while vault storage is unconfigured. Removing Blob configuration does not re-enable them for migrated accounts. Cloud synchronization retains the existing paid-plan/admin requirement; local editing and vault export are available to other signed-in users.

Use `bun run dev` for normal development. The browser, Node development and production servers, and Vercel build import the canonical native ESM codec from `packages/workspace-contracts`. Edit that package directly; no generated server copy or codec build step is required. Both `dev:server` and `start:server` use Node; the development command enables watch mode. See `packages/workspace-contracts/README.md` for its explicit strict and recovery document-read policies.

### Verify cloud activation

`bun scripts/test-cloud-vault.mjs` is an opt-in test against the configured private Blob store. It uses the actual storage adapter and sync engine with two simulated devices, checks concurrent saves, conflicts, history, deletions, binary files, and private access, then deletes its own uniquely prefixed test objects. It does not read application accounts or access Postgres. This is separate from `bun run test`, which runs without cloud credentials.

For OIDC, the store must allow the environment represented by the token. Pulling Preview environment variables locally does not make a Development token eligible for Preview access. Run the test in an authorized environment; do not commit credentials. The exported `runCloudVaultTest` function can also be bundled into a temporary authenticated Preview function for testing. Remove that deployment afterward.

The adapter requests uncompressed, uncached responses so each manifest body arrives with its strong ETag. Compressed Blob responses may return weak ETags, which cause conditional saves to fail even without competing edits. Keep the body and ETag from the same read; a separate metadata lookup can pair an old body with a newer validator.

## Portable files and derived data

The logical vault contains:

- `.md` documents: notes, conversations, annotations, stable IDs, and authored relationships. New filenames start with the document title and include a short, stable identity suffix, so documents with the same title created offline stay separate. Notes and annotations live in `Notes/`; conversations live in `Chats/`.
- `workspace.json`: companion settings such as groups, pins, and layouts. It does not contain a duplicate copy of message/note text. Active navigation stays on the device.
- `Attachments/<id>/`: original attachment bytes and a `metadata.json` descriptor.
- `_conflicts/<id>/`: saved alternative versions, automatic results, and recovery metadata.

Cloud storage contains immutable file revisions and a manifest mapping logical paths to current revisions or deletion records. Browser OPFS stores hash-named Markdown/binary history files and a reference index. Downloaded ZIPs and connected folders expose logical paths. Cloud sync history and deletion records are durable bookkeeping, not derived Postgres indexes.

Generated Markdown keeps application metadata in the YAML header's `margin-chat: |-` field. This field contains a JSON registry for document settings, history, blocks, and messages; the visible Markdown remains the source of their current text. The body uses short paired comments such as `<!-- margin-chat-block "block-id" -->` and `<!-- margin-chat-block-end "block-id" -->` to keep edits attached to the right block, including when paragraphs move. Messages use `margin-chat-msg` pairs. Document and attachment boundary comments remain. Preserve the header and identity comments when editing in another app; ordinary prose, headings, links, and formatting can be edited directly.

Custom YAML fields and source bytes outside app-edited fields remain intact. Parent, child, annotation, and linked-document relationships use readable wiki links, and attachments use relative Markdown links. Renaming an app-managed document updates its filename and incoming managed links while keeping its stable identity and previous path aliases. A filename chosen in another app is retained when its title changes in Margin Chat.

The current manifest format is version 4; version 3 manifests and the earlier JSON-bearing body comments remain readable. Existing files are preserved on read, and an authored edit can migrate a legacy file to the header format. A compatibility comment in the header makes older clients reject the new format rather than mistake it for an ordinary note. Reload older Margin Chat tabs before editing newly formatted files. Plain Markdown imports remain supported and receive a stable identity without requiring the generated document structure.

Saving content updates Markdown before projection. Postgres rebuilds workspace rows from those files and restores original attachment records from the vault. Attachment embeddings are regenerated on demand when a restored attachment is used, with the user's permitted embedding credentials. A failed index operation leaves the original intact and does not publish a successful projection checkpoint.

Projection checkpoints also record each attachment's metadata and original revision. Ordinary edits read and restore only changed attachments; an explicit rebuild reads all originals. The revision check covers both the content and attachment checkpoint, so a concurrent projection cannot make skipped originals stale. Attachment deletion uses the same guarded projection and removes stale derived links without rewriting another device's Markdown.

If a deletion reaches the vault but its database projection fails, the API reports a retryable error. Retrying the same deletion finishes the pending projection; it does not recreate the original. Vault JSON responses stream in bounded chunks so manifests saved before the current size limit can still be downloaded and recovered.

Portable attachment IDs remain unchanged in exports and imports. Database identities are scoped by account, so importing the same archive into another account does not collide with the source account's attachments. Migration `0005_attachment_projection_identity` adds this mapping and the attachment revision map while preserving existing internal keys, original bytes, and document search indexes. Migration `0006_attachment_checkpoint_revision` binds that map to its projection revision. Preserve the already-applied migration checksums and apply pending migrations with the release workflow before deploying the updated server.

The migration accepts writes from the previous server while it is still serving before promotion. Once the updated server creates an attachment, including an ordinary upload, its scoped internal ID requires a server that understands `public_id`. Rolling back to an older server after that point can make attachment lookup fail and leave projection retries blocked by the new uniqueness constraint. Existing legacy attachment keys remain readable by the previous version, but this does not make the whole release safe to roll back.

Keep `compatibility.automaticAppRollback` disabled for this transition. Resolve post-promotion failures with a forward fix that retains support for both legacy and scoped IDs. If automatic rollback is required, first deploy a compatibility version that can read and write both identity forms before enabling scoped attachment creation. Do not revert the database or rewrite portable vault IDs to make an older server accept the new records.

An authenticated paid/admin account can request `POST /api/vault/rebuild` with JSON `{}` to rebuild its cloud content projection. API requests may include `X-Margin-Vault-User` with the expected account ID to prevent a stale tab using a different signed-in account. The operation does not recreate account/billing records and does not require deleting the database. An older projection cannot replace a newer one, even during an explicit rebuild.

## Migration and synchronization

On first use, the browser imports its previous local workspace snapshot into the local vault. The server initializes an empty cloud vault from its existing Postgres workspace and available original attachments before accepting device changes. Once configured, `/api/state` reads from Markdown and rejects legacy whole-workspace uploads. Reload older clients after rollout.

Different legacy copies have no proven common base. The current cloud version remains active, and divergent device content is preserved as an optional recovery version. Existing Postgres data is retained as a projection; there is no destructive database migration. Migration cannot recover attachment bytes that were already deleted or never retained by an older installation. Such originals must be recovered from an independent copy or attached again.

Each edit retains its actual base revision. Independent file edits synchronize separately. Competing Markdown changes use a three-way merge of the shared base, device version, and cloud/current version. Stable document blocks are matched before merging their text, so independent changes can survive in the same document. Overlapping edits that cannot be combined safely use the cloud/current text for the ambiguous region while preserving the alternatives. The merge does not ask the user to choose or add conflict markers to their document.

Passage links, annotations, and branch anchors follow surviving text through a merge. If a passage was deleted or cannot be identified unambiguously, its historical quote is retained with a detached anchor. Pending generation replacements and undo restoration positions are also rebased so they cannot overwrite unrelated text; historical prompt selections remain unchanged.

Three-way refers to those three versions, not a device limit. Each device keeps its own acknowledged base and merges against the latest cloud revision. Conditional writes reject a stale result; the device rereads and merges again without replacing newer local typing. This supports any number of devices through successive merges. Independent edits converge regardless of reconnect order. Ambiguous wording follows the cloud version already committed, so its visible choice can depend on reconnect order, with all alternatives retained. A busy cloud can exhaust one sync attempt's bounded retries; local edits remain pending for the next automatic attempt.

Automatic merges retain the available base, original device and cloud/current versions, and result under `_conflicts/<id>/`, including when every change merged cleanly. Recovery files are saved locally before the atomic index changes and uploaded before the merged working documents. These files are included in vault downloads and synchronization. Ambiguous versions appear under **Alternative versions saved** after all their recovery files arrive, including on another device. Reviewing them is optional: editing and sync continue without opening or dismissing them. Restoring a saved version replaces the entire file, not just its ambiguous edits; restoring a saved deletion removes the file. A restore is allowed while the current file matches either the saved result or the cloud input that preceded it; this also supports recovery when an upload stopped before publishing its result. Any different newer writing is protected from replacement. **Dismiss · keep current file** leaves the active file and portable recovery copies intact; dismissal is remembered on this device. Existing local recovery records remain available through the same optional controls.

Unknown ancestry, binary attachments, unsupported or unsafe document structures, and changes exceeding the bounded merge budget use a conservative fallback: retain the cloud or currently active file and save the competing version for recovery. Deletions create tombstones and remain deleted when a competing offline edit arrives; that edit is saved for recovery without silently resurrecting the document. Immutable history currently has no automatic pruning policy.

Markdown renames retain their stable document identity. The old-path change and new-path change are published in the same cloud commit, including connected swaps or rename chains, so another device never sees half of a rename. Competing edits and renames reconcile at the surviving cloud path, with alternative versions saved when needed. A connected set of renames that exceeds a single server commit's limits remains local until it can be synchronized safely.

The app checks for changes while open and on focus/reconnection, and scans a connected folder before writing it. Folder access is limited to browsers supporting the directory picker. Folder scans reconcile external changes automatically, with alternative versions preserved when needed. If the folder changes again during a write, the write stops and preserves those files for the next scan.

The browser retains each connected folder's last incorporated Markdown and companion-file snapshot in its atomic local vault index. The baseline follows the actual directory handle, not its name, and survives reopening: external renames and deletions are reconciled against the last observed files. Switching folders selects a separate baseline; a new empty folder is an output destination. Existing connections with no stored baseline are conservatively imported on their first scan. These directory baselines stay on the device and are excluded from cloud synchronization and ZIP exports.

## Offline use, export, and limits

Production builds include a service worker that caches only the application shell and built assets. It never caches `/api` responses. HTML is paired with its exact asset generation; an update waits until older controlled tabs close. Development mode does not register this worker. First load must finish online before the application can reopen offline.

Local Markdown uses OPFS and Web Locks. The app requests persistent browser storage, but a browser may decline or evict data. On iPhone these files are private to the site, not a shared Files/Obsidian folder. Clearing site data removes the local vault and cached identity. Local files can reopen with a remembered account while offline; server requests still require a valid session. There is no background synchronization promise while the app is closed, and model calls/new server-side document ingestion require connectivity.

**Download vault** exports current Markdown, companion metadata, available originals, and recovery copies to ZIP. It attempts to fetch any referenced original that has not yet been cached; a missing original blocks a supposedly complete export. **Import vault** adds/reconciles files and preserves collisions. ZIP exports contain current files and recovery copies, not every historical cloud revision or a replica of account data.

Imports match stable Markdown identities to existing documents even when an older archive uses a different filename. Current writing remains current; divergent imported text becomes an optional saved alternative instead of a second document with a duplicate identity. Both original versions are preserved in portable recovery files. The complete prospective workspace is validated before a local durable index is replaced, including imports, folder scans, saved-version restoration, and downloaded cloud changes.

Current limits are 3 MiB of decoded content per JSON commit (4 MiB HTTP JSON-body cap), 4 MiB per raw binary upload, 10,000 manifest paths including retained tombstones, and 2 MiB of serialized manifest metadata. The metadata limit is checked before uploading bodies or publishing a revision; it leaves room for conflict responses, including long Unicode paths. The client sends smaller batches. ZIP imports allow 100 MB compressed, 200 MB expanded, and 20 MB per entry; importing a larger individual file does not make it eligible for cloud upload.

The local object-store adapter uses `.lock` directories. If a crashed development process leaves one behind, first stop **all** servers using that vault directory, verify the lock is abandoned, and remove only that lock directory. Never expire a lock while another writer may still be active.

Capture intake remains in the existing Postgres inbox. Opening a capture as a workspace note makes that note part of the Markdown vault; the inbox itself is not included in a vault export.

## ChatGPT history

**More → Bring your chat history** imports selected conversations from a ChatGPT export into this vault. Preview is local; the import uses the same durable saves and synchronization as authored chats. See [Chat history import](chat-history-import.md) for supported files, duplicate handling, undo, and limits.
