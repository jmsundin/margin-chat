-- PDFs in the cloud vault are indexed for search like uploaded files. Their
-- source_id is the ID of the file's document, so a match opens that document.
alter table marginchat_vault_passage_sources
  drop constraint if exists marginchat_vault_passage_sources_source_kind_check;
alter table marginchat_vault_passage_sources
  add constraint marginchat_vault_passage_sources_source_kind_check
  check (source_kind in ('conversation', 'attachment', 'vault-file'));
