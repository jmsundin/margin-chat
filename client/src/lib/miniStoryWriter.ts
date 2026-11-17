import { levelName, readStoryLines, tokenizeLesson } from "@margin-chat/workspace-contracts/languageCourses";
import { languageName } from "./languageLearning";

/**
 * Mini stories the AI writes for the learner, in the shape of the ones that come with the app: a short
 * story, the same story retold, and questions and answers about it. Each part is written one sentence
 * a line with its translation (`Satz | Sentence`), checked, and asked for again with the reason when
 * it isn't right.
 */

export interface StoryPlan { title: string; titleTranslation: string; newWords: string[]; outline: string }
export interface StoryPart { body: string; translation: string; lines: number }
export interface WrittenStory { title: string; titleTranslation: string; level: string; parts: { a: StoryPart; b: StoryPart; qa: StoryPart } }
export type Ask = (prompt: string, signal: AbortSignal) => Promise<string>;

const LINE_FORMAT = (lang: string, base: string) => [
  `Write one ${languageName(lang)} sentence a line, then " | ", then its ${languageName(base)} translation.`,
  "Leave a blank line between paragraphs. Write nothing else: no title, no numbering, no notes.",
].join(" ");

/** The JSON object in a reply, even when the model wrapped it in a code fence or a sentence. */
export function jsonIn(reply: string): Record<string, unknown> | null {
  const text = reply.replace(/```(?:json)?/giu, "");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { const value = JSON.parse(text.slice(start, end + 1)); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
}

export function planPrompt({ lang, base, level, topic, known }: { lang: string; base: string; level: string; topic?: string; known: ReadonlyArray<string> }): string {
  return [
    `Plan a short original story for someone learning ${languageName(lang)} at CEFR ${level} (${levelName(level)}), whose own language is ${languageName(base)}.`,
    topic?.trim() ? `It's about: ${topic.trim().slice(0, 300)}` : "Pick an everyday topic: home, food, work, travel, friends, shopping, weather or a small surprise.",
    "One or two characters, a small problem and how it ends. Original: never retell a story from a book, film or course.",
    known.length ? `The learner already knows these words; use many of them: ${known.slice(0, 300).join(", ")}.` : "",
    `Choose 8 to 15 new words (dictionary forms) the story will teach, common at ${level}.`,
    `Answer with JSON only: {"title": "${languageName(lang)} title", "titleTranslation": "${languageName(base)} title", "newWords": ["…"], "outline": "what happens, in 3 to 5 short sentences in ${languageName(base)}"}`,
  ].filter(Boolean).join("\n");
}

export function readPlan(reply: string): StoryPlan | null {
  const value = jsonIn(reply);
  if (!value || typeof value.title !== "string" || !value.title.trim()) return null;
  const words = Array.isArray(value.newWords) ? value.newWords.filter((word): word is string => typeof word === "string" && Boolean(word.trim())).slice(0, 20) : [];
  return { title: value.title.trim().slice(0, 120), titleTranslation: typeof value.titleTranslation === "string" ? value.titleTranslation.trim().slice(0, 120) : "",
    newWords: words, outline: typeof value.outline === "string" ? value.outline.trim().slice(0, 1200) : "" };
}

export function partPrompt(part: "a" | "b" | "qa", { lang, base, level, plan, story }: { lang: string; base: string; level: string; plan: StoryPlan; story?: string }): string {
  const name = languageName(lang);
  if (part === "a") return [
    `Write the story "${plan.title}" in ${name} for a learner at CEFR ${level} (${levelName(level)}).`,
    plan.outline ? `What happens: ${plan.outline}` : "",
    `Use these new words, each at least twice: ${plan.newWords.join(", ")}. Every other word should be common at ${level}.`,
    "12 to 20 short sentences in 3 or 4 paragraphs, in the present tense, told in the third person. Repeat words and sentence patterns: repetition is how it teaches.",
    LINE_FORMAT(lang, base),
  ].filter(Boolean).join("\n");
  if (part === "b") return [
    `Retell this ${name} story in the first person, as the main character tells it, in the past tense (the perfect, as people speak).`,
    "Keep the same events, words and number of sentences. Same line format.",
    LINE_FORMAT(lang, base), "", "The story:", story ?? "",
  ].join("\n");
  return [
    `Write 15 to 25 questions and answers in ${name} that walk through this story in order, for a learner at ${level}.`,
    "Mostly simple questions (who, what, where, yes or no); each answer is a full short sentence that repeats the question's words.",
    "Each question and each answer is its own line. No paragraph breaks.",
    LINE_FORMAT(lang, base), "", "The story:", story ?? "",
  ].join("\n");
}

/** A part as written, or why it isn't usable, said so the model can fix it. */
export function checkPart(reply: string, part: "a" | "b" | "qa", lang: string): { part: StoryPart } | { problem: string } {
  const lines = reply.replace(/```[a-z]*/giu, "").split("\n").map((line) => line.trim().replace(/^(?:\d+[.)]|[-*•])\s+/u, ""));
  const written = lines.filter(Boolean);
  if (!written.length) return { problem: "There was no text." };
  const missing = written.filter((line) => !line.includes(" | ")).length;
  if (missing > written.length / 4) return { problem: `Most lines need " | " and a translation; ${missing} of ${written.length} had none.` };
  const { body, translation } = readStoryLines(lines.filter((line) => !line || line.includes(" | ")).join("\n"));
  const cut = tokenizeLesson(body, lang);
  const count = translation.split("\n").length;
  if (cut.sentenceCount !== count) return { problem: `Write exactly one sentence on each line; ${count} lines held ${cut.sentenceCount} sentences.` };
  const [low, high] = part === "qa" ? [24, 54] : [8, 30];
  if (count < low || count > high) return { problem: part === "qa" ? `Write 15 to 25 questions, each with its answer; there were ${Math.round(count / 2)}.` : `Write 12 to 20 sentences; there were ${count}.` };
  return { part: { body, translation, lines: count } };
}

/** Writes a mini story in three parts, asking again (up to twice a part) with the reason when a part isn't right. */
export async function writeMiniStory({ lang, base, level, topic, known, ask, signal, onProgress }: {
  lang: string; base: string; level: string; topic?: string; known: ReadonlyArray<string>; ask: Ask; signal: AbortSignal; onProgress?: (step: string) => void;
}): Promise<WrittenStory> {
  onProgress?.("Planning the story…");
  let plan: StoryPlan | null = null;
  for (let attempt = 0; attempt < 2 && !plan; attempt++) plan = readPlan(await ask(planPrompt({ lang, base, level, topic, known }), signal));
  if (!plan) throw new Error("The AI didn't plan a story. Try again, or pick another model.");
  const write = async (part: "a" | "b" | "qa", story?: string) => {
    let prompt = partPrompt(part, { lang, base, level, plan: plan!, story });
    for (let attempt = 0; attempt < 3; attempt++) {
      const checked = checkPart(await ask(prompt, signal), part, lang);
      if ("part" in checked) return checked.part;
      prompt = `${partPrompt(part, { lang, base, level, plan: plan!, story })}\n\nYour last answer couldn't be used: ${checked.problem} Write it again.`;
    }
    throw new Error(`The AI couldn't write the ${part === "a" ? "story" : part === "b" ? "retelling" : "questions"} in the right shape. Try again, or pick another model.`);
  };
  onProgress?.("Writing the story…");
  const a = await write("a");
  const lined = (part: StoryPart) => {
    const translations = part.translation.split("\n");
    let index = 0;
    return part.body.split("\n\n").map((paragraph) => tokenizeLessonSentences(paragraph, lang).map((sentence) => `${sentence} | ${translations[index++] ?? ""}`).join("\n")).join("\n\n");
  };
  onProgress?.("Retelling it…");
  const b = await write("b", lined(a));
  onProgress?.("Writing questions…");
  const qa = await write("qa", lined(a));
  return { title: plan.title, titleTranslation: plan.titleTranslation, level, parts: { a, b, qa } };
}

/** A paragraph's sentences, cut the way lessons cut them. */
function tokenizeLessonSentences(paragraph: string, lang: string): string[] {
  const { tokens } = tokenizeLesson(paragraph, lang);
  const sentences: string[] = [];
  for (const token of tokens) sentences[token.sentence] = `${sentences[token.sentence] ?? ""}${token.text}`;
  return sentences.map((sentence) => sentence.trim()).filter(Boolean);
}
