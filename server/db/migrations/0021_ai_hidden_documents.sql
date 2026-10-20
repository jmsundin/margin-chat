-- A document the user hides from AI (frontmatter `hide-from-ai: true`) is left
-- out of Agent search and reads, search by meaning, topic embeddings and
-- connected apps. Every existing document stays visible.
alter table marginchat_conversations
  add column if not exists ai_hidden boolean not null default false;
