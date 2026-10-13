import { randomUUID } from "node:crypto";
import { HttpError } from "../lib/errors.mjs";
import { extractApiErrorMessage } from "../chat/providers.mjs";
import { runMeteredProviderOperation } from "../billing/usage.mjs";
import { decryptSecret, encryptSecret } from "../apiKeys/crypto.mjs";

export const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
// Streams words while the person is still talking. OpenAI bills it by the minute.
export const LIVE_TRANSCRIPTION_MODEL = "gpt-live-transcribe";
// The app stops a recording at 10 minutes; a live session's hold covers that.
export const MAX_LIVE_SECONDS = 10 * 60;
const LIVE_TOKEN_PREFIX = "dictation-live:";
// Under Vercel's 4.5 MB request limit; the app records about 10 minutes in this.
export const MAX_DICTATION_AUDIO_BYTES = 4 * 1024 * 1024;

const AUDIO_EXTENSIONS = new Map([
  ["audio/webm", "webm"], ["video/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/mp4", "mp4"], ["video/mp4", "mp4"], ["audio/x-m4a", "m4a"], ["audio/m4a", "m4a"],
  ["audio/mpeg", "mp3"], ["audio/mp3", "mp3"],
  ["audio/wav", "wav"], ["audio/x-wav", "wav"], ["audio/wave", "wav"],
]);

export function dictationAudioExtension(contentType) {
  return AUDIO_EXTENSIONS.get(String(contentType ?? "").split(";")[0].trim().toLowerCase()) ?? null;
}

// Prepaid bounds from the audio's size. Compressed speech never carries fewer
// than 16 bytes per audio token, and its transcript is far shorter than its audio.
export function dictationTokenLimits(byteLength) {
  return { inputTokenLimit: Math.ceil(byteLength / 16) + 1024, maxOutputTokens: Math.ceil(byteLength / 64) + 1024 };
}

function getTranscriptionKey(context, env) {
  if (context.apiKeys?.openai) return { apiKey: context.apiKeys.openai, hosted: false };
  if (context.allowHosted !== false && env.OPENAI_API_KEY) return { apiKey: env.OPENAI_API_KEY, hosted: true };
  return null;
}

/** Per-minute price of a hosted model, from `microsPerMinute` in HOSTED_MODEL_PRICES_JSON. */
export function getHostedPerMinutePrice(env, provider, model) {
  let prices;
  try { prices = JSON.parse(env.HOSTED_MODEL_PRICES_JSON ?? "{}"); }
  catch { throw new HttpError(503, "Hosted model pricing is not configured correctly."); }
  const micros = prices?.[`${provider}:${model}`]?.microsPerMinute;
  if (!Number.isSafeInteger(micros) || micros <= 0) {
    throw new HttpError(503, `Hosted usage pricing is unavailable for ${provider}:${model}. Use a personal API key or ask the administrator to configure this model.`);
  }
  return micros;
}

/** Charge for a live session from the server's own clock, rounded up to the second, within its hold. */
export function liveDictationCharge({ startedAt, endedAt, microsPerMinute, reservedMicros }) {
  const seconds = Math.max(1, Math.ceil((endedAt - startedAt) / 1000));
  return { seconds, amountMicros: Math.min(reservedMicros, Math.ceil((seconds * microsPerMinute) / 60)) };
}

export function createDictationService({ env = process.env, billingService = null, now = () => Date.now() } = {}) {
  async function transcribe({ bytes, contentType, language = null, context }) {
    const extension = dictationAudioExtension(contentType);
    if (!extension) throw new HttpError(415, "Voice typing needs WebM, Ogg, MP4, MP3 or WAV audio.");
    if (!bytes?.length) throw new HttpError(400, "No audio was recorded.");
    if (bytes.length > MAX_DICTATION_AUDIO_BYTES) throw new HttpError(413, "That recording is too long. Keep voice typing under about 10 minutes.");
    if (language !== null && !/^[a-z]{2,3}$/u.test(language)) throw new HttpError(400, "Choose a two-letter language code.");
    const key = getTranscriptionKey(context, env);
    if (!key) throw new HttpError(402, "Voice typing needs an OpenAI API key in Settings, or the Plus plan.");

    const { inputTokenLimit, maxOutputTokens } = dictationTokenLimits(bytes.length);
    const model = TRANSCRIPTION_MODEL;
    const description = {
      provider: "openai", model, kind: "transcription", signal: context.signal,
      body: { model, audioBytes: bytes.length }, inputTokenLimit, maxOutputTokens,
    };
    return runMeteredProviderOperation(key.hosted ? context.usageMeter : null, description, async (tracker) => {
      context.signal?.throwIfAborted();
      const form = new FormData();
      form.set("model", model);
      form.set("response_format", "json");
      if (language) form.set("language", language);
      form.set("file", new Blob([bytes], { type: String(contentType).split(";")[0].trim() }), `dictation.${extension}`);
      tracker.markDispatched();
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        body: form, method: "POST", signal: context.signal,
        headers: { Authorization: `Bearer ${key.apiKey}` },
      });
      if (!response.ok) tracker.markRejected();
      const payload = await response.json().catch(() => null);
      // A rejected provider key must not read as the user's own session expiring.
      if (!response.ok) throw new HttpError([401, 403].includes(response.status) ? 502 : response.status,
        extractApiErrorMessage(payload) ?? "OpenAI could not transcribe that recording.");
      tracker.recordUsage(payload);
      if (typeof payload?.text !== "string") throw new HttpError(502, "OpenAI returned no transcript.");
      return { text: payload.text.trim(), model };
    });
  }

  /**
   * Opens a live transcription session. The browser streams the microphone to
   * OpenAI with the short-lived secret and shows words as they arrive. Hosted
   * sessions hold the cost of the longest recording and settle on `finishLive`.
   */
  async function startLive({ language = null, context, userId }) {
    if (language !== null && !/^[a-z]{2,3}$/u.test(language)) throw new HttpError(400, "Choose a two-letter language code.");
    const key = getTranscriptionKey(context, env);
    if (!key) throw new HttpError(402, "Voice typing needs an OpenAI API key in Settings, or the Plus plan.");
    const model = LIVE_TRANSCRIPTION_MODEL;
    const billed = key.hosted && context.usageMeter && billingService;
    let hold = null;
    if (billed) {
      const microsPerMinute = getHostedPerMinutePrice(env, "openai", model);
      const reservedMicros = Math.ceil((MAX_LIVE_SECONDS * microsPerMinute) / 60);
      const requestId = `dictation-live:${randomUUID()}`;
      // Encrypt before reserving, so a missing server secret never strands a hold.
      const startedAt = now();
      const token = LIVE_TOKEN_PREFIX + encryptSecret(JSON.stringify({ requestId, userId, startedAt, microsPerMinute, reservedMicros, model }), env);
      await billingService.reserveHostedRequest({ requestId, userId, amountMicros: reservedMicros, metadata: {
        operation: "dictation", kind: "transcription", provider: "openai", model, microsPerMinute, maxSeconds: MAX_LIVE_SECONDS,
      } });
      hold = { requestId, token, reservedMicros };
    }
    try {
      context.signal?.throwIfAborted();
      const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST", signal: context.signal,
        headers: { Authorization: `Bearer ${key.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          expires_after: { anchor: "created_at", seconds: 60 },
          session: {
            type: "transcription",
            audio: { input: { transcription: { model, ...(language ? { language } : {}) }, turn_detection: null } },
          },
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new HttpError([401, 403].includes(response.status) ? 502 : response.status,
        extractApiErrorMessage(payload) ?? "OpenAI could not start live transcription.");
      if (typeof payload?.value !== "string") throw new HttpError(502, "OpenAI returned no live transcription session.");
      return { clientSecret: payload.value, model, maxSeconds: MAX_LIVE_SECONDS, token: hold?.token ?? null };
    } catch (error) {
      if (hold) await billingService.settleHostedRequest({ requestId: hold.requestId, userId, amountMicros: 0, metadata: { outcome: "failed", usageSource: "not-billed" } });
      throw error;
    }
  }

  /** Settles a hosted live session at the time it ran. Repeats are harmless. */
  async function finishLive({ token, userId }) {
    if (typeof token !== "string" || !token.startsWith(LIVE_TOKEN_PREFIX)) throw new HttpError(400, "That live voice typing session is not valid.");
    let session;
    try { session = JSON.parse(decryptSecret(token.slice(LIVE_TOKEN_PREFIX.length), env)); }
    catch { throw new HttpError(400, "That live voice typing session is not valid."); }
    if (session?.userId !== userId) throw new HttpError(403, "That live voice typing session belongs to another account.");
    if (!billingService) throw new HttpError(503, "Billing is not configured.");
    const { seconds, amountMicros } = liveDictationCharge({ ...session, endedAt: now() });
    const result = await billingService.settleHostedRequest({ requestId: session.requestId, userId, amountMicros, metadata: {
      outcome: "completed", usageSource: "server-clock", seconds, amountMicros, reservedMicros: session.reservedMicros,
    } });
    return { settled: result?.settled !== false, seconds };
  }

  return { transcribe, startLive, finishLive };
}
