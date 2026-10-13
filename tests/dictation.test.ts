import { afterEach, describe, expect, test } from "bun:test";
import { createHostedUsageMeter } from "../server/billing/usage.mjs";
import { createDictationService, dictationAudioExtension, dictationTokenLimits, liveDictationCharge, MAX_DICTATION_AUDIO_BYTES } from "../server/dictation/index.mjs";
import { matchApiRoute } from "../server/routes/registry.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// Fictional rates: one micro per input token, two per output token.
const env = {
  OPENAI_API_KEY: "hosted-key",
  API_KEY_ENCRYPTION_KEY: "a".repeat(64),
  HOSTED_MODEL_PRICES_JSON: JSON.stringify({
    "openai:gpt-4o-mini-transcribe": { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 },
    "openai:gpt-live-transcribe": { microsPerMinute: 6_000 },
  }),
};
const audio = Buffer.alloc(3_200, 1);
const usage = { type: "tokens", input_tokens: 40, input_token_details: { audio_tokens: 40, text_tokens: 0 }, output_tokens: 12, total_tokens: 52 };

function meterFixture() {
  const reservations: any[] = [];
  const settlements: any[] = [];
  const billingService = {
    reserveHostedRequest: async (args: any) => { reservations.push(args); },
    settleHostedRequest: async (args: any) => { settlements.push(args); },
  };
  return { reservations, settlements, meter: createHostedUsageMeter({ env, billingService, requestId: "dictation", userId: "member", operation: "dictation" }) };
}

function stubOpenAI(reply: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return reply(); }) as typeof fetch;
  return calls;
}

describe("voice typing transcription", () => {
  test("routes the transcription endpoint", () => {
    expect(matchApiRoute("POST", "/api/dictation/transcribe")?.id).toBe("dictationTranscribe");
    expect(matchApiRoute("GET", "/api/dictation/transcribe")).toBeNull();
  });

  test("accepts the formats browsers record", () => {
    expect(dictationAudioExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(dictationAudioExtension("audio/mp4")).toBe("mp4");
    expect(dictationAudioExtension("audio/ogg; codecs=opus")).toBe("ogg");
    expect(dictationAudioExtension("application/json")).toBeNull();
  });

  test("bills hosted transcription from the recording's size and settles at reported tokens", async () => {
    const calls = stubOpenAI(() => Response.json({ text: " Hello there. ", usage }));
    const { meter, reservations, settlements } = meterFixture();
    const result = await createDictationService({ env }).transcribe({
      bytes: audio, contentType: "audio/webm;codecs=opus", language: "en",
      context: { allowHosted: true, apiKeys: {}, usageMeter: meter },
    });
    expect(result).toEqual({ text: "Hello there.", model: "gpt-4o-mini-transcribe" });
    expect(calls[0].url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer hosted-key");
    const form = calls[0].init.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("language")).toBe("en");
    expect((form.get("file") as File).name).toBe("dictation.webm");
    const limits = dictationTokenLimits(audio.length);
    expect(reservations[0].metadata).toMatchObject({ operation: "dictation", kind: "transcription", inputTokenLimit: limits.inputTokenLimit, outputTokenLimit: limits.maxOutputTokens });
    expect(reservations[0].amountMicros).toBe(limits.inputTokenLimit + 2 * limits.maxOutputTokens);
    expect(settlements[0]).toMatchObject({ amountMicros: 40 + 2 * 12 });
    expect(settlements[0].metadata.usageSource).toBe("provider");
  });

  test("uses the person's own OpenAI key without charging credit", async () => {
    const calls = stubOpenAI(() => Response.json({ text: "Mine", usage }));
    const { meter, reservations } = meterFixture();
    const result = await createDictationService({ env }).transcribe({
      bytes: audio, contentType: "audio/mp4",
      context: { allowHosted: false, apiKeys: { openai: "personal-key" }, usageMeter: meter },
    });
    expect(result.text).toBe("Mine");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer personal-key");
    expect(reservations).toHaveLength(0);
  });

  test("explains what is missing and rejects bad recordings before calling OpenAI", async () => {
    const calls = stubOpenAI(() => Response.json({ text: "never" }));
    const service = createDictationService({ env });
    const context = { allowHosted: false, apiKeys: {}, usageMeter: null };
    await expect(service.transcribe({ bytes: audio, contentType: "audio/webm", context })).rejects.toMatchObject({ statusCode: 402 });
    await expect(service.transcribe({ bytes: audio, contentType: "text/plain", context })).rejects.toMatchObject({ statusCode: 415 });
    await expect(service.transcribe({ bytes: Buffer.alloc(0), contentType: "audio/webm", context })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.transcribe({ bytes: Buffer.alloc(MAX_DICTATION_AUDIO_BYTES + 1), contentType: "audio/webm", context })).rejects.toMatchObject({ statusCode: 413 });
    await expect(service.transcribe({ bytes: audio, contentType: "audio/webm", language: "english", context: { ...context, apiKeys: { openai: "k" } } })).rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toHaveLength(0);
  });

  test("a rejected OpenAI key is not reported as the user's session expiring, and is not billed", async () => {
    stubOpenAI(() => Response.json({ error: { message: "Incorrect API key provided." } }, { status: 401 }));
    const { meter, settlements } = meterFixture();
    await expect(createDictationService({ env }).transcribe({
      bytes: audio, contentType: "audio/webm", context: { allowHosted: true, apiKeys: {}, usageMeter: meter },
    })).rejects.toMatchObject({ statusCode: 502, message: "Incorrect API key provided." });
    expect(settlements[0].amountMicros).toBe(0);
  });

  test("routes live sessions", () => {
    expect(matchApiRoute("POST", "/api/dictation/live")?.id).toBe("dictationLive");
    expect(matchApiRoute("POST", "/api/dictation/live/finish")?.id).toBe("dictationLiveFinish");
  });

  test("charges live sessions by the second, within their hold", () => {
    expect(liveDictationCharge({ startedAt: 0, endedAt: 30_000, microsPerMinute: 6_000, reservedMicros: 60_000 })).toEqual({ seconds: 30, amountMicros: 3_000 });
    expect(liveDictationCharge({ startedAt: 0, endedAt: 1_200, microsPerMinute: 6_000, reservedMicros: 60_000 })).toEqual({ seconds: 2, amountMicros: 200 });
    expect(liveDictationCharge({ startedAt: 0, endedAt: 3_600_000, microsPerMinute: 6_000, reservedMicros: 60_000 }).amountMicros).toBe(60_000);
  });

  function liveFixture() {
    const reservations: any[] = [];
    const settlements: any[] = [];
    const billingService = {
      reserveHostedRequest: async (args: any) => { reservations.push(args); },
      settleHostedRequest: async (args: any) => { settlements.push(args); return { settled: settlements.filter((entry) => entry.requestId === args.requestId).length === 1 }; },
    };
    let clock = 1_000_000;
    const service = createDictationService({ env, billingService, now: () => clock });
    return { service, reservations, settlements, advance: (ms: number) => { clock += ms; } };
  }

  test("a hosted live session holds ten minutes and settles at the time it ran", async () => {
    const calls = stubOpenAI(() => Response.json({ value: "ek_live", expires_at: 123 }));
    const { service, reservations, settlements, advance } = liveFixture();
    const session = await service.startLive({ language: "en", userId: "member", context: { allowHosted: true, apiKeys: {}, usageMeter: {} } });
    expect(session).toMatchObject({ clientSecret: "ek_live", model: "gpt-live-transcribe", maxSeconds: 600 });
    expect(typeof session.token).toBe("string");
    expect(session.token).not.toContain("member");
    expect(calls[0].url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer hosted-key");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      expires_after: { anchor: "created_at", seconds: 60 },
      session: { type: "transcription", audio: { input: { transcription: { model: "gpt-live-transcribe", language: "en" }, turn_detection: null } } },
    });
    expect(reservations[0]).toMatchObject({ userId: "member", amountMicros: 60_000 });
    advance(45_000);
    await expect(service.finishLive({ token: session.token, userId: "intruder" })).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.finishLive({ token: "dictation-live:garbage", userId: "member" })).rejects.toMatchObject({ statusCode: 400 });
    expect(await service.finishLive({ token: session.token, userId: "member" })).toEqual({ settled: true, seconds: 45 });
    expect(settlements[0]).toMatchObject({ requestId: reservations[0].requestId, userId: "member", amountMicros: 4_500 });
    expect((await service.finishLive({ token: session.token, userId: "member" })).settled).toBe(false);
  });

  test("own keys and admins open live sessions without a hold", async () => {
    const calls = stubOpenAI(() => Response.json({ value: "ek_mine" }));
    const { service, reservations } = liveFixture();
    expect((await service.startLive({ userId: "member", context: { allowHosted: false, apiKeys: { openai: "personal" }, usageMeter: {} } })).token).toBeNull();
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer personal");
    expect((await service.startLive({ userId: "admin", context: { allowHosted: true, apiKeys: {}, usageMeter: null } })).token).toBeNull();
    expect(reservations).toHaveLength(0);
  });

  test("a failed live start releases its hold, and missing pricing stops before OpenAI", async () => {
    stubOpenAI(() => Response.json({ error: { message: "Bad key" } }, { status: 401 }));
    const { service, reservations, settlements } = liveFixture();
    const context = { allowHosted: true, apiKeys: {}, usageMeter: {} };
    await expect(service.startLive({ userId: "member", context })).rejects.toMatchObject({ statusCode: 502 });
    expect(settlements[0]).toMatchObject({ requestId: reservations[0].requestId, amountMicros: 0 });
    const calls = stubOpenAI(() => Response.json({ value: "never" }));
    const unpriced = createDictationService({ env: { ...env, HOSTED_MODEL_PRICES_JSON: "{}" }, billingService: { reserveHostedRequest: async () => {}, settleHostedRequest: async () => ({}) } });
    await expect(unpriced.startLive({ userId: "member", context })).rejects.toMatchObject({ statusCode: 503 });
    expect(calls).toHaveLength(0);
    await expect(service.startLive({ userId: "member", context: { allowHosted: false, apiKeys: {}, usageMeter: null } })).rejects.toMatchObject({ statusCode: 402 });
  });
});
