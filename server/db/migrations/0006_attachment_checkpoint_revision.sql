-- An older serving application can advance the projection revision without
-- refreshing its attachment map. Bind new maps to the revision they describe;
-- existing maps remain untrusted until the next successful projection.
alter table marginchat_vault_projections
  add column if not exists attachment_checkpoint_revision bigint;
