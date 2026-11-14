/**
 * OpenAI's live transcription over a WebSocket: the microphone's audio goes
 * straight to OpenAI and words come back as they're heard. Audio sent before
 * the connection is up waits here and goes out the moment it opens, so the
 * first words are never lost and nobody has to wait to start talking.
 */
const SOCKET_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
/** OpenAI's live transcription takes mono 16-bit PCM at this rate. */
export const LIVE_SAMPLE_RATE = 24_000;
// A pause this long after this much speech ends a turn, so its words settle while the person keeps talking
// and stopping only waits for the last few seconds.
const PAUSE_MS = 800;
const SHORTEST_TURN_MS = 3000;
// Loudness (RMS of samples from -1 to 1) that counts as talking, well above a quiet room's.
const SPEECH_RMS = 0.02;
// Audio waiting for the connection goes out in messages of about this length.
const FLUSH_SAMPLES = LIVE_SAMPLE_RATE;

export interface LiveTranscription {
  /** Adds the next stretch of microphone audio, 16-bit PCM at `LIVE_SAMPLE_RATE`. */
  append(pcm: Int16Array): void;
  /** Asks for the final text of everything said so far and closes the connection. Null when nothing usable came back. */
  finish(options?: { timeoutMs?: number; tailMs?: number }): Promise<string | null>;
  close(): void;
}

interface TranscriptItem { text: string; done: boolean }

export function createTranscriptAssembler() {
  const items = new Map<string, TranscriptItem>();
  const text = () => [...items.values()].map((item) => item.text.trim()).filter(Boolean).join(" ");
  return {
    /** Applies one server event; returns true when the shown text changed. */
    apply(event: { type?: string; item_id?: string; delta?: string; transcript?: string }): boolean {
      if (typeof event.item_id !== "string") return false;
      const item = items.get(event.item_id) ?? { text: "", done: false };
      items.set(event.item_id, item);
      if (event.type === "conversation.item.input_audio_transcription.delta" && typeof event.delta === "string" && !item.done) {
        item.text += event.delta;
        return true;
      }
      if (event.type === "conversation.item.input_audio_transcription.completed" && typeof event.transcript === "string") {
        // An empty final for a turn whose words already came in keeps those words, rather than erasing them.
        if (event.transcript.trim() || !item.text.trim()) item.text = event.transcript;
        item.done = true;
        return true;
      }
      if (event.type === "conversation.item.input_audio_transcription.failed") {
        // The words already shown for a failed turn stay.
        item.done = true;
        return false;
      }
      return false;
    },
    text,
    pending: () => [...items.values()].some((item) => !item.done),
    heard: () => items.size > 0,
  };
}

function toBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

function loudness(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (const sample of pcm) sum += (sample / 32768) ** 2;
  return Math.sqrt(sum / pcm.length);
}

/**
 * Splits the microphone's audio into turns at the person's pauses. Returns true when
 * the audio so far should be committed, so its final words arrive while they keep talking.
 */
export function createPauseDetector({ pauseMs = PAUSE_MS, shortestTurnMs = SHORTEST_TURN_MS, speechRms = SPEECH_RMS } = {}) {
  let turnMs = 0;
  let quietMs = 0;
  let spoke = false;
  return {
    push(pcm: Int16Array): boolean {
      const ms = (pcm.length / LIVE_SAMPLE_RATE) * 1000;
      turnMs += ms;
      if (loudness(pcm) >= speechRms) { spoke = true; quietMs = 0; } else quietMs += ms;
      return spoke && quietMs >= pauseMs && turnMs >= shortestTurnMs;
    },
    /** Whether the current turn holds any speech worth committing. */
    spoke: () => spoke,
    hasAudio: () => turnMs >= 100,
    reset() { turnMs = 0; quietMs = 0; spoke = false; },
  };
}

export function startLiveTranscription(options: {
  clientSecret: string;
  onText: (text: string) => void;
  /** The connection broke or OpenAI reported an error before `finish`; the words so far may be incomplete. */
  onDrop?: () => void;
  /** The connection is up and the audio so far has gone out. */
  onOpen?: () => void;
  WebSocket?: typeof WebSocket;
}): LiveTranscription {
  const Socket = options.WebSocket ?? WebSocket;
  // A browser can't set headers on a WebSocket, so the short-lived key rides in the protocol list, as OpenAI documents.
  const socket = new Socket(SOCKET_URL, ["realtime", `openai-insecure-api-key.${options.clientSecret}`]);
  const transcript = createTranscriptAssembler();
  const pauses = createPauseDetector();
  // Audio heard before the connection opened.
  let waiting: Int16Array[] = [];
  let open = false;
  let failed = false;
  let closed = false;
  let finishing = false;
  // Commits whose final text hasn't come back yet.
  let outstanding = 0;
  let settle: (() => void) | null = null;
  const settleIfDone = () => { if (outstanding <= 0) settle?.(); };
  const drop = () => {
    failed = true;
    if (!closed && !finishing) options.onDrop?.();
    settle?.();
  };
  const send = (message: unknown) => { if (open && !closed) socket.send(JSON.stringify(message)); };
  const commit = () => {
    pauses.reset();
    outstanding += 1;
    send({ type: "input_audio_buffer.commit" });
  };
  const sendAudio = (pcm: Int16Array) => {
    send({ type: "input_audio_buffer.append", audio: toBase64(pcm) });
    if (pauses.push(pcm)) commit();
  };
  const flush = () => {
    const chunks = waiting;
    waiting = [];
    // Sent in stretches, so a pause in what was said before the connection opened still ends a turn.
    let batch: Int16Array[] = [];
    let size = 0;
    const out = () => {
      if (!size) return;
      const joined = new Int16Array(size);
      let at = 0;
      for (const chunk of batch) { joined.set(chunk, at); at += chunk.length; }
      sendAudio(joined);
      batch = [];
      size = 0;
    };
    for (const chunk of chunks) {
      batch.push(chunk);
      size += chunk.length;
      if (size >= FLUSH_SAMPLES / 4) out();
    }
    out();
  };

  socket.addEventListener("open", () => {
    if (closed) return;
    open = true;
    flush();
    options.onOpen?.();
  });
  socket.addEventListener("message", (message: MessageEvent) => {
    let event: { type?: string } & Record<string, unknown>;
    try { event = JSON.parse(String(message.data)); } catch { return; }
    if (event.type === "error") {
      // Committing an empty buffer is expected when nothing was said since the last turn.
      const code = (event.error as { code?: string } | undefined)?.code;
      if (code === "input_audio_buffer_commit_empty") { outstanding -= 1; settleIfDone(); return; }
      drop();
      return;
    }
    if (transcript.apply(event)) options.onText(transcript.text());
    if (event.type === "conversation.item.input_audio_transcription.completed" || event.type === "conversation.item.input_audio_transcription.failed") {
      outstanding -= 1;
      settleIfDone();
    }
  });
  // Sessions end on their own after a long time, or when the network drops.
  socket.addEventListener("close", () => { if (!closed) drop(); });
  socket.addEventListener("error", () => { if (!closed) drop(); });
  const opened = new Promise<boolean>((resolve) => {
    socket.addEventListener("open", () => resolve(true), { once: true });
    socket.addEventListener("close", () => resolve(false), { once: true });
    socket.addEventListener("error", () => resolve(false), { once: true });
  });

  const close = () => {
    if (closed) return;
    closed = true;
    waiting = [];
    try { socket.close(); } catch { /* Already closed. */ }
  };

  return {
    append(pcm) {
      if (closed || failed || !pcm.length) return;
      if (open) sendAudio(pcm);
      else waiting.push(pcm);
    },
    async finish({ timeoutMs = 4000, tailMs = 200 } = {}) {
      if (closed) return null;
      finishing = true;
      const deadline = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
      if (!failed && await Promise.race([opened, deadline.then(() => false)])) {
        // The last words are still on their way from the microphone; commit once they've arrived.
        await new Promise((resolve) => setTimeout(resolve, tailMs));
        const done = new Promise<void>((resolve) => { settle = resolve; });
        if (closed) return null;
        if (pauses.hasAudio() && (pauses.spoke() || transcript.pending() || !transcript.heard())) commit();
        if (outstanding > 0) await Promise.race([done, deadline]);
      }
      close();
      if (failed && !transcript.heard()) return null;
      return transcript.text();
    },
    close,
  };
}
