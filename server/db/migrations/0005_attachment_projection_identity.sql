-- Preserve legacy internal identities and foreign keys while allowing the same
-- portable attachment identity to belong to more than one account. The nullable
-- column and coalesced index also accept writes from the serving older release.
alter table marginchat_documents add column public_id text;
update marginchat_documents set public_id = id;
create unique index marginchat_documents_owner_public_id_idx
  on marginchat_documents (user_id, (coalesce(public_id, id)));

-- Committed with the content projection so incremental rebuilds can trust which
-- metadata and body revisions have already reached the feature database.
alter table marginchat_vault_projections
  add column attachment_revisions jsonb not null default '{}'::jsonb;
