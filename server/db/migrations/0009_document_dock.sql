-- Pinned document panes persist independently of the active document family.
alter table marginchat_app_sessions add column if not exists document_dock jsonb;
