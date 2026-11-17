export type LearningLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
export type MiniStoryVariant = "a" | "b" | "qa";
export const LEARNING_LEVELS: readonly LearningLevel[];
export function isLearningLevel(value: unknown): value is LearningLevel;
export function levelName(level: string): string;
export function levelRank(level: string): number;
export function isCourseLanguage(lang: unknown): lang is string;
export function termKey(text: string): string;

export interface WordToken { text: string; key?: string; word?: number }
export function tokenizeWords(text: string, language?: string): WordToken[];
export function splitSentences(text: string, language?: string): string[];
export function lessonParagraphs(body: string): string[];

export interface LessonToken { i: number; text: string; norm: string; isWord: boolean; sentence: number; paragraph: number }
export interface TokenizedLesson { tokens: LessonToken[]; wordCount: number; uniqueWordCount: number; norms: string[]; sentenceCount: number }
export function tokenizeLesson(body: string, language?: string): TokenizedLesson;
export function lessonNorms(body: string, language?: string): string[];

type StatusOf = (norm: string) => number | undefined;
export function percentNew(norms: ReadonlyArray<string>, statusOf: StatusOf): number;
export function newWordsBand(percent: number): "easy" | "fair" | "hard";
export function wordsToMarkKnown(norms: ReadonlyArray<string>, statusOf: StatusOf): string[];
export function statusAfterSavingMeaning(status: number | undefined): number;
export function statusAfterReview(status: number, grade: 1 | 2 | 3 | 4): number;

export function splitIntoLessons(sections: ReadonlyArray<{ heading?: string; paragraphs: string[] }>, options?: { target?: number; title?: string }): Array<{ title: string; body: string; words: number }>;
export function sourceFingerprint(text: string): string;
export function readStoryLines(source: string): { body: string; translation: string };
export function sentenceTranslations(translation: string | null | undefined, sentenceCount: number): string[] | null;

export const MINI_STORY_VARIANTS: readonly MiniStoryVariant[];
export function variantName(variant: string | null | undefined): string;
export function builtInMiniStoriesId(lang: string): string;
export function isBuiltInLessonId(id: unknown): boolean;

/** A lesson as the library and reader see it, shipped with the app or saved to the account. */
export interface CourseLesson {
  id: string; courseId: string | null; lang: string; pos: number; title: string; titleTranslation?: string; level: string;
  source: "builtin" | "generated" | "document" | "import"; body: string; translation: string | null;
  variant: MiniStoryVariant | null; storyGroup: string | null; storyNumber?: number; tags: string[];
  wordCount: number; uniqueWordCount: number; norms: string[]; sentenceCount: number;
  documentId?: string | null; sourceHash?: string | null; simplifiedFrom?: string | null; createdAt?: string; updatedAt?: string;
}
export interface Course {
  id: string; lang: string; title: string; description: string; kind: "mini_stories" | "guided" | "user"; builtIn?: boolean;
  level: string; levels?: string[]; lessonsCount: number; tags: string[]; documentId?: string | null; createdAt?: string;
}
export interface MiniStory { level: LearningLevel; topic?: string; a: [string, string, string]; b: [string, string, string]; qa: [string, string, string] }
export function builtInMiniStories(lang: string, stories: ReadonlyArray<MiniStory>, options?: { title?: string }): { course: Course; lessons: CourseLesson[] };
export function nextLessonIn<T extends { id: string; pos: number }>(lessons: ReadonlyArray<T>, lessonId: string): T | null;
export function suggestedStory<T extends { id: string; pos: number; storyGroup: string | null; variant: string | null; norms?: string[] }>(lessons: ReadonlyArray<T>, options: { completed: (id: string) => boolean; statusOf: StatusOf }): { group: string; lesson: T } | null;
