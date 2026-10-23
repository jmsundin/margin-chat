/** OpenAI's live transcription over WebRTC: the microphone goes straight to OpenAI and words come back as they're heard. */
const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export interface LiveTranscription {
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
      return false;
    },
    text,
    pending: () => [...items.values()].some((item) => !item.done),
    heard: () => items.size > 0,
  };
}

export async function startLiveTranscription(options: {
  stream: MediaStream;
  clientSecret: string;
  onText: (text: string) => void;
  /** The connection broke or OpenAI reported an error before `finish`; the words so far may be incomplete. */
  onDrop?: () => void;
  /** The connection is up: from here on, what the microphone hears reaches OpenAI. */
  onOpen?: () => void;
  fetch?: typeof fetch;
}): Promise<LiveTranscription> {
  const connection = new RTCPeerConnection();
  const transcript = createTranscriptAssembler();
  let failed = false;
  let closed = false;
  let settle: (() => void) | null = null;
  let finishing = false;
  const drop = () => {
    failed = true;
    if (!closed && !finishing) options.onDrop?.();
  };
  options.stream.getAudioTracks().forEach((track) => connection.addTrack(track, options.stream));
  const channel = connection.createDataChannel("oai-events");
  channel.addEventListener("message", (message) => {
    let event: { type?: string } & Record<string, unknown>;
    try { event = JSON.parse(String(message.data)); } catch { return; }
    if (event.type === "error") {
      // Committing an empty buffer is expected when nothing was said.
      const code = (event.error as { code?: string } | undefined)?.code;
      if (code !== "input_audio_buffer_commit_empty") drop();
      settle?.();
      return;
    }
    if (transcript.apply(event)) options.onText(transcript.text());
    if (event.type === "conversation.item.input_audio_transcription.completed" && !transcript.pending()) settle?.();
  });
  const close = () => {
    if (closed) return;
    closed = true;
    channel.close();
    connection.close();
  };
  try {
    await connection.setLocalDescription(await connection.createOffer());
    const response = await (options.fetch ?? fetch)(CALLS_URL, {
      method: "POST",
      body: connection.localDescription?.sdp,
      headers: { Authorization: `Bearer ${options.clientSecret}`, "Content-Type": "application/sdp" },
    });
    if (!response.ok) throw new Error("OpenAI could not start live transcription.");
    await connection.setRemoteDescription({ type: "answer", sdp: await response.text() });
  } catch (error) {
    close();
    throw error;
  }
  // Sessions end on their own after a long time, or when the network drops.
  channel.addEventListener("close", () => { if (!closed) drop(); });
  connection.addEventListener?.("connectionstatechange", () => {
    if (connection.connectionState === "failed" || connection.connectionState === "closed") drop();
  });
  const opened = channel.readyState === "open"
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => {
      channel.addEventListener("open", () => resolve(true), { once: true });
      channel.addEventListener("close", () => resolve(false), { once: true });
    });
  void opened.then((open) => { if (open && !closed) options.onOpen?.(); });

  return {
    async finish({ timeoutMs = 4000, tailMs = 300 } = {}) {
      if (closed) return null;
      finishing = true;
      const deadline = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
      if (await Promise.race([opened, deadline.then(() => false)])) {
        // The last words are still on their way; commit once they've arrived.
        await new Promise((resolve) => setTimeout(resolve, tailMs));
        const done = new Promise<void>((resolve) => { settle = resolve; });
        if (closed) return null;
        channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        await Promise.race([done, deadline]);
      }
      close();
      if (failed && !transcript.heard()) return null;
      return transcript.text();
    },
    close,
  };
}
