-- Expand selectable models without rewriting saved choices or execution receipts.
-- Retain the earlier catalog IDs so existing chats and older clients remain valid.
alter table marginchat_app_sessions
  drop constraint if exists app_sessions_default_model_id_check;
alter table marginchat_app_sessions
  add constraint app_sessions_default_model_id_check check (
    (default_service_id is null and default_model_id is null)
    or (default_service_id = 'backend-services' and default_model_id = 'smart-routing')
    or (
      default_service_id in ('openai-api', 'openai-agent')
      and default_model_id in (
        'gpt-6-astra', 'gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'
      )
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
      and default_model_id in ('grok-4.6', 'grok-4.5', 'grok-4.3')
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
        'gpt-6-astra', 'gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'
      )
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
      and model_id in ('grok-4.6', 'grok-4.5', 'grok-4.3')
    )
  );

-- The database defaults to Automatic. Per-provider defaults belong to the
-- application catalog; a single column default cannot depend on service_id.
alter table marginchat_app_sessions
  alter column default_service_id set default 'backend-services',
  alter column default_model_id set default 'smart-routing';
alter table marginchat_conversations
  alter column model_id set default 'smart-routing';
