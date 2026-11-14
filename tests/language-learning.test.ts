import { describe, expect, test } from "bun:test";
import { createMarkdownWorkspace, discoverMarkdownWorkspace, normalizeLanguageLearning, parseMarkdownWorkspace } from "@margin-chat/workspace-contracts";
import { createEmptyState } from "../client/src/initialState";
import {
  buildLookupMessages, meaningCardLine, parseLookupReply, plainReadingText, readWiktionary, savedMeaningIn, sentenceAround, snapToWords, wordAt, wordsDeckTitle,
} from "../client/src/lib/languageLearning";
import { parseFlashcards } from "../client/src/lib/flashcards";

const at = "2026-11-14T10:00:00.000Z";

function documentFile(extra: Record<string, unknown>) {
  const state = createEmptyState();
  const conversation = state.conversations[state.rootId];
  Object.assign(conversation, { id: "doc", title: "Al mercado", createdAt: at, updatedAt: at, childIds: [], ...extra });
  conversation.document = { schemaVersion: 1, prompts: [], generations: [],
    blocks: [{ id: "b", kind: "markdown", content: "Cada sábado por la mañana, Lucía va al mercado.", createdAt: at, updatedAt: at, authorship: "user" }] } as any;
  state.conversations = { doc: conversation };
  const [[path, content]] = Object.entries(createMarkdownWorkspace(state, at).files as Record<string, string>);
  return { path, content };
}

describe("a document's Language learning mode", () => {
  test("is saved in frontmatter as the two languages and opens the same way again", () => {
    const { path, content } = documentFile({ languageLearning: { target: "es", base: "en" } });
    expect(content).toContain("learning-language: es");
    expect(content).toContain("translate-into: en");
    const { manifest, files } = discoverMarkdownWorkspace({ [path]: content });
    expect(parseMarkdownWorkspace(manifest, files)!.conversations.doc.languageLearning).toEqual({ target: "es", base: "en" });
    expect(documentFile({}).content).not.toContain("learning-language");
  });

  test("reads hand-written frontmatter, and needs two different, valid languages", () => {
    const source = "---\nmargin-chat-id: \"hand\"\ntitle: \"Hand\"\nlearning-language: pt-BR\ntranslate-into: EN\n---\n\n# Hand\n\nOlá.\n";
    const { manifest, files } = discoverMarkdownWorkspace({ "Hand.md": source });
    const parsed = parseMarkdownWorkspace(manifest, files)!;
    expect(Object.values(parsed.conversations).find((item) => item.title === "Hand")?.languageLearning).toEqual({ target: "pt-BR", base: "en" });
    expect(normalizeLanguageLearning({ target: "es", base: "es" })).toBeNull();
    expect(normalizeLanguageLearning({ target: "Spanish!", base: "en" })).toBeNull();
    expect(normalizeLanguageLearning(null)).toBeNull();
  });
});

describe("looking up what text means", () => {
  const text = "Cuando vuelve a casa, la bolsa pesa más. Pero ella se siente ligera.";

  test("a click finds the whole word, and a drag that stops mid-word takes whole words", () => {
    const at = text.indexOf("pesa") + 2;
    expect(text.slice(wordAt(text, at)!.from, wordAt(text, at)!.to)).toBe("pesa");
    expect(wordAt(text, text.indexOf(",") + 1)).toBeNull();
    const drag = snapToWords(text, text.indexOf("bolsa") + 2, text.indexOf("más") + 1);
    expect(text.slice(drag.from, drag.to)).toBe("bolsa pesa más");
  });

  test("its sentence comes along as context", () => {
    expect(sentenceAround(text, text.indexOf("pesa"), text.indexOf("pesa") + 4)).toBe("Cuando vuelve a casa, la bolsa pesa más.");
  });

  test("Markdown syntax is left out of what's looked up", () => {
    expect(plainReadingText("**La bolsa** pesa [[Más|más]] y _ligera_ ==hoy==")).toBe("La bolsa pesa más y ligera hoy");
    expect(plainReadingText("## Al [mercado](https://example.com)")).toBe("Al mercado");
  });

  test("the AI is asked for the meaning in the reader's language, or the other way for text already in it", () => {
    let n = 0;
    const [system, user] = buildLookupMessages({ text: "pesa", sentence: "La bolsa pesa más.", pair: { target: "es", base: "en" } }, () => `id${n++}`);
    expect(system.role).toBe("system");
    expect(system.content).toContain("If the text is instead in the learner's own language");
    expect(user.content).toContain('"selected":"pesa"');
    expect(user.content).toContain('"name":"Spanish"');
  });

  test("reads the AI's JSON, even fenced, and keeps a plain reply as the meaning", () => {
    const pair = { target: "es", base: "en" };
    const answer = parseLookupReply('```json\n{"from":"es","to":"en","meaning":"weighs","note":"Here: is heavier.","lemma":"pesar","partOfSpeech":"verb","others":["weighs","is heavy","regrets"]}\n```', pair);
    expect(answer).toMatchObject({ from: "es", to: "en", meaning: "weighs", lemma: "pesar", others: ["is heavy", "regrets"] });
    const reverse = parseLookupReply('{"from":"en","to":"es","meaning":"la bolsa"}', pair);
    expect(reverse).toMatchObject({ from: "en", to: "es" });
    expect(parseLookupReply("weighs", pair)).toMatchObject({ meaning: "weighs", from: "es", to: "en" });
  });

  test("reads Wiktionary's definitions for the language being learned only", () => {
    const body = { es: [{ partOfSpeech: "Verb", definitions: [{ definition: "<i>third-person singular</i> of <a>pesar</a>" }] }], en: [{ partOfSpeech: "Noun", definitions: [{ definition: "other" }] }] };
    expect(readWiktionary(body, "es")).toEqual([{ partOfSpeech: "Verb", definitions: ["third-person singular of pesar"] }]);
    expect(readWiktionary(body, "fr")).toEqual([]);
  });
});

describe("a saved meaning", () => {
  test("is a flashcard line Review already reads, with its sentence on the front", () => {
    const line = meaningCardLine("pesa", "weighs", "La bolsa pesa más.");
    expect(line).toBe("**pesa** · _La bolsa pesa más._ :: weighs");
    const [card] = parseFlashcards("deck", line);
    expect(card.back).toContain("weighs");
    expect(savedMeaningIn(`intro\n\n${line}`, "pesa")).toBe("weighs");
    expect(savedMeaningIn(line, "bolsa")).toBeNull();
    expect(wordsDeckTitle("es")).toBe("Spanish words");
  });
});
