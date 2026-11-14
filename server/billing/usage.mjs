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
      (price.webSearchMicrosPerSearch !== undefined && !isCount(price.webSearchMicrosPerSearch)) ||
      (price.xPostMicrosPerPost !== undefined && !isCount(price.xPostMicrosPerPost)) ||
      (price.xUserMicrosPerUser !== undefined && !isCount(price.xUserMicrosPerUser)) ||
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
  if (provider === "anthropic") {
    // Claude reports cache reads and writes outside input_tokens. A server-side
    // fallback reports each attempt in iterations; top-level usage covers only
    // the attempt that produced the reply.
    const attempts = Array.isArray(raw.iterations) && raw.iterations.length ? raw.iterations : [raw];
    const sum = (key) => attempts.reduce((total, attempt) => total + (attempt?.[key] ?? 0), 0);
    cachedInputTokens = sum("cache_read_input_tokens");
    cacheWriteInputTokens = sum("cache_creation_input_tokens");
    inputTokens = sum("input_tokens") + cachedInputTokens + cacheWriteInputTokens;
    outputTokens = kind === "embedding" ? 0 : sum("output_tokens");
    reasoningTokens = 0;
  } else if (provider === "gemini") {
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
  const webSearches = webSearchCount(provider, payload);
  // Grok's X search is billed per post and per profile it fetched, which xAI reports in usage.
  const details = provider === "xai" ? raw.server_side_tool_usage_details : null;
  const xPosts = isCount(details?.x_posts_fetched) ? details.x_posts_fetched : 0;
  const xUsers = isCount(details?.x_users_fetched) ? details.x_users_fetched : 0;
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens, reasoningTokens, ...(webSearches ? { webSearches } : {}),
    ...(xPosts ? { xPosts } : {}), ...(xUsers ? { xUsers } : {}) };
}

/** Searches a provider's built-in web search ran for one call. They're billed per search on top of
 * tokens. Claude and Grok count them in usage; other Responses APIs don't, so each web_search_call
 * item counts once. */
function webSearchCount(provider, payload) {
  if (provider === "gemini") return 0;
  if (provider === "anthropic") {
    const count = payload?.usage?.server_tool_use?.web_search_requests;
    return isCount(count) ? count : 0;
  }
  const reported = provider === "xai" ? payload?.usage?.server_side_tool_usage_details?.web_search_calls : undefined;
  if (isCount(reported)) return reported;
  if (!Array.isArray(payload?.output)) return 0;
  return payload.output.filter((item) => item?.type === "web_search_call" && item.status !== "failed").length;
}

/** What one round of Grok's built-in tools may run, for its reservation. xAI caps rounds, not calls. */
const XAI_WEB_SEARCHES_PER_TURN = 4;
const XAI_X_POSTS_PER_TURN = 60;
const XAI_X_USERS_PER_TURN = 10;
/** Input tokens a search's results or a fetched post may add on the provider's side, beyond the request body. */
const SEARCH_INPUT_TOKENS = 10_000;
const X_POST_INPUT_TOKENS = 300;

const toolOfType = (body, match) => Array.isArray(body?.tools) ? body.tools.find((tool) => typeof tool?.type === "string" && match(tool.type)) : undefined;

function xaiTurns(body) {
  if (!isCount(body.max_turns) || body.max_turns === 0) throw new HttpError(503, "Hosted search requests require a limit on rounds of searching.");
  return body.max_turns;
}

/** The most built-in web searches a request body allows, or 0 when it offers none. */
function webSearchLimit(provider, body) {
  if (provider === "anthropic") {
    const tool = toolOfType(body, (type) => type.startsWith("web_search_"));
    if (!tool) return 0;
    if (!isCount(tool.max_uses) || tool.max_uses === 0) throw new HttpError(503, "Hosted web search requests require a search limit.");
    return tool.max_uses;
  }
  if (!toolOfType(body, (type) => type === "web_search")) return 0;
  if (provider === "xai") return xaiTurns(body) * XAI_WEB_SEARCHES_PER_TURN;
  if (!isCount(body.max_tool_calls) || body.max_tool_calls === 0) throw new HttpError(503, "Hosted web search requests require a search limit.");
  return body.max_tool_calls;
}

/** The most posts and profiles Grok's X search may fetch in one request, or zeros when it isn't offered. */
function xSearchLimits(provider, body) {
  if (provider !== "xai" || !toolOfType(body, (type) => type === "x_search")) return { xPosts: 0, xUsers: 0 };
  const turns = xaiTurns(body);
  return { xPosts: turns * XAI_X_POSTS_PER_TURN, xUsers: turns * XAI_X_USERS_PER_TURN };
}

/** Input tokens search results and fetched pages may add on Claude's and Grok's side. */
function serverToolInputAllowance(provider, body, searches, xPosts) {
  if (provider !== "anthropic" && provider !== "xai") return 0;
  const fetch = provider === "anthropic" ? toolOfType(body, (type) => type.startsWith("web_fetch_")) : undefined;
  const fetchTokens = fetch ? (isCount(fetch.max_uses) ? fetch.max_uses : 0) * (isCount(fetch.max_content_tokens) ? fetch.max_content_tokens : SEARCH_INPUT_TOKENS) : 0;
  if (fetch && (!isCount(fetch.max_uses) || !isCount(fetch.max_content_tokens))) throw new HttpError(503, "Hosted web fetch requests require a page limit.");
  return searches * SEARCH_INPUT_TOKENS + fetchTokens + xPosts * X_POST_INPUT_TOKENS;
}

export function calculateUsageMicros(usage, price) {
  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? 0;
  const webSearches = usage.webSearches ?? 0;
  const xPosts = usage.xPosts ?? 0;
  const xUsers = usage.xUsers ?? 0;
  if ((xPosts > 0 && !isCount(price.xPostMicrosPerPost)) || (xUsers > 0 && !isCount(price.xUserMicrosPerUser))) throw new HttpError(503, "Hosted X search pricing is not configured for this model.");
  if (cacheWriteInputTokens > 0 && !isCount(price.cacheWriteInputMicrosPerMillionTokens)) throw new HttpError(503, "Hosted cache-write pricing is not configured for this model.");
  if (webSearches > 0 && !isCount(price.webSearchMicrosPerSearch)) throw new HttpError(503, "Hosted web search pricing is not configured for this model.");
  const numerator = BigInt(usage.inputTokens - usage.cachedInputTokens - cacheWriteInputTokens) * BigInt(price.inputMicrosPerMillionTokens) +
    BigInt(usage.cachedInputTokens) * BigInt(price.cachedInputMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens) +
    BigInt(cacheWriteInputTokens) * BigInt(price.cacheWriteInputMicrosPerMillionTokens ?? 0) +
    BigInt(usage.outputTokens) * BigInt(price.outputMicrosPerMillionTokens) +
    BigInt(webSearches) * BigInt(price.webSearchMicrosPerSearch ?? 0) * MILLION +
    BigInt(xPosts) * BigInt(price.xPostMicrosPerPost ?? 0) * MILLION +
    BigInt(xUsers) * BigInt(price.xUserMicrosPerUser ?? 0) * MILLION;
  const amount = (numerator + MILLION - 1n) / MILLION;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(413, "This model request exceeds the supported prepaid usage limit.");
  return Number(amount);
}

export function createHostedUsageMeter({ env, billingService, requestId, userId, operation = "reply" }) {
  let sequence = 0;
  const entries = [];
  return {
    async begin({ provider, model, body, maxOutputTokens, kind = "generation", inputTokenLimit }) {
      const price = getHostedModelPrice(env, provider, model);
      if (!isCount(maxOutputTokens) || (kind !== "embedding" && maxOutputTokens === 0)) throw new HttpError(503, "Hosted requests require an explicit output token limit.");
      if (inputTokenLimit !== undefined && (!isCount(inputTokenLimit) || inputTokenLimit === 0)) throw new HttpError(503, "Invalid hosted input token limit.");
      // Reserve from UTF-8 bytes of the complete serialized body, including
      // tool schemas/history, with additional provider framing allowance.
      // Audio bodies are not JSON, so their caller states the bound instead.
      const searchBound = webSearchLimit(provider, body);
      const xBound = xSearchLimits(provider, body);
      const inputBound = inputTokenLimit ?? Buffer.byteLength(JSON.stringify(body), "utf8") + 1024 + serverToolInputAllowance(provider, body, searchBound, xBound.xPosts);
      const outputBound = maxOutputTokens + (provider === "gemini" ? price.maxReasoningTokens : 0);
      if (!isCount(outputBound)) throw new HttpError(503, "Invalid hosted output token limit.");
      if (searchBound && !isCount(price.webSearchMicrosPerSearch)) throw new HttpError(503, `Hosted web search pricing is unavailable for ${provider}:${model}.`);
      if (xBound.xPosts && (!isCount(price.xPostMicrosPerPost) || !isCount(price.xUserMicrosPerUser))) throw new HttpError(503, `Hosted X search pricing is unavailable for ${provider}:${model}.`);
      const estimate = { inputTokens: inputBound, outputTokens: outputBound, cachedInputTokens: 0,
        cacheWriteInputTokens: price.cacheWriteInputMicrosPerMillionTokens > price.inputMicrosPerMillionTokens ? inputBound : 0,
        reasoningTokens: provider === "gemini" ? price.maxReasoningTokens : 0, ...(searchBound ? { webSearches: searchBound } : {}),
        ...(xBound.xPosts ? { xPosts: xBound.xPosts, xUsers: xBound.xUsers } : {}) };
      const amountMicros = Math.max(1, calculateUsageMicros(estimate, price));
      const childRequestId = `${requestId}:${++sequence}`;
      const metadata = { executionId: requestId, operation, kind, provider, model, pricing: price, inputTokenLimit: inputBound, outputTokenLimit: outputBound,
        ...(searchBound ? { webSearchLimit: searchBound } : {}), ...(xBound.xPosts ? { xPostLimit: xBound.xPosts, xUserLimit: xBound.xUsers } : {}) };
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
            const exceededReservation = measured.inputTokens > inputBound || measured.outputTokens > outputBound || (measured.webSearches ?? 0) > searchBound
              || (measured.xPosts ?? 0) > xBound.xPosts || (measured.xUsers ?? 0) > xBound.xUsers || cost > amountMicros;
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
