-- Ratchet claim checks (docs/ratchet-in-margin-chat-design.md §6). The claims
-- found in a document and their verdicts, kept private to the account: nothing
-- here is written into the document. Each check replaces the document's claims,
-- so a re-check never leaves a verdict the latest check didn't give. Anchors and
-- citations are line hashes, matched against the vault when they are shown.

create table if not exists marginchat_ratchet_claims (
  user_id text not null references marginchat_users(id) on delete cascade,
  doc_id text not null,
  claim_id text not null,
  run_id text not null,
  verdict text not null check (verdict in ('supported', 'unsupported', 'contradicted', 'stale', 'insufficient-evidence')),
  claim jsonb not null,
  created_at timestamptz not null,
  verdict_at timestamptz not null,
  primary key (user_id, doc_id, claim_id)
);

-- One receipt per check, newest kept per document for the claims view.
create table if not exists marginchat_ratchet_runs (
  user_id text not null references marginchat_users(id) on delete cascade,
  doc_id text not null,
  run_id text not null,
  receipt jsonb not null,
  finished_at timestamptz not null,
  primary key (user_id, run_id)
);

create index if not exists marginchat_ratchet_runs_doc_idx on marginchat_ratchet_runs(user_id, doc_id, finished_at desc);
