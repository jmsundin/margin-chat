import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createApiHandler } from "../server/routes/api.mjs";
import { parseMediaBlock } from "../client/src/lib/documentMedia";
import { paginate, readerParagraphs } from "../client/src/lib/languageReader";
import {
  LESSON_AUDIO_RATE, buildLessonMessages, encodeWav, lessonAudioOf, lessonMarkdown, pageLessonText, parseLessonReply, planAudioPieces,
  resampleAudio, sentenceAtTime, sentenceTimes, transcribeLesson,
} from "../client/src/lib/languageLessons";

const lesson = "![[Attachments/al-mercado.mp3]]\n- 0:00 Hola, me llamo Ana. Vivo en Madrid.\n- 0:08 Hoy voy al mercado.\n- 0:12 Compro pan y fruta.";

describe("a lesson with its own recording", () => {
  test("is a recording followed by a line for each stretch of it, which plays in every view", () => {
    const markdown = lessonMarkdown("![[Attachments/al-mercado.mp3]]", [
      { seconds: 0, text: " Hola, me llamo Ana.  Vivo en Madrid. " }, { seconds: 8.4, text: "Hoy voy al mercado." }, { seconds: 10, text: "  " }, { seconds: 72, text: "Compro pan." },
    ]);
    expect(markdown).toBe("![[Attachments/al-mercado.mp3]]\n- 0:00 Hola, me llamo Ana. Vivo en Madrid.\n- 0:08 Hoy voy al mercado.\n- 1:12 Compro pan.");
    const block = parseMediaBlock(markdown);
    expect(block?.embed).toMatchObject({ kind: "audio", source: "vault", target: "Attachments/al-mercado.mp3" });
    expect(block?.timestamps.map((stamp) => [stamp.seconds, stamp.note])).toEqual([[0, "Hola, me llamo Ana. Vivo en Madrid."], [8, "Hoy voy al mercado."], [72, "Compro pan."]]);
  });

  test("the reader takes its lines as the text, each with its time, and finds the recording", () => {
    const blocks = [{ id: "t", content: "# Al mercado" }, { id: "a", content: lesson }, { id: "n", content: "Una nota mía." }];
    const paragraphs = readerParagraphs(blocks, "es");
    expect(paragraphs.map((paragraph) => [paragraph.time, paragraph.sentences.map((sentence) => sentence.text)])).toEqual([
      [undefined, ["Al mercado"]], [0, ["Hola, me llamo Ana.", "Vivo en Madrid."]], [8, ["Hoy voy al mercado."]], [12, ["Compro pan y fruta."]], [undefined, ["Una nota mía."]],
    ]);
    expect(lessonAudioOf(blocks)).toMatchObject({ kind: "audio", target: "Attachments/al-mercado.mp3" });
    expect(lessonAudioOf([{ content: "![[foto.png]]" }, { content: "Solo texto." }])).toBeNull();
    expect(paginate(paragraphs).length).toBe(1);
    // Saved documents keep the recording and its lines as separate blocks; they read the same.
    const [embed, ...lines] = lesson.split("\n");
    const split = [{ id: "e", content: embed }, { id: "l", content: lines.join("\n") }];
    expect(readerParagraphs(split, "es").map((paragraph) => paragraph.time)).toEqual([0, 8, 12]);
    expect(lessonAudioOf(split)?.target).toBe("Attachments/al-mercado.mp3");
    // Without a recording, a list line that starts with a time is just text.
    expect(readerParagraphs([{ id: "l", content: "- 0:08 Hoy voy." }], "es").map((paragraph) => [paragraph.time, paragraph.sentences[0].text])).toEqual([[undefined, "0:08 Hoy voy."]]);
  });

  test("a picture or a recording with ordinary text under it is not read as timed lines", () => {
    expect(readerParagraphs([{ id: "a", content: "![[foto.png]]\n\nHola." }], "es").map((paragraph) => paragraph.time)).toEqual([undefined]);
    expect(readerParagraphs([{ id: "a", content: "![[clip.mp3]]\nHola a todos." }], "es").map((paragraph) => [paragraph.time, paragraph.sentences[0].text])).toEqual([[undefined, "Hola a todos."]]);
  });

  test("sentences inside a line share its stretch of the recording by their length", () => {
    const times = sentenceTimes(readerParagraphs([{ id: "a", content: lesson }], "es"), 20);
    expect(times.map((time) => time.index)).toEqual([0, 1, 2, 3]);
    expect(times[0].start).toBe(0);
    expect(times[1].start).toBeGreaterThan(3);
    expect(times[1].start).toBeLessThan(5.5);
    expect(times[1].end).toBeCloseTo(8, 5);
    expect([times[2].start, times[2].end]).toEqual([8, 12]);
    // The last line runs to the end of the recording, or a guess from its length when that isn't known yet.
    expect(times[3].end).toBe(20);
    expect(sentenceTimes(readerParagraphs([{ id: "a", content: lesson }], "es"), null)[3].end).toBeGreaterThan(13);
    expect(sentenceAtTime(times, 0)).toBe(0);
    expect(sentenceAtTime(times, 7.9)).toBe(1);
    expect(sentenceAtTime(times, 8)).toBe(2);
    expect(sentenceAtTime(times, 500)).toBe(3);
    expect(sentenceAtTime(sentenceTimes(readerParagraphs([{ id: "a", content: "![[a.mp3]]\n- 0:05 Hola." }], "es"), 9), 2)).toBeNull();
  });
});

describe("making a lesson", () => {
  let id = 0;
  const createId = (prefix: string) => `${prefix}-${id++}`;

  test("the AI is asked for the language, the level and plain text", () => {
    const [written] = buildLessonMessages({ kind: "ai", topic: "a morning at the market", level: "A2" }, { target: "es", base: "en" }, createId);
    expect(written.role).toBe("user");
    expect(written.content).toContain("I'm learning Spanish.");
    expect(written.content).toContain("a morning at the market");
    expect(written.content).toContain("CEFR level A2");
    expect(written.content).toContain("no Markdown");
    const [retold] = buildLessonMessages({ kind: "document", title: "mTOR", text: "x".repeat(20_000), level: "B1" }, { target: "de", base: "en" }, createId);
    expect(retold.content).toContain("Retell this document of mine");
    expect(retold.content).toContain("Title: mTOR");
    expect(retold.content.length).toBeLessThan(13_500);
  });

  test("the answer's first line is the title, however it was dressed up", () => {
    expect(parseLessonReply("Una mañana en el mercado\n\nAna va al mercado.\n\n\n\nCompra pan.")).toEqual({ title: "Una mañana en el mercado", text: "Ana va al mercado.\n\nCompra pan." });
    expect(parseLessonReply("# **En el mercado**\n\nHola.").title).toBe("**En el mercado**".replace(/\*/gu, ""));
    expect(parseLessonReply("Title: «El pan»\nHola.")).toEqual({ title: "El pan", text: "Hola." });
    expect(() => parseLessonReply("  \n ")).toThrow("didn't send back a text");
    expect(() => parseLessonReply("Solo un título")).toThrow("only a title");
  });

  test("a web page becomes its text with the source on top, without its pictures or repeated title", () => {
    expect(pageLessonText({ url: "https://example.com/a<b>", text: "# Titular\n\nPrimer párrafo.\n\n![foto](https://example.com/x.png)\n\n\n\nSegundo." }))
      .toBe("Source: [example.com](<https://example.com/a%3Cb%3E>)\n\nPrimer párrafo.\n\nSegundo.");
  });
});

describe("writing down a recording", () => {
  const rate = 1000;
  /** Speech-like noise with a pause of silence from 9.5 s to 10.5 s, then more speech and a long silent tail. */
  function recording() {
    const samples = new Float32Array(rate * 40);
    for (let index = 0; index < rate * 24; index++) {
      const second = index / rate;
      if (second >= 9.5 && second < 10.5) continue;
      samples[index] = Math.sin(index * 0.7) * 0.5;
    }
    return samples;
  }

  test("is cut in the quiet moments, and silent pieces are left out", () => {
    const pieces = planAudioPieces(recording(), rate);
    expect(pieces[0].from).toBe(0);
    // The first cut lands in the pause, not in the middle of a word.
    expect(pieces[0].to / rate).toBeGreaterThanOrEqual(9.5);
    expect(pieces[0].to / rate).toBeLessThanOrEqual(10.6);
    expect(pieces.every((piece, index) => index === 0 || piece.from === pieces[index - 1].to)).toBe(true);
    expect(pieces.at(-1)!.to).toBe(rate * 40);
    expect(pieces.every((piece) => (piece.to - piece.from) / rate <= 16.1)).toBe(true);
    expect(pieces.filter((piece) => piece.quiet).length).toBeGreaterThanOrEqual(1);
    expect(pieces.filter((piece) => !piece.quiet).every((piece) => piece.from < rate * 24)).toBe(true);
    expect(planAudioPieces(new Float32Array(rate * 3).fill(0.3), rate)).toEqual([{ from: 0, to: rate * 3, quiet: false }]);
  });

  test("each piece is sent as WAV and comes back as a line with its starting time", async () => {
    const sent: number[] = [];
    const progress: string[] = [];
    const segments = await transcribeLesson(recording(), rate, async (wav) => {
      expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
      expect(new DataView(wav.buffer).getUint32(24, true)).toBe(rate);
      sent.push((wav.length - 44) / 2);
      return sent.length === 2 ? "  " : ` Parte ${sent.length} `;
    }, { concurrency: 1, onProgress: (done, total) => progress.push(`${done}/${total}`) });
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(segments[0]).toEqual({ seconds: 0, text: "Parte 1" });
    // A piece nothing was heard in leaves no line.
    expect(segments.some((segment) => !segment.text)).toBe(false);
    expect(segments.length).toBe(sent.length - 1);
    expect(progress[0]).toBe(`0/${sent.length}`);
    expect(progress.at(-1)).toBe(`${sent.length}/${sent.length}`);
    const stopped = new AbortController();
    stopped.abort();
    await expect(transcribeLesson(recording(), rate, async () => "x", { signal: stopped.signal })).rejects.toThrow();
  });

  test("WAV is 16-bit mono, and audio is brought down to the transcription rate", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]), LESSON_AUDIO_RATE);
    const view = new DataView(wav.buffer);
    expect(wav.length).toBe(44 + 8);
    expect([view.getUint16(22, true), view.getUint16(34, true), view.getUint32(40, true)]).toEqual([1, 16, 8]);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true), view.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
    expect([...resampleAudio(new Float32Array([1, 3, 5, 7, 9, 11]), 48_000, 16_000)]).toEqual([3, 9]);
    const same = new Float32Array([1, 2]);
    expect(resampleAudio(same, 16_000, 16_000)).toBe(same);
  });
});

describe("reading a web page for a lesson", () => {
  let server: ReturnType<typeof createServer>, origin: string;
  const asked: Array<{ url: string; options: any }> = [];
  const headers = { "Content-Type": "application/json", "X-Test-Signed-In": "1", "X-Margin-Vault-User": "owner" };
  beforeAll(async () => {
    server = createServer(createApiHandler({ runtimeConfig: { host: "127.0.0.1", port: 0 },
      lessonPageReader: async (url: string, options: any) => { asked.push({ url, options }); return { url, title: "El tiempo", text: url.includes("vacía") ? "  " : "# El tiempo\n\nHoy hace sol.", truncated: false }; },
      authService: { getAuthContext: async (request: any) => ({ user: request.headers["x-test-signed-in"] ? { id: "owner" } : null }) } }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  test("only the signed-in person's own app may ask, and nothing is read otherwise", async () => {
    const body = JSON.stringify({ url: "https://example.org/tiempo" });
    expect((await fetch(`${origin}/api/language-lessons/page`, { method: "POST", body })).status).toBe(401);
    for (const [overrides, status] of [[{ "X-Margin-Vault-User": "other" }, 409], [{ "Sec-Fetch-Site": "cross-site" }, 403], [{ "Content-Type": "text/plain" }, 403]] as const) {
      expect((await fetch(`${origin}/api/language-lessons/page`, { method: "POST", headers: { ...headers, ...overrides }, body })).status).toBe(status);
    }
    expect((await fetch(`${origin}/api/language-lessons/page`, { method: "POST", headers, body: JSON.stringify({ url: "" }) })).status).toBe(400);
    expect(asked.length).toBe(0);
  });

  test("returns the page's title and text as Markdown without link addresses", async () => {
    const response = await fetch(`${origin}/api/language-lessons/page`, { method: "POST", headers, body: JSON.stringify({ url: " https://example.org/tiempo " }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ url: "https://example.org/tiempo", title: "El tiempo", text: "# El tiempo\n\nHoy hace sol.", truncated: false });
    expect(asked[0].url).toBe("https://example.org/tiempo");
    expect(asked[0].options).toMatchObject({ markdown: true, markdownLinks: false, textLimit: 30_000 });
    const empty = await fetch(`${origin}/api/language-lessons/page`, { method: "POST", headers, body: JSON.stringify({ url: "https://example.org/vacía" }) });
    expect(empty.status).toBe(422);
    expect((await empty.json()).error).toContain("no text to read");
  });
});
