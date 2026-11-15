import type { Message } from "../types";
import { formatTimestamp, parseMediaEmbed, type MediaEmbed } from "./documentMedia";
import { languageName, type LanguagePair } from "./languageLearning";
import type { ReaderParagraph } from "./languageReader";

/**
 * Lessons for Language learning mode. A lesson is an ordinary document. One
 * with its own audio starts with the recording and has a line for each stretch
 * of it, the same shape as notes on any recording:
 *
 *     ![[lesson.mp3]]
 *     - 0:00 Hola, me llamo Ana.
 *     - 0:04 Vivo en Madrid.
 *
 * so it plays in every view, and the reader follows along sentence by sentence.
 */

/** The recording a document is read along with: the first audio or video file it embeds. */
export function lessonAudioOf(blocks: ReadonlyArray<{ content: string }>): MediaEmbed | null {
  for (const block of blocks) {
    if (!/^\s*!\[/u.test(block.content)) continue;
    const embed = parseMediaEmbed(block.content.trim().split("\n")[0]);
    if (embed && (embed.kind === "audio" || embed.kind === "video")) return embed;
  }
  return null;
}

export interface LessonSegment { seconds: number; text: string }

/** A recording and what is said in it, as the document block that plays and reads along. */
export function lessonMarkdown(embed: string, segments: ReadonlyArray<LessonSegment>): string {
  const lines = segments.map((segment) => ({ seconds: segment.seconds, text: segment.text.replace(/\s+/gu, " ").trim() })).filter((segment) => segment.text);
  return [embed.trim(), ...lines.map((segment) => `- ${formatTimestamp(segment.seconds)} ${segment.text}`)].join("\n");
}

/**
 * When each sentence is spoken. A line's time is known; the sentences inside it
 * share the stretch up to the next line by their length, which is close enough
 * to follow along. The last line runs to the end of the recording.
 */
export function sentenceTimes(paragraphs: ReadonlyArray<ReaderParagraph>, duration: number | null): Array<{ index: number; start: number; end: number }> {
  const timed = paragraphs.filter((paragraph) => paragraph.time !== undefined && paragraph.sentences.length);
  const times: Array<{ index: number; start: number; end: number }> = [];
  timed.forEach((paragraph, position) => {
    const start = paragraph.time as number;
    const length = paragraph.sentences.reduce((sum, sentence) => sum + sentence.text.length, 0) || 1;
    const next = timed.slice(position + 1).find((later) => (later.time as number) > start)?.time;
    // About fifteen characters a second when nothing says where the line ends.
    const end = next ?? (duration && duration > start ? duration : start + Math.max(2, length / 15));
    let at = start;
    for (const sentence of paragraph.sentences) {
      const share = (end - start) * (sentence.text.length / length);
      times.push({ index: sentence.index, start: at, end: at + share });
      at += share;
    }
  });
  return times;
}

/** The sentence being spoken at `seconds`, or null before the first one. */
export function sentenceAtTime(times: ReadonlyArray<{ index: number; start: number; end: number }>, seconds: number): number | null {
  let found: number | null = null;
  for (const time of times) { if (time.start <= seconds + 0.05) found = time.index; else break; }
  return found;
}

export const LESSON_LEVELS: ReadonlyArray<{ id: string; name: string; hint: string }> = [
  { id: "A1", name: "A1 Beginner", hint: "very short sentences in the present tense, the few hundred most common words" },
  { id: "A2", name: "A2 Elementary", hint: "short everyday sentences, common words, simple past and future" },
  { id: "B1", name: "B1 Intermediate", hint: "clear standard language, some longer sentences, everyday idioms explained by context" },
  { id: "B2", name: "B2 Upper intermediate", hint: "natural language with varied sentences and less common words" },
  { id: "C1", name: "C1 Advanced", hint: "the full range of the language, as a well-written article for native readers" },
];

export type LessonSource =
  | { kind: "ai"; topic: string; level: string }
  | { kind: "document"; title: string; text: string; level: string };

const LESSON_SOURCE_LIMIT = 12_000;

/** Asks for a short text to read in the language being learned, on a topic or retelling a document. */
export function buildLessonMessages(source: LessonSource, pair: LanguagePair, createId: (prefix: string) => string): Message[] {
  const level = LESSON_LEVELS.find((item) => item.id === source.level) ?? LESSON_LEVELS[1];
  const language = languageName(pair.target);
  const task = source.kind === "ai"
    ? `Write a short text for me to read about: ${source.topic.trim().slice(0, 600)}`
    : `Retell this document of mine as a text for me to read. Keep what it says and its order; leave out code, tables and links.\n\nTitle: ${source.title}\n\n${source.text.slice(0, LESSON_SOURCE_LIMIT)}`;
  const content = [
    `I'm learning ${language}. ${task}`,
    "",
    `Write it in ${language} only, at CEFR level ${level.id}: ${level.hint}.`,
    source.kind === "ai" ? "Make it 150 to 250 words, in short paragraphs. A little story or a concrete scene reads better than a list of facts." : "Make it as long as it needs, up to about 600 words, in short paragraphs.",
    "",
    "Answer with the title on the first line, then a blank line, then the text. Plain text only: no Markdown, no translation, no notes, no word list.",
  ].join("\n");
  return [{ id: createId("message"), role: "user", content, createdAt: new Date().toISOString() }];
}

/** The title and text from the AI's answer, however it dressed them up. */
export function parseLessonReply(reply: string): { title: string; text: string } {
  const lines = reply.replace(/\r\n?/gu, "\n").replace(/^\s*```[a-z]*\n|\n```\s*$/giu, "").trim().split("\n");
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) throw new Error("The AI didn't send back a text. Try again.");
  const title = lines[first].replace(/^#+\s*/u, "").replace(/^(title|título|titre|titel)\s*:\s*/iu, "").replace(/^\*\*(.*)\*\*$/u, "$1").replace(/^["“„«]\s*|\s*["”»]$/gu, "").trim().slice(0, 120);
  const text = lines.slice(first + 1).join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  if (!text) throw new Error("The AI sent back only a title. Try again.");
  return { title: title || "Lesson", text };
}

/** A web page's Markdown as a lesson: its text, without pictures, and its source on top. */
export function pageLessonText(page: { url: string; text: string }): string {
  const body = page.text.split("\n").filter((line) => !/^\s*!\[/u.test(line)).join("\n").replace(/^#\s+.*\n+/u, "").replace(/\n{3,}/gu, "\n\n").trim();
  let host = "the page";
  try { host = new URL(page.url).hostname.replace(/^www\./u, ""); } catch { /* The address is still linked. */ }
  // A link, so the reader shows the site's name and not its address as words to learn.
  return `Source: [${host}](<${page.url.replace(/[<>]/gu, (character) => encodeURIComponent(character))}>)\n\n${body}`;
}

// ----- a recording into pieces short enough to give each line its time -----

export const LESSON_AUDIO_RATE = 16_000;
/** Decoding holds the whole recording in memory, so a lesson made from audio has a length limit. */
export const MAX_LESSON_AUDIO_SECONDS = 30 * 60;

export interface AudioPiece { from: number; to: number; quiet: boolean }

/**
 * Cuts speech into pieces of roughly `target` seconds, each cut placed in the
 * quietest moment near it so words aren't split. Pieces with no sound in them
 * are marked quiet and aren't worth transcribing.
 */
export function planAudioPieces(samples: Float32Array, rate: number, { target = 10, min = 5, max = 16 } = {}): AudioPiece[] {
  const window = Math.max(1, Math.round(rate * 0.05));
  const levels = new Float32Array(Math.ceil(samples.length / window));
  let loudest = 0;
  for (let index = 0; index < levels.length; index++) {
    let sum = 0;
    const end = Math.min(samples.length, (index + 1) * window);
    for (let at = index * window; at < end; at++) sum += samples[at] * samples[at];
    levels[index] = Math.sqrt(sum / Math.max(1, end - index * window));
    if (levels[index] > loudest) loudest = levels[index];
  }
  const silence = Math.max(0.002, loudest * 0.04);
  const perSecond = rate / window;
  const pieces: AudioPiece[] = [];
  let from = 0;
  while (from < levels.length) {
    let to = levels.length;
    if (levels.length - from > max * perSecond) {
      // The quietest window between the shortest and longest piece allowed, leaning toward the target.
      let best = Math.round(from + target * perSecond);
      let bestScore = Infinity;
      for (let at = Math.round(from + min * perSecond); at <= Math.round(from + max * perSecond) && at < levels.length; at++) {
        const quiet = (levels[at - 1] + levels[at] + (levels[at + 1] ?? levels[at])) / 3;
        const score = quiet / silence + Math.abs(at - (from + target * perSecond)) / (target * perSecond) * 0.5;
        if (score < bestScore) { bestScore = score; best = at; }
      }
      to = best;
    }
    let heard = 0;
    for (let at = from; at < to; at++) if (levels[at] > silence) heard++;
    pieces.push({ from: from * window, to: Math.min(samples.length, to * window), quiet: heard < perSecond * 0.3 });
    from = to;
  }
  return pieces;
}

/** 16-bit mono WAV, which every transcription service reads. */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
  text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return bytes;
}

/**
 * Writes down what a recording says, a piece at a time, so each line knows
 * when it starts. `transcribe` sends one piece of WAV audio and returns its words.
 */
export async function transcribeLesson(samples: Float32Array, rate: number,
  transcribe: (wav: Uint8Array, signal?: AbortSignal) => Promise<string>,
  { signal, onProgress, concurrency = 3 }: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; concurrency?: number } = {}): Promise<LessonSegment[]> {
  const pieces = planAudioPieces(samples, rate).filter((piece) => !piece.quiet);
  const texts = new Array<string>(pieces.length).fill("");
  let next = 0;
  let done = 0;
  onProgress?.(0, pieces.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, pieces.length) }, async () => {
    while (next < pieces.length) {
      const index = next++;
      signal?.throwIfAborted();
      texts[index] = (await transcribe(encodeWav(samples.subarray(pieces[index].from, pieces[index].to), rate), signal)).trim();
      onProgress?.(++done, pieces.length);
    }
  }));
  return pieces.map((piece, index) => ({ seconds: piece.from / rate, text: texts[index] })).filter((segment) => segment.text);
}

/** A recording as mono samples at the transcription rate. Browser only. */
export async function decodeLessonAudio(file: Blob): Promise<Float32Array> {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) throw new Error("This browser can't read audio files. Try another browser.");
  let context: AudioContext;
  try { context = new Context({ sampleRate: LESSON_AUDIO_RATE }); } catch { context = new Context(); }
  try {
    let buffer: AudioBuffer;
    try { buffer = await context.decodeAudioData(await file.arrayBuffer()); }
    catch { throw new Error("That file couldn't be read as audio. Try an MP3, M4A or WAV file."); }
    if (buffer.duration > MAX_LESSON_AUDIO_SECONDS) throw new Error(`That recording is ${Math.round(buffer.duration / 60)} minutes long. A lesson from a recording can be up to ${MAX_LESSON_AUDIO_SECONDS / 60} minutes.`);
    const mono = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < data.length; index++) mono[index] += data[index] / buffer.numberOfChannels;
    }
    return resampleAudio(mono, buffer.sampleRate, LESSON_AUDIO_RATE);
  } finally {
    void context.close().catch(() => undefined);
  }
}

/** Speech survives plain averaging down to the transcription rate; a browser that already decoded at that rate passes through. */
export function resampleAudio(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const result = new Float32Array(Math.floor(samples.length / ratio));
  for (let index = 0; index < result.length; index++) {
    const start = Math.floor(index * ratio);
    const end = Math.max(start + 1, Math.min(samples.length, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let at = start; at < end; at++) sum += samples[at];
    result[index] = sum / (end - start);
  }
  return result;
}
