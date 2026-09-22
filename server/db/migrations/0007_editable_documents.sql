-- Editable content is independent of immutable AI message history. Anchors can
-- address a document block even when it was authored without an AI message.
alter table marginchat_conversations add column if not exists editable_document jsonb;
alter table marginchat_branch_anchors add column if not exists source_block_id text;
alter table marginchat_conversation_notes add column if not exists source_block_id text;

do $$
declare reference record;
begin
  for reference in
    select conrelid::regclass as table_name, conname from pg_constraint
    where contype = 'f' and confrelid = 'marginchat_messages'::regclass
      and conrelid in ('marginchat_branch_anchors'::regclass, 'marginchat_conversation_notes'::regclass)
  loop
    execute format('alter table %s drop constraint %I', reference.table_name, reference.conname);
  end loop;
end $$;
