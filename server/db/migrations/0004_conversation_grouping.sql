-- Preserve manual grouping, including an explicit choice to stay ungrouped.
alter table marginchat_conversations
  add column if not exists grouping_mode text
  check (grouping_mode in ('manual', 'automatic'));
