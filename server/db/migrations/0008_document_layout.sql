-- Document panes can move or minimize without changing their original ancestry.
alter table marginchat_conversations add column if not exists document_layout jsonb;
