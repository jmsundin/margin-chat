import { HttpError } from "../lib/errors.mjs";

/**
 * Sentences and lessons read aloud in the language being learned, by Azure's
 * neural voices. Single words are spoken by the device instead: realistic
 * voices are at their best over a whole sentence and often garble one word.
 */
export const SPEECH_MAX_CHARACTERS = 1200;
/** The most text one account may have read aloud a day, so a runaway page can't run up the bill. */
export const SPEECH_DAILY_CHARACTERS = 150_000;

/** One neural voice per language; a region in the code (pt-BR) picks that region's voice when listed. */
export const SPEECH_VOICES = {
  ar: "ar-SA-ZariyahNeural", zh: "zh-CN-XiaoxiaoNeural", "zh-TW": "zh-TW-HsiaoChenNeural", cs: "cs-CZ-VlastaNeural", da: "da-DK-ChristelNeural",
  nl: "nl-NL-ColetteNeural", en: "en-US-JennyNeural", "en-GB": "en-GB-SoniaNeural", fi: "fi-FI-NooraNeural", fr: "fr-FR-DeniseNeural",
  "fr-CA": "fr-CA-SylvieNeural", de: "de-DE-KatjaNeural", el: "el-GR-AthinaNeural", he: "he-IL-HilaNeural", hi: "hi-IN-SwaraNeural",
  hu: "hu-HU-NoemiNeural", id: "id-ID-GadisNeural", it: "it-IT-ElsaNeural", ja: "ja-JP-NanamiNeural", ko: "ko-KR-SunHiNeural",
  no: "nb-NO-PernilleNeural", nb: "nb-NO-PernilleNeural", pl: "pl-PL-ZofiaNeural", pt: "pt-BR-FranciscaNeural", "pt-PT": "pt-PT-RaquelNeural",
  ro: "ro-RO-AlinaNeural", ru: "ru-RU-SvetlanaNeural", es: "es-ES-ElviraNeural", "es-MX": "es-MX-DaliaNeural", sv: "sv-SE-SofieNeural",
  th: "th-TH-PremwadeeNeural", tr: "tr-TR-EmelNeural", uk: "uk-UA-PolinaNeural", vi: "vi-VN-HoaiMyNeural",
};

export function speechVoice(language) {
  const code = String(language ?? "");
  const [primary, region] = code.split("-");
  return SPEECH_VOICES[region ? `${primary.toLowerCase()}-${region.toUpperCase()}` : ""] ?? SPEECH_VOICES[primary.toLowerCase()] ?? null;
}

const xml = (text) => text.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);

/** Text as a voice reads it best: one line, no Markdown marks, no stray spaces before punctuation (they make voices stutter). */
export function speechText(text) {
  return String(text ?? "").replace(/[*_`#>|~=]+/gu, " ").replace(/\s+/gu, " ").replace(/\s+([,.;:!?…»”)])/gu, "$1").trim();
}

export function speechSsml({ text, voice, slow }) {
  const locale = voice.split("-").slice(0, 2).join("-");
  const body = slow ? `<prosody rate="-30%">${xml(text)}</prosody>` : xml(text);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${voice}">${body}</voice></speak>`;
}

export function createLanguageSpeechService({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const used = new Map();

  function configured() {
    return Boolean(env.AZURE_SPEECH_KEY && /^[a-z0-9]+$/u.test(env.AZURE_SPEECH_REGION ?? ""));
  }

  /**
   * MP3 audio of `text` in `language`. 503 when no voice service is set up, so the page falls back to the device's voice.
   * `own` is the person's own Azure Speech key ({ region, key }): their account, so no daily cap here.
   */
  async function speak({ userId, text, language, slow = false, own = null }) {
    if (!own && !configured()) throw new HttpError(503, "Read-aloud voices aren't set up on this server.");
    const region = own?.region ?? env.AZURE_SPEECH_REGION, key = own?.key ?? env.AZURE_SPEECH_KEY;
    const clean = speechText(text);
    if (!clean) throw new HttpError(400, "There is no text to read aloud.");
    if (clean.length > SPEECH_MAX_CHARACTERS) throw new HttpError(413, `Read aloud at most ${SPEECH_MAX_CHARACTERS} characters at a time.`);
    const voice = speechVoice(language);
    if (!voice) throw new HttpError(404, "There is no read-aloud voice for this language yet.");
    const day = Math.floor(now() / 86_400_000);
    const tally = used.get(userId);
    const spent = tally?.day === day ? tally.characters : 0;
    if (!own && spent + clean.length > SPEECH_DAILY_CHARACTERS) throw new HttpError(429, "Today's read-aloud limit is used up. The device's own voice still works.");
    const response = await fetchImpl(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3", "User-Agent": "margin-chat",
      },
      body: speechSsml({ text: clean, voice, slow }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new HttpError(502, response.status === 401 || response.status === 403
      ? own ? "Azure refused your Speech key. Check its region and key in Settings → API keys." : "The read-aloud voice service refused its key. Check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION."
      : "The read-aloud voice service didn't answer. Try again.");
    if (!own) used.set(userId, { day, characters: spent + clean.length });
    return { audio: Buffer.from(await response.arrayBuffer()), voice };
  }

  return { configured, speak };
}
