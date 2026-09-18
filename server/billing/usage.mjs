import { HttpError } from "../lib/errors.mjs";

const MILLION = 1_000_000n;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

export function getHostedModelPrice(env, provider, model) {
  let prices;
  try { prices = JSON.parse(env.HOSTED_MODEL_PRICES_JSON ?? "{}"); }
  catch { throw new HttpError(503, "Hosted model pricing is not configured correctly."); }
  const price = prices?.[`${provider}:${model}`];
  if (!price || !isCount(price.inputMicrosPerMillionTokens) || !isCount(price.outputMicrosPerMillionTokens) ||
      price.inputMicrosPerMillionTokens + price.outputMicrosPerMillionTokens === 0 ||
      (price.cachedInputMicrosPerMillionTokens !== undefined && (!isCount(price.cachedInputMicrosPerMillionTokens) || price.cachedInputMicrosPerMillionTokens > price.inputMicrosPerMillionTokens)) ||
      (price.cacheWriteInputMicrosPerMillionTokens !== undefined && !isCount(price.cacheWriteInputMicrosPerMillionTokens)) ||
      (provider === "gemini" && !isCount(price.maxReasoningTokens))) {
    throw new HttpError(503, `Hosted usage pricing is unavailable for ${provider}:${model}. Use a personal API key or ask the administrator to configure this model.`);
  }
  return { ...price, cachedInputMicrosPerMillionTokens: price.cachedInputMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens };
}

export function normalizeProviderUsage(provider, payload, kind = "generation") {
  const raw = provider === "gemini" ? payload?.usageMetadata : payload?.usage;
  if (!raw || typeof raw !== "object") return null;
  let inputTokens;
  let outputTokens;
  let cachedInputTokens;
  let cacheWriteInputTokens = 0;
  let reasoningTokens;
  if (provider === "gemini") {
    inputTokens = raw.promptTokenCount;
    reasoningTokens = raw.thoughtsTokenCount ?? 0;
    outputTokens = isCount(raw.candidatesTokenCount) && isCount(reasoningTokens) ? raw.candidatesTokenCount + reasoningTokens : null;
    cachedInputTokens = raw.cachedContentTokenCount ?? 0;
  } else {
    inputTokens = raw.input_tokens ?? raw.prompt_tokens;
    outputTokens = kind === "embedding" ? 0 : raw.output_tokens ?? raw.completion_tokens;
    cachedInputTokens = raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? 0;
    cacheWriteInputTokens = raw.input_tokens_details?.cache_write_tokens ?? raw.prompt_tokens_details?.cache_write_tokens ?? 0;
    reasoningTokens = raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens ?? 0;
  }
  const total = raw.totalTokenCount ?? raw.total_tokens;
  // Compatible APIs can report reasoning outside completion_tokens. Responses
  // output_tokens already includes it, so never add those details twice.
  if (kind !== "embedding" && isCount(total) && isCount(inputTokens) && isCount(outputTokens)) outputTokens = Math.max(outputTokens, total - inputTokens);
  if (![inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens, reasoningTokens].every(isCount) || cachedInputTokens + cacheWriteInputTokens > inputTokens) return null;
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens, reasoningTokens };
}

export function calculateUsageMicros(usage, price) {
  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? 0;
  if (cacheWriteInputTokens > 0 && !isCount(price.cacheWriteInputMicrosPerMillionTokens)) throw new HttpError(503, "Hosted cache-write pricing is not configured for this model.");
  const numerator = BigInt(usage.inputTokens - usage.cachedInputTokens - cacheWriteInputTokens) * BigInt(price.inputMicrosPerMillionTokens) +
    BigInt(usage.cachedInputTokens) * BigInt(price.cachedInputMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens) +
    BigInt(cacheWriteInputTokens) * BigInt(price.cacheWriteInputMicrosPerMillionTokens ?? 0) +
    BigInt(usage.outputTokens) * BigInt(price.outputMicrosPerMillionTokens);
  const amount = (numerator + MILLION - 1n) / MILLION;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(413, "This model request exceeds the supported prepaid usage limit.");
  return Number(amount);
}

export function createHostedUsageMeter({ env, billingService, requestId, userId, operation = "reply" }) {
  let sequence = 0;
  const entries = [];
  return {
    async begin({ provider, model, body, maxOutputTokens, kind = "generation" }) {
      const price = getHostedModelPrice(env, provider, model);
      if (!isCount(maxOutputTokens) || (kind !== "embedding" && maxOutputTokens === 0)) throw new HttpError(503, "Hosted requests require an explicit output token limit.");
      // Reserve from UTF-8 bytes of the complete serialized body, including
      // tool schemas/history, with additional provider framing allowance.
      const inputBound = Buffer.byteLength(JSON.stringify(body), "utf8") + 1024;
      const outputBound = maxOutputTokens + (provider === "gemini" ? price.maxReasoningTokens : 0);
      if (!isCount(outputBound)) throw new HttpError(503, "Invalid hosted output token limit.");
      const estimate = { inputTokens: inputBound, outputTokens: outputBound, cachedInputTokens: 0,
        cacheWriteInputTokens: price.cacheWriteInputMicrosPerMillionTokens > price.inputMicrosPerMillionTokens ? inputBound : 0,
        reasoningTokens: provider === "gemini" ? price.maxReasoningTokens : 0 };
      const amountMicros = Math.max(1, calculateUsageMicros(estimate, price));
      const childRequestId = `${requestId}:${++sequence}`;
      const metadata = { executionId: requestId, operation, kind, provider, model, pricing: price, inputTokenLimit: inputBound, outputTokenLimit: outputBound };
      await billingService.reserveHostedRequest({ requestId: childRequestId, userId, amountMicros, metadata });
      let dispatched = false;
      let rejected = false;
      let usage = null;
      let finalUsage = false;
      let unpricedCacheWriteTokens = 0;
      let settlementEntry = null;
      let settled = false;
      let settlementPromise = null;
      return {
        markDispatched() { dispatched = true; },
        markRejected() { rejected = true; },
        recordUsage(payload, complete = true) {
          const next = normalizeProviderUsage(provider, payload, kind);
          if (next?.cacheWriteInputTokens > 0 && price.cacheWriteInputMicrosPerMillionTokens === undefined) {
            unpricedCacheWriteTokens = next.cacheWriteInputTokens;
            finalUsage = false;
            const failure = new HttpError(503, "The provider reported cache writes without configured pricing. An estimated charge was capped at the reservation; configure cache-write pricing before retrying.");
            failure.billingFailure = true;
            throw failure;
          }
          if (next) { usage = next; finalUsage = complete; }
        },
        async finish(error = null) {
          if (settled) return;
          if (settlementPromise) return settlementPromise;
          if (!settlementEntry) {
            const unbilled = rejected || !dispatched;
            // An interrupted stream's intermediate usage may omit output that
            // the provider already generated. Only final usage releases a hold.
            const measured = unbilled ? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 } : finalUsage ? usage : estimate;
            const cost = calculateUsageMicros(measured, price);
            const exceededReservation = measured.inputTokens > inputBound || measured.outputTokens > outputBound || cost > amountMicros;
            settlementEntry = {
              ...metadata, ...measured, amountMicros: Math.min(cost, amountMicros), reservedMicros: amountMicros,
              usageSource: unbilled ? "not-billed" : finalUsage ? "provider" : "estimated-upper-bound",
              outcome: error ? "failed" : "completed",
              ...(unpricedCacheWriteTokens ? { unpricedCacheWriteTokens } : {}),
              ...(exceededReservation ? { exceededReservation: true, reportedCostMicros: cost } : {}),
            };
          }
          const entry = settlementEntry;
          settlementPromise = (async () => {
            // Database settlement is idempotent. Reuse exactly the same amount
            // and metadata when a lost response leaves COMMIT ambiguous.
            for (let attempt = 0; attempt < 3; attempt += 1) {
              try {
                await billingService.settleHostedRequest({ requestId: childRequestId, userId, amountMicros: entry.amountMicros, metadata: entry });
                settled = true;
                entries.push(entry);
                break;
              } catch (cause) {
                if (attempt === 2) {
                  const failure = new HttpError(503, "Usage settlement is temporarily unavailable. Your reservation remains held; contact support if your balance does not update.");
                  failure.billingFailure = true;
                  failure.cause = cause;
                  throw failure;
                }
              }
            }
            if (entry.exceededReservation) {
              const failure = new HttpError(502, "The provider exceeded this request's prepaid usage limit. No additional credit was deducted.");
              failure.billingFailure = true;
              throw failure;
            }
          })();
          try { await settlementPromise; }
          finally { settlementPromise = null; }
        },
      };
    },
    summary: () => ({ amountMicros: entries.reduce((sum, entry) => sum + entry.amountMicros, 0), estimated: entries.some((entry) => entry.usageSource === "estimated-upper-bound"), operations: entries.map((entry) => ({ ...entry })) }),
  };
}

export async function runMeteredProviderOperation(usageMeter, description, perform) {
  const meter = await usageMeter?.begin(description);
  const tracker = meter ?? { markDispatched() {}, markRejected() {}, recordUsage() {} };
  let result;
  try {
    description.signal?.throwIfAborted();
    result = await perform(tracker);
  } catch (error) {
    await meter?.finish(error);
    throw error;
  }
  await meter?.finish();
  return result;
}
