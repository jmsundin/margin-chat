import { HttpError } from "../lib/errors.mjs";
import { extractApiErrorMessage } from "../chat/providers.mjs";
import { runMeteredProviderOperation } from "../billing/usage.mjs";

export const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
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

export function createDictationService({ env = process.env } = {}) {
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

  return { transcribe };
}
