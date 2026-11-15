import { apiFetch } from "./apiTransport";

/**
 * Reading aloud in the language being learned. A sentence or more is read by
 * the account's neural voice when the server has one; a single word, or
 * anything when it doesn't, is read by the device's own voice.
 */
let serverVoices: boolean | null = null;
const clips = new Map<string, string>();
let current: { stop: () => void } | null = null;

export function stopSpeaking() { current?.stop(); current = null; }

export const deviceCanSpeak = () => typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";

function speakOnDevice(text: string, language: string, slow: boolean, onEnd: () => void): () => void {
  if (!deviceCanSpeak()) { onEnd(); return () => undefined; }
  let done = false;
  const finish = () => { if (!done) { done = true; onEnd(); } };
  try {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language;
    utterance.rate = slow ? 0.6 : 0.95;
    utterance.onend = finish;
    utterance.onerror = finish;
    speechSynthesis.speak(utterance);
  } catch { finish(); }
  return () => { done = true; try { speechSynthesis.cancel(); } catch { /* Nothing was speaking. */ } };
}

/** Whether text is long enough that the neural voice is worth asking for. */
export const wantsNeuralVoice = (text: string) => text.trim().split(/\s+/u).length >= 3 && text.length <= 1200;

/** Reads `text` aloud; whatever was being read stops. Returns a way to stop it. */
export function speak(text: string, language: string, { slow = false, onEnd = () => undefined }: { slow?: boolean; onEnd?: () => void } = {}): () => void {
  stopSpeaking();
  const clean = text.replace(/\s+/gu, " ").trim();
  if (!clean) { onEnd(); return () => undefined; }
  let stopped = false;
  let stopInner: () => void = () => undefined;
  const handle = { stop: () => { stopped = true; stopInner(); } };
  current = handle;
  const ended = () => { if (current === handle) current = null; if (!stopped) onEnd(); };
  const device = () => { if (!stopped) stopInner = speakOnDevice(clean, language, slow, ended); };
  if (serverVoices === false || !wantsNeuralVoice(clean) || typeof Audio === "undefined") { device(); return handle.stop; }
  const key = `${language}|${slow ? 1 : 0}|${clean}`;
  const play = (url: string) => {
    if (stopped) return;
    const audio = new Audio(url);
    audio.onended = ended;
    audio.onerror = device;
    stopInner = () => { audio.pause(); };
    void audio.play().catch(device);
  };
  const saved = clips.get(key);
  if (saved) { play(saved); return handle.stop; }
  const controller = new AbortController();
  stopInner = () => controller.abort();
  apiFetch(`/api/language-speech?${new URLSearchParams({ language, text: clean, ...(slow ? { slow: "1" } : {}) })}`, { credentials: "same-origin", signal: controller.signal })
    .then(async (response) => {
      // No voice service on this server, or not signed in: the device reads from now on.
      if (response.status === 503 || response.status === 401 || response.status === 404) serverVoices = response.status === 404 ? serverVoices : false;
      if (!response.ok) { device(); return; }
      serverVoices = true;
      const url = URL.createObjectURL(await response.blob());
      if (clips.size > 200) { const [first, old] = clips.entries().next().value as [string, string]; URL.revokeObjectURL(old); clips.delete(first); }
      clips.set(key, url);
      play(url);
    }, () => { if (!stopped) device(); });
  return handle.stop;
}
