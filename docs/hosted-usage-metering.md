# Hosted usage metering

Hosted model work uses prepaid credits for every member, including subscribers. A subscription adds credits; it does not bypass usage charges. Personal provider keys and administrator use do not debit the hosted wallet. A personal chat can still incur a hosted embedding charge if document search uses the application's OpenAI key.

## Configure prices before enabling hosted models

Set `HOSTED_MODEL_PRICES_JSON` to an object keyed by the exact requested `provider:model` identifier. Providers are `openai`, `gemini`, `huggingface`, and `xai`; OpenAI Agent uses the same `openai:model` entry as ordinary OpenAI chat. Every hosted model that automatic routing might select needs an entry. Document upload and retrieval also need `openai:text-embedding-3-small`.

Each entry requires `inputMicrosPerMillionTokens` and `outputMicrosPerMillionTokens`, as nonnegative safe integers with at least one positive rate. One dollar is 1,000,000 microdollars. Thus a verified price of $0.50 per million tokens would be configured as `500000`, not `0.50`. This example explains the unit; it is not a current provider price quote.

`cachedInputMicrosPerMillionTokens` is optional, defaults to the input rate, and must not exceed it. Configure the verified cached-input rate to apply the provider's cache discount. Embedding entries should have an output rate of zero.

`cacheWriteInputMicrosPerMillionTokens` is optional for models that do not bill cache writes separately. Configure it for models that do. Reservations use the greater of the ordinary-input and cache-write rate. Settlement removes cache reads and writes from ordinary input before pricing each category, so tokens are charged once. If a provider reports cache-write tokens with no configured rate, execution stops, its charge is capped at the existing reservation and labeled estimated, and ledger metadata records `unpricedCacheWriteTokens`. Configure the missing rate before retrying.

Gemini entries also require `maxReasoningTokens`: the verified maximum thinking tokens the exact model can produce under its current default configuration, or zero for a model without thinking. This is an additional reservation allowance, not a provider thinking control. The adapter requests one candidate and sets `maxOutputTokens`; the reservation includes that candidate limit plus the configured reasoning allowance. Do not substitute an average or desired thinking budget for the model's maximum. If a model's maximum cannot be established, leave it unavailable for hosted use.

No provider prices are bundled or inferred from a similar model name. Missing/invalid pricing fails before sending a hosted request. Automatic routing may try another configured model. Personal-key calls do not require this price map. Pin provider/model routing and verify rates against the provider account's current price schedule before updating the map. This implementation supports text input/output, cached input, and text embeddings; additional priced features or tiered/context-dependent rates require extending the pricing policy before enabling them.

## Reservation and settlement

Each actual provider operation gets its own reservation immediately before dispatch. This includes chat, title generation, each fallback attempt, each OpenAI Agent round, every document embedding batch, and retrieval-query embeddings. A rejected reservation stops that operation before a network call. Later agent rounds can stop for insufficient funds after earlier completed rounds have been charged.

The input reservation uses the UTF-8 byte length of the complete serialized request plus 1,024 tokens for framing. It includes instructions, history, tool definitions, and tool results. Output uses the explicit provider cap, plus the Gemini reasoning allowance described above. This deliberately conservative text bound can require more available credit than the eventual charge. Provider adapters enforce output limits; titles have a limit of at most 256 output tokens.

Final provider counts determine the charge when available. OpenAI/xAI Responses use input and output tokens, including reasoning already counted in output. Gemini adds candidate and thought tokens. Hugging Face uses prompt/completion usage and requests the final usage chunk while streaming. Cached input is separated from ordinary input. Embeddings use input tokens only. The combined operation cost is rounded up once to the nearest microdollar, using integer arithmetic.

The database atomically holds credit before dispatch. Settlement writes the actual usage charge and returns the unused hold. Concurrent operations cannot reuse already reserved money. If a provider reports usage above the reserved bounds, the charge is capped at the reservation, a billing error stops execution, and the ledger metadata records the discrepancy for investigation. An incorrect operator configuration or changed provider behavior must be corrected before further use of that model; this safeguard never creates a negative customer balance.

## Missing usage, cancellations, and failures

A known HTTP rejection or cancellation before dispatch releases the entire hold. Once a request is dispatched, a network failure or client cancellation can hide tokens already generated by the provider. If final valid usage is unavailable, settlement charges the full conservative reservation and records `usageSource: "estimated-upper-bound"`. This is an estimate, not a claim that the provider reported those token counts. Intermediate streaming counts cannot release credit because they may omit later generated tokens. Successful responses missing usable usage metadata follow the same estimation rule.

The account activity should display estimated charges explicitly. Ledger metadata retains the requested provider/model, captured rates, operation type, input/output/cached/reasoning counts, limits, reserved amount, final amount, completion/failure outcome, and the usage source. The execution's billing summary lists its individual operations and whether any charge was estimated.

Settlement uses the same request identifier, amount, and metadata for three attempts to tolerate a transient database error or an ambiguous commit. Database idempotency prevents duplicate charges. Persistent failure leaves the credit held, returns a billing error, and prevents provider fallbacks. A later retry of the same settlement is safe. A process termination during an operation can also leave a pending hold; operators must reconcile stale holds using the stored reservation and provider evidence. Do not automatically release every stale reservation, since the provider may have completed billable work.

## Provider usage references

- [OpenAI Responses usage fields](https://developers.openai.com/api/reference/cli/resources/responses/methods/retrieve)
- [Gemini generateContent usage metadata and generation configuration](https://ai.google.dev/api/generate-content)
- [Hugging Face chat completion usage and streaming options](https://huggingface.co/docs/inference-providers/en/tasks/chat-completion)
- [xAI Responses cache and reasoning usage](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing)

The regression suite uses fictional prices and mocked provider responses; it makes no live billable provider calls. Run `bun test tests/hosted-usage.test.ts tests/chat-execution.test.ts` for metering, cancellation, settlement-retry, and integration coverage.

## Verified OpenAI smoke-test configuration — September 18, 2026

[The dated price map](config/hosted-prices.openai-2026-09-18.json) supplies the repository default `gpt-5.6`, the lower-cost catalog option `gpt-5.6-luna`, and `text-embedding-3-small`. These are standard, short-context, direct-API USD rates per million tokens:

| Exact requested model | Ordinary input | Cached input | Cache writes | Output |
| --- | ---: | ---: | ---: | ---: |
| `gpt-5.6` | $4.00 | $0.40 | $5.00 | $20.00 |
| `gpt-5.6-terra` | $2.00 | $0.20 | $2.50 | $12.00 |
| `gpt-5.6-luna` | $0.20 | $0.02 | $0.25 | $1.20 |
| `text-embedding-3-small` | $0.02 | — | — | — |

Official sources: [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) establishes the `gpt-5.6` alias and its rates; [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) establishes Luna's rates; [API pricing](https://developers.openai.com/api/docs/pricing) lists cache-write prices; [the embedding model page](https://developers.openai.com/api/docs/models/text-embedding-3-small) lists embedding cost. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) documents `usage.input_tokens_details.cache_write_tokens` and the non-additive input calculation. Checked September 18, 2026; recheck before production use. The Sol rate is promotional through at least November 21, 2026. Requests above 272,000 input tokens have different prices; this map is not a long-context or Fast/priority price schedule.

[The nonsecret smoke-test settings](config/hosted-usage-smoke-test.env.example) select Luna and cap hosted output at 128 tokens with a 6,000-character context allowance. Use a fresh, empty conversation, select `openai-api` / `gpt-5.6-luna` explicitly, and send a short prompt such as “Reply with OK.” This avoids automatic routing to another model and additional Agent rounds. The output portion is bounded at 154 microdollars after rounding ($0.000154); input is additionally bounded and reserved from the actual request body at up to $0.25 per million tokens. Automatic title generation is another separately billed operation. A tiny document upload or retrieval also generates a separate embedding charge.

These examples contain no credentials, do not enable provider access, and do not run a test. Provision the existing project key privately into the isolated server only when the real-provider test is authorized. Confirm the final ledger records provider usage and releases the unused hold; do not equate an estimated interrupted charge with a verified provider cost.

Production uses this map, including Terra's verified standard rates from the API pricing page, with 60,000 input characters and 2,000 output tokens per hosted operation. Hosted automatic routing can fall back to these priced OpenAI models. Gemini, Hugging Face, and xAI remain available with personal keys; hosted calls to their unpriced models fail before dispatch until an exact price schedule and required reasoning bounds are configured.
