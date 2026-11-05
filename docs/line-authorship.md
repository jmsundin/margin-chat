# Line authorship

Margin Chat records who wrote each line of every document and note in a cloud
vault, the way `git blame` does for a repository. It's the basis for letting
connected apps (MCP agents) edit what the member didn't write while never
touching what they did.

Nothing is written into the Markdown. Obsidian and the member's folders see the
same files as before.

## Who counts as an author

| Author | When |
| --- | --- |
| `human` | The member typed, pasted or dictated it, or edited any part of the line. Edits synced from a desktop folder or Obsidian count too: only the member writes there, and if that were ever wrong the result is a line an agent can't change, never one it can. |
| `ai` | Margin Chat's own model wrote it (Ask AI, Agent mode, side documents). The id is `<service>:<model>` from the block's generation record, or `ai:legacy` when that record is gone. |
| `agent` | A connected app wrote it through MCP. The id is `mcp:<token id>` and the label is the name the member gave the token or signed-in app. An agent can never say who it is. |
| `import` | A web page, X post or thread imported into a new document. Lines the member later changes become `human`. |
| `system` | A server job. |
| `unknown` | Text whose author can't be told apart (an AI block the member edited somewhere, a plain file from before this existed). Treated exactly like `human`: agents can't change it. |

A line is one physical line of a block's Markdown, split on `\n` with a trailing
`\r` dropped. Frontmatter, chat transcripts and margin comments are not covered.
A document's blocks keep their ids; a note or plain Markdown file is one block
(its body, id `<document id>-body`).

## How it's recorded

The browser saves the editor, Ask AI, Agent mode and imports together in one
batched commit, so a revision doesn't have one author. On every commit the
server (`server/vault/provenance/`) diffs each changed Markdown file against its
parent revision with a Myers line diff over SHA-256 line hashes:

- A line unchanged from the parent keeps its author and the revision it first
  appeared in. A line that moved, byte for byte, keeps them too.
- A new or changed line belongs to whoever made it: an MCP write credits the
  token; an app save credits the model for a block still marked `ai`, the
  importer for a newly imported block (`origin: { type: "import" }` on the
  block), and the member for everything else. Editing one word of an AI line
  makes that line the member's; the rest of the block keeps its author.

### Merges and concurrent saves

A device that saved against an older revision merges as it always has
(`client/src/lib/vaultMerge.ts`) and saves the result on top of the newer
revision. The forward pass then attributes the merge like any save. A line
that survived from the other side, such as an agent's edit, is already in the
parent and keeps its author. A line from the device's side is new and belongs
to the member. When both sides changed one line, the merged line is the
agent's only if it is the agent's text exactly. If any of the member's words
survive, it is a new line and the member's. `tests/line-authorship-merge.test.ts`
covers both cases (spec §8, test 10).

Saves record authorship after responding. The next save can reach another
server before the previous save's sidecar is written. A save whose parent
sidecar isn't there yet waits briefly for it (up to about a second), using the
revision at which the manifest last changed that file. If the sidecar still
isn't there, the save reads the parent's wrappers, so the member's lines and
lines nobody can place stay protected.

The `<ai>`, `<user>` and `<ai edited-by="user">` wrappers are unchanged. They
summarize a block's lines: all the member's → `<user>`, none → `<ai>`, both → mixed.

## Where it's stored

One JSON sidecar per (document, revision) in cloud storage beside the vault's
history, at `vaults/v1/<account>/provenance/<sha256(document id)>/revisions/<vault revision>-<file revision>.json`,
plus a `head.json` naming the document's newest one. A file's revision id is a
hash of its content, so the same text saved twice has the same id; naming the
sidecar by the vault revision too keeps an old sidecar from being overwritten
when text is reverted. Keyed by document id, so renaming a file keeps its
history. Each sidecar names its parent, so `chain()` walks a document's history.

Authorship exists only for cloud vaults (Plus, Cloud and admin), which are also
the only vaults MCP reaches. A save whose parent has no sidecar (it was made
before this existed, or raced another save) reads the parent's wrappers instead,
as the backfill does. If recording fails the save still succeeds and the lines
are read as `unknown`, which protects them.

The Postgres projection (migration `0026_line_authorship`) can be rebuilt from
the sidecars: `marginchat_document_revisions` (one row per revision),
`marginchat_line_authorship` (the current revision's lines) and
`marginchat_document_authorship` (per-document totals for search results and
the document header).

## Backfill

The persistence job `line-authorship-backfill-v1` (`server/releases/job-registry.mjs`,
declared in `release.config.json`) gives every existing document and note a
genesis sidecar inferred from its wrappers: `<user>` lines → `human`, `<ai>`
lines → `ai:legacy`, `<ai edited-by="user">` lines and plain Markdown files →
`unknown`. It skips documents that already have one, writes no Markdown and
changes no file's revision or dates. Each account logs its counts by author
type (never text or titles), so the share of `unknown` lines is visible in the
release report.

## Agent edit policy

A document's frontmatter may hold `agent-edit: locked` (connected apps can only
append) or `agent-edit: open` (they may also edit the member's lines). Absent
means the default: only lines the member didn't write. Only the app sets it;
no MCP tool can.
It's set in the document's ••• menu under **Agent editing**: *Only what I
didn't write* (the default), *Locked* or *Open*.

## In the app

Above a document's text, one line says how much of it the member wrote
(`62% written by you · 214 lines · last edited by Muse`), next to the
authorship view:

- **Off**: no marks.
- **Mine**: the member's lines get a rule and a faint wash.
- **Blame**: each run of lines by one author gets a label with the author and
  how long ago it was written (`claude-sonnet · 3d`); the tooltip gives the
  date. Lines from before tracking began say `earlier`. Colour helps, but the
  label always names the author.
- **Only mine** folds every run of lines the member didn't write into one line
  (`— 12 lines by Ask AI —`). Editing pauses while it's on.

The browser reads `GET /api/vault/authorship?id=<document id>`
(`server/vault/provenance/appView.mjs`): the document's current sidecar as a
short hash, author and origin per line. It matches those to the lines on
screen by their text (`client/src/lib/documentAuthorship.ts`), so lines not
saved yet show as they'll be recorded: a new line in an untouched AI block is
the model's, any other is the member's. It reads again a few seconds after
edits settle. The view and the "Only mine" choice are remembered per device.

Authorship is recorded for cloud vaults only, so documents on a device-only
vault show no summary. Public maps and search show no per-line authorship.
