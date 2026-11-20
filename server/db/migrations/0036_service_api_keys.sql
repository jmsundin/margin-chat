-- People can bring their own keys for web search, translation and read-aloud voices too,
-- so the desktop app without an account (and any plan) has every feature.
alter table marginchat_user_api_keys
  drop constraint if exists marginchat_user_api_keys_provider_check;
alter table marginchat_user_api_keys
  add constraint marginchat_user_api_keys_provider_check check (
    provider in ('openai', 'anthropic', 'gemini', 'huggingface', 'xai', 'meta', 'tavily', 'deepl', 'google_translate', 'azure_speech')
  );
