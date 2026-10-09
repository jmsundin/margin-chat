-- Add Anthropic Claude as a provider and refresh the model catalog. Earlier IDs
-- stay valid so saved chats, preferences, and execution receipts are untouched.
alter table marginchat_user_api_keys
  drop constraint if exists marginchat_user_api_keys_provider_check;
alter table marginchat_user_api_keys
  add constraint marginchat_user_api_keys_provider_check check (
    provider in ('openai', 'anthropic', 'gemini', 'huggingface', 'xai')
  );

alter table marginchat_app_sessions
  drop constraint if exists app_sessions_default_service_id_check;
alter table marginchat_app_sessions
  add constraint app_sessions_default_service_id_check check (
    default_service_id is null
    or default_service_id in (
      'backend-services',
      'openai-api',
      'openai-agent',
      'anthropic-api',
      'gemini-api',
      'huggingface-api',
      'xai-api'
    )
  );

alter table marginchat_conversations
  drop constraint if exists conversations_service_id_check;
alter table marginchat_conversations
  add constraint conversations_service_id_check check (
    service_id in (
      'backend-services',
      'openai-api',
      'openai-agent',
      'anthropic-api',
      'gemini-api',
      'huggingface-api',
      'xai-api'
    )
  );

alter table marginchat_app_sessions
  drop constraint if exists app_sessions_default_model_id_check;
alter table marginchat_app_sessions
  add constraint app_sessions_default_model_id_check check (
    (default_service_id is null and default_model_id is null)
    or (default_service_id = 'backend-services' and default_model_id = 'smart-routing')
    or (
      default_service_id in ('openai-api', 'openai-agent')
      and default_model_id in (
        'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'
      )
    )
    or (
      default_service_id = 'anthropic-api'
      and default_model_id in ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1')
    )
    or (
      default_service_id = 'gemini-api'
      and default_model_id in (
        'gemini-3.8-flash', 'gemini-3.5-flash-lite',
        'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'
      )
    )
    or (
      default_service_id = 'huggingface-api'
      and default_model_id in (
        'deepseek-ai/DeepSeek-V4.1-Flash',
        'deepseek-ai/DeepSeek-V4-Pro-0813',
        'Qwen/Qwen3.8-27B',
        'zai-org/GLM-5.3',
        'zai-org/GLM-5.3-Flash',
        'moonshotai/Kimi-K3',
        'Qwen/Qwen3.8-2.4T-A95B',
        'MiniMaxAI/MiniMax-M3',
        'openai/gpt-oss-120b',
        'deepseek-ai/DeepSeek-R1',
        'Qwen/Qwen3-Coder-480B-A35B-Instruct'
      )
    )
    or (
      default_service_id = 'xai-api'
      and default_model_id in ('grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3')
    )
  );

alter table marginchat_conversations
  drop constraint if exists conversations_model_id_check;
alter table marginchat_conversations
  add constraint conversations_model_id_check check (
    (service_id = 'backend-services' and model_id = 'smart-routing')
    or (
      service_id in ('openai-api', 'openai-agent')
      and model_id in (
        'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'
      )
    )
    or (
      service_id = 'anthropic-api'
      and model_id in ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1')
    )
    or (
      service_id = 'gemini-api'
      and model_id in (
        'gemini-3.8-flash', 'gemini-3.5-flash-lite',
        'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'
      )
    )
    or (
      service_id = 'huggingface-api'
      and model_id in (
        'deepseek-ai/DeepSeek-V4.1-Flash',
        'deepseek-ai/DeepSeek-V4-Pro-0813',
        'Qwen/Qwen3.8-27B',
        'zai-org/GLM-5.3',
        'zai-org/GLM-5.3-Flash',
        'moonshotai/Kimi-K3',
        'Qwen/Qwen3.8-2.4T-A95B',
        'MiniMaxAI/MiniMax-M3',
        'openai/gpt-oss-120b',
        'deepseek-ai/DeepSeek-R1',
        'Qwen/Qwen3-Coder-480B-A35B-Instruct'
      )
    )
    or (
      service_id = 'xai-api'
      and model_id in ('grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3')
    )
  );
