# Model catalog review — October 9, 2026

The picker contains a curated set of current models for the app's OpenAI, Anthropic Claude, Gemini, xAI, and Hugging Face integrations. The October 9 review added Anthropic Claude, replaced GPT-6 Sol with GPT-6.1 Sol in the picker, and added GLM 5.3 Flash; the other entries were rechecked and remain current. The roles below are selection guidance based on official model documentation, model cards, and serving availability. They are not an independent benchmark ranking or a claim that one model wins every task.

This review updates the catalog and its defaults. It does not activate provider accounts, establish account-specific model access, configure production prices, or validate paid inference. A model's documented image/video capability also does not mean this app sends image/video attachments to it; the catalog describes the underlying model, while the app's adapters determine supported inputs and tools.

## Closed models

| Service | Display name | Exact requested model ID | Role |
| --- | --- | --- | --- |
| OpenAI / OpenAI Agent | GPT-6 Astra | `gpt-6-astra` | Default; flagship complex reasoning and coding |
| OpenAI / OpenAI Agent | GPT-6.1 Sol | `gpt-6.1-sol` | Near-Astra performance at lower cost; supersedes `gpt-6-sol` |
| OpenAI / OpenAI Agent | GPT-6 Luna | `gpt-6-luna` | Efficient focused and high-volume tasks |
| Anthropic | Claude Opus 5.5 | `claude-opus-5-5` | Default; current Opus for complex reasoning, coding, and long knowledge work |
| Anthropic | Claude Sonnet 5.5 | `claude-sonnet-5-5` | Faster, lower-cost everyday coding, writing, and analysis |
| Anthropic | Claude Haiku 5.5 | `claude-haiku-5-5` | Fast, low-cost high-volume work; the app's fast profile |
| Anthropic | Claude Fable 5.1 | `claude-fable-5-1` | Anthropic's most capable model; highest cost and longer turns |
| Gemini | Gemini 3.8 Flash | `gemini-3.8-flash` | Default; current stable Flash model |
| Gemini | Gemini 3.1 Pro Preview | `gemini-3.1-pro-preview` | Advanced reasoning option; explicitly a preview release |
| Gemini | Gemini 3.5 Flash-Lite | `gemini-3.5-flash-lite` | Stable option for economical, high-throughput work |
| xAI | Grok 4.7 | `grok-4.7` | Default; current flagship general and coding model |
| xAI | Grok 4.3 | `grok-4.3` | Additional supported alternative |

OpenAI sources: [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) (the [GPT-6 Sol page](https://developers.openai.com/api/docs/models/gpt-6-sol) points to it as the newer Sol model; GPT-6 Sol has no shutdown date and stays valid for saved chats), and [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).

Anthropic sources: [models overview](https://platform.claude.com/docs/en/about-claude/models/overview) and [pricing](https://platform.claude.com/docs/en/about-claude/pricing). The adapter calls the Messages API through the official `@anthropic-ai/sdk`. Thinking is always on for these models, so the app sets `output_config.effort` instead: `low` for Fast mode and short operations such as titles, `medium` for Balanced, `high` for Thorough. Opus, Sonnet, and Fable requests opt into Anthropic's server-side refusal fallback (`fallbacks: "default"`), which reruns a request declined by a safety classifier on Anthropic's recommended fallback model in the same call. A request the whole chain declines returns a clear "Claude declined" error.

Auto routing uses `gpt-6-astra` with `reasoning.effort: "low"` and structured output to choose from eligible model profiles. It is independent of the Jev toggle. The router respects provider permissions and personal/hosted credential pools. It is metered as a separate routing operation for hosted requests, with the same `openai:gpt-6-astra` price entry. Missing credentials, pricing, invalid output, or a 15-second timeout fall back to standard rules. Cancellation and settlement failures stop the request. Manual model choices and title generation skip this router.

Google's [Gemini model catalog](https://ai.google.dev/gemini-api/docs/models) identifies the exact endpoints and stable/preview status. The [xAI model catalog](https://docs.x.ai/developers/models) identifies Grok 4.7 as the current flagship; [xAI's model details](https://docs.x.ai/developers/models/grok-4.3) cover Grok 4.3.

## Open models through Hugging Face

Use “open models” or “open-weight” for this group. MIT and Apache 2.0 releases are distinguished below from models distributed under custom licenses; availability of downloadable weights does not make every license equivalent.

| Display name | Exact Hugging Face router ID | Role | License stated by model card |
| --- | --- | --- | --- |
| DeepSeek V4.1 Flash | `deepseek-ai/DeepSeek-V4.1-Flash` | Default; current efficient general-purpose and reasoning option | MIT |
| DeepSeek V4 Pro | `deepseek-ai/DeepSeek-V4-Pro-0813` | Flagship reasoning and coding; official release superseding the preview | MIT |
| Qwen3.8 27B | `Qwen/Qwen3.8-27B` | Compact current model for general, coding, and reasoning tasks | Apache 2.0 |
| GLM 5.3 | `zai-org/GLM-5.3` | Complex coding and long-running agent tasks | Custom GLM-5.3 |
| GLM 5.3 Flash | `zai-org/GLM-5.3-Flash` | Fast, economical everyday tasks | MIT |
| Kimi K3 | `moonshotai/Kimi-K3` | Flagship general reasoning and long-context knowledge work | Custom Kimi K3 |
| Qwen3.8 2.4T | `Qwen/Qwen3.8-2.4T-A95B` | Frontier research, professional work, and coding | Custom Qwen3.8-Max |
| MiniMax M3 | `MiniMaxAI/MiniMax-M3` | Efficient long-context and general-purpose work | Custom MiniMax Community |

Original model cards provide the release, capability, and license evidence: [DeepSeek V4.1 Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash), [DeepSeek V4 Pro 0813](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813), [Qwen3.8 27B](https://huggingface.co/Qwen/Qwen3.8-27B), [GLM 5.3](https://huggingface.co/zai-org/GLM-5.3), [Kimi K3](https://huggingface.co/moonshotai/Kimi-K3), [Qwen3.8 2.4T](https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B), and [MiniMax M3](https://huggingface.co/MiniMaxAI/MiniMax-M3).

The public [Hugging Face router model list](https://router.huggingface.co/v1/models) was read during this review. Each selected ID had multiple providers marked `live`, including combinations of Novita, Together, Fireworks, Baseten, DeepInfra, Z.ai, Cerebras, and OVHcloud. This verifies catalog/route availability at the review date, not successful generation with a particular user's token or remaining balance. Models available only as downloads were excluded.

[Hugging Face's router documentation](https://huggingface.co/docs/inference-providers/index) explains the OpenAI-compatible chat endpoint, available-model listing, and provider selection. Bare model IDs use the router's default fastest-provider policy. Provider availability, context limits, supported request options, and prices can differ between routes and change over time. The app's provider-level Automatic mode and Hugging Face's internal provider selection are separate mechanisms.

## Existing conversations

Previously accepted IDs remain recognized on the server and through the client's hidden legacy lookup. Existing conversations can retain their saved model identity without promoting older models in the fresh picker. Compatibility does not guarantee that an upstream provider continues serving a retired ID; users can select a current model when an old route is no longer available.

## Production deployment

Apply `0012_claude_and_model_refresh.sql` (and any earlier pending migration) through the normal release workflow before starting the updated application. It allows the `anthropic` personal-key provider and the `anthropic-api` service, and extends persisted model validation for the new IDs.

Set `ANTHROPIC_API_KEY` in the server environment (Vercel project settings, Production) for hosted Claude access. Without it, Claude works only for members who save their own Anthropic key in Profile. Preserve earlier migration history and the legacy model IDs required by existing conversations.

Existing environment model overrides and saved chat selections are intentionally not rewritten. Update `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GEMINI_MODEL`, `HUGGINGFACE_MODEL` (or `HF_MODEL`), and `XAI_MODEL` in deployment configuration when adopting the refreshed defaults; `.env.example` shows the new choices. Astra has higher per-token pricing than the previous OpenAI default. Review the cost/latency tradeoff before making it the production default; Sol and Luna remain selectable; GPT-5.6 choices and Grok 4.6 remain recognized for saved chats.

Before enabling a new model for hosted credits, add a verified entry to `HOSTED_MODEL_PRICES_JSON` for its exact requested `provider:model` key. For example, the new defaults require `openai:gpt-6-astra`, `gemini:gemini-3.8-flash`, `huggingface:deepseek-ai/DeepSeek-V4.1-Flash`, and `xai:grok-4.7`. Every additional model that hosted selection or fallback may call needs its own exact entry. [The October 9 price map](config/hosted-prices-2026-10-09.json) covers the OpenAI, Anthropic, and xAI picker models at standard rates checked that day on each provider's pricing page; Gemini is left out because Google documents no maximum thinking-token count for `maxReasoningTokens`, and Hugging Face is left out because its prices depend on the serving provider. The map assumes the hosted input cap stays well below the long-context thresholds (OpenAI over 272K input tokens, xAI at 200K, Claude Haiku 5.5 over 100K), where those providers charge more. A Claude refusal fallback is billed by Anthropic at the fallback model's rates (for Opus 5.5 that model can cost $5/$25 instead of $4/$20); the meter sums every attempt's tokens but prices them at the requested model's rate, and the reservation cap still applies. OpenAI Agent shares the corresponding `openai:model` entry; GPT-6 Sol and Luna require `openai:gpt-6-sol` and `openai:gpt-6-luna`.

Unpriced hosted models fail before provider dispatch. A new picker option therefore remains unavailable for hosted use until its pricing and any required reasoning reservation bounds are configured. Automatic routing may continue to another configured, priced option. Do not copy another model's prices or assume that a custom license means free hosted inference. Hugging Face prices also depend on the serving provider; validate the actual routing and billing policy before enabling a hosted route.

Personal provider credentials are independent of the hosted price map and continue to use the selected provider account's access and billing. They do not debit the hosted wallet for personal model calls. Document search can separately use hosted embeddings, as described in the metering documentation.

Follow [hosted usage metering](hosted-usage-metering.md) for exact price units, cached-input/cache-write handling, Gemini reasoning bounds, and reservation behavior, and [production releases](production-releases.md) for deployment. Recheck official availability and prices before rollout. This catalog review contains no secrets, guessed prices, production deployment, or paid inference validation.
