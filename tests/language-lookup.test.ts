import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import * as languageTermRepository from "../server/db/languageTermRepository.mjs";
import {
  LOOKUP_TTL, MACHINE_DAILY_CHARACTERS, cacheTerm, createDeepLTranslator, createLanguageLookupService, createWiktionarySource, formOfTarget, isFresh,
  machineTranslatorFor, plainText, readKaikki, readParsedPage, readRestDefinitions, termCandidates,
} from "../server/languageTerms/lookup.mjs";
import { buildLookupMessages, parseLookupReply, partialLookupReply, wiktionaryFrameUrl } from "../client/src/lib/languageLearning";
import { LanguageTermStore } from "../client/src/lib/languageTerms";

const formOf = (lemma: string, text: string) => `<span class="form-of-definition use-with-mention">${text} <span class="form-of-definition-link"><i class="Latn mention" lang="de"><a href="/wiki/${lemma}#German" title="${lemma}">${lemma}</a></i></span>:</span>`;
const PAGES: Record<string, unknown> = {
  "Frühstück": { de: [{ partOfSpeech: "Noun", language: "German", definitions: [{ definition: '<a href="/wiki/breakfast">breakfast</a>',
    parsedExamples: [{ example: "Gewöhnlich essen sie ihr <b>Frühstück</b> im Bett.", translation: "They usually have their <b>breakfast</b> in bed." }] }] }] },
  und: { de: [{ partOfSpeech: "Conjunction", language: "German", definitions: [{ definition: "<a>and</a>" }] }], nl: [{ partOfSpeech: "Noun", definitions: [{ definition: "other" }] }] },
  macht: { de: [{ partOfSpeech: "Verb", language: "German", definitions: [{ definition: formOf("machen", "inflection of") }] }] },
  machen: { de: [{ partOfSpeech: "Verb", language: "German", definitions: [{ definition: "to <a>make</a>, to <a>do</a>" }] }] },
};

function memoryCache() {
  const rows = new Map<string, { payload: unknown; fetchedAt: string }>();
  const id = (key: { source: string; srcLang: string; tgtLang: string; term: string }) => JSON.stringify([key.source, key.srcLang, key.tgtLang, key.term]);
  return { rows, readLookupCache: async (key: any) => rows.get(id(key)) ?? null, saveLookupCache: async ({ payload, fetchedAt, ...key }: any) => { rows.set(id(key), { payload, fetchedAt }); } };
}

/** Made-up Wikimedia, Kaikki and Google: every request is recorded, and each host can be told to fail. */
function outside(options: { wikimedia?: number; google?: number; kaikki?: string } = {}) {
  const calls: string[] = [];
  const agents: string[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push(`${url.hostname}${decodeURIComponent(url.pathname)}`);
    agents.push(String((init.headers as Record<string, string>)?.["User-Agent"] ?? ""));
    if (url.hostname === "translation.googleapis.com") {
      if (options.google) return new Response("no", { status: options.google });
      const body = JSON.parse(String(init.body));
      return Response.json({ data: { translations: body.q.map((text: string) => ({ translatedText: `EN(${text})` })) } });
    }
    if (url.hostname === "kaikki.org" && options.kaikki === "down") return new Response("", { status: 503 });
    if (url.hostname === "kaikki.org") return options.kaikki && url.pathname.endsWith("/macht.jsonl") ? new Response(options.kaikki) : new Response("", { status: 404 });
    if (options.wikimedia) return new Response("slow down", { status: options.wikimedia, headers: { "retry-after": "120" } });
    const page = PAGES[decodeURIComponent(url.pathname.split("/").at(-1)!)];
    return page ? Response.json(page) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { calls, agents, fetchImpl };
}

describe("a definition's text", () => {
  test("keeps the words and drops every tag, script and link", () => {
    expect(plainText('<a href="/wiki/breakfast" onclick="x()">breakfast</a> &amp; <b>more</b>')).toBe("breakfast & more");
    expect(plainText('<script>alert(1)</script>to <i>make</i><img src=x onerror=alert(1)>')).toBe("to make");
    expect(plainText("caf&eacute; &#233; &#xe9; &lt;b&gt;")).toBe("caf&eacute; é é b");
    expect(plainText("a  <span>b</span> , c")).toBe("a b, c");
  });

  test("tries the spelling as tapped, then lowercase, then capitalized", () => {
    expect(termCandidates("Und", "de")).toEqual(["Und", "und"]);
    expect(termCandidates("frühstück", "de")).toEqual(["frühstück", "Frühstück"]);
    expect(termCandidates("  MACHT ", "de")).toEqual(["MACHT", "macht", "Macht"]);
    expect(termCandidates("", "de")).toEqual([]);
  });

  test("finds the word a form-of definition points at", () => {
    expect(formOfTarget(formOf("machen", "inflection of"))).toBe("machen");
    expect(formOfTarget("third-person singular present indicative of <a>pesar</a>")).toBe("pesar");
    expect(formOfTarget("plural of <i>Haus</i>")).toBe("Haus");
    expect(formOfTarget("a kind of bread")).toBe("");
    expect(formOfTarget("<a>breakfast</a>")).toBe("");
  });

  test("reads Wikimedia's definitions for the language being learned only", () => {
    expect(readRestDefinitions(PAGES["Frühstück"], "de")).toEqual([{ pos: "noun", glosses: ["breakfast"],
      examples: [{ text: "Gewöhnlich essen sie ihr Frühstück im Bett.", translation: "They usually have their breakfast in bed." }] }]);
    expect(readRestDefinitions(PAGES.und, "de")).toEqual([{ pos: "conjunction", glosses: ["and"], examples: [] }]);
    expect(readRestDefinitions(PAGES.macht, "de")[0]).toMatchObject({ glosses: ["inflection of machen:"], formOf: "machen" });
    expect(readRestDefinitions(PAGES.und, "fr")).toEqual([]);
    expect(readRestDefinitions(null, "de")).toEqual([]);
  });

  test("reads Kaikki's lines and a whole Wiktionary page the same way", () => {
    const line = JSON.stringify({ lang_code: "de", pos: "verb", word: "macht", senses: [
      { glosses: ["third-person singular present of machen"], form_of: [{ word: "machen" }], examples: [{ text: "Der Künstler macht ein Bild.", translation: "The artist creates a picture." }] }] });
    expect(readKaikki(`${line}\nnot json\n${JSON.stringify({ lang_code: "nl", pos: "noun", senses: [{ glosses: ["power"] }] })}`, "de")).toEqual([
      { pos: "verb", glosses: ["third-person singular present of machen"], formOf: "machen", examples: [{ text: "Der Künstler macht ein Bild.", translation: "The artist creates a picture." }] }]);
    const page = `<h2>Dutch</h2><h3>Noun</h3><ol><li>power</li></ol>
      <div class="mw-heading"><h2 id="German">German</h2></div><h3>Pronunciation</h3><ul><li>IPA</li></ul>
      <div class="mw-heading"><h3>Noun</h3></div><ol><li><a href="/wiki/breakfast">breakfast</a><dl><dd><span class="h-usage-example"><i class="e-example">Das <b>Frühstück</b> ist fertig.</i><span class="e-translation">Breakfast is ready.</span></span></dd></dl></li></ol>`;
    expect(readParsedPage(page, "German")).toEqual([{ pos: "noun", glosses: ["breakfast"], examples: [{ text: "Das Frühstück ist fertig.", translation: "Breakfast is ready." }] }]);
  });

  test("a cached answer is fresh for its source's time only", () => {
    const now = Date.parse("2026-11-15T00:00:00Z");
    expect(isFresh({ fetchedAt: "2026-10-20T00:00:00Z" }, LOOKUP_TTL.wiktionary, now)).toBe(true);
    expect(isFresh({ fetchedAt: "2026-10-10T00:00:00Z" }, LOOKUP_TTL.wiktionary, now)).toBe(false);
    expect(isFresh({ fetchedAt: "2026-09-01T00:00:00Z" }, LOOKUP_TTL.machine, now)).toBe(true);
    expect(isFresh(null, LOOKUP_TTL.machine, now)).toBe(false);
    expect(cacheTerm("x".repeat(300))).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(cacheTerm(" Und  dann ")).toBe("Und dann");
  });
});

describe("looking a word up", () => {
  const env = { GOOGLE_TRANSLATE_API_KEY: "k" };

  test("answers with Wiktionary's senses and a machine translation of the word and its sentence", async () => {
    const net = outside();
    const service = createLanguageLookupService({ database: memoryCache(), env, fetchImpl: net.fetchImpl });
    const result = await service.lookup({ userId: "u1", term: "Frühstück", src: "de", tgt: "en", sentence: "Sie macht das Frühstück." });
    expect(result).toMatchObject({ term: "Frühstück", resolvedTerm: "Frühstück", machineAvailable: true, failed: [],
      wiktionary: { url: "https://en.wiktionary.org/wiki/Fr%C3%BChst%C3%BCck#German", lemma: null },
      machine: { provider: "google", term: "EN(Frühstück)", sentence: "EN(Sie macht das Frühstück.)" } });
    expect(result.wiktionary!.senses[0].glosses).toEqual(["breakfast"]);
    // One batched translation request, and Wikimedia is told who is asking.
    expect(net.calls.filter((call) => call.startsWith("translation."))).toHaveLength(1);
    expect(net.agents.find((agent) => agent.startsWith("MarginChat/"))).toContain("https://www.marginchat.com");
  });

  test("resolves a capital from the start of a sentence, and follows a form to its dictionary form", async () => {
    const net = outside();
    const service = createLanguageLookupService({ database: memoryCache(), env, fetchImpl: net.fetchImpl });
    const und = await service.lookup({ userId: "u1", term: "Und", src: "de", tgt: "en" });
    expect(und.resolvedTerm).toBe("und");
    expect(und.wiktionary!.senses[0].glosses).toEqual(["and"]);
    expect(und.wiktionary!.url).toBe("https://en.wiktionary.org/wiki/und#German");
    const macht = await service.lookup({ userId: "u1", term: "macht", src: "de", tgt: "en" });
    expect(macht).toMatchObject({ resolvedTerm: "macht", lemma: "machen" });
    expect(macht.wiktionary!.senses[0]).toMatchObject({ formOf: "machen" });
    expect(macht.wiktionary!.lemma).toMatchObject({ term: "machen", senses: [{ pos: "verb", glosses: ["to make, to do"] }] });
  });

  test("a repeat lookup makes no outside request", async () => {
    const net = outside();
    const database = memoryCache();
    const service = createLanguageLookupService({ database, env, fetchImpl: net.fetchImpl });
    const first = await service.lookup({ userId: "u1", term: "macht", src: "de", tgt: "en", sentence: "Sie macht das." });
    const made = net.calls.length;
    expect(made).toBeGreaterThan(0);
    // Another service on the same cache, as another server instance would be.
    const again = await createLanguageLookupService({ database, env, fetchImpl: net.fetchImpl }).lookup({ userId: "u2", term: "macht", src: "de", tgt: "en", sentence: "Sie macht das." });
    expect(net.calls.length).toBe(made);
    expect(again).toEqual(first);
    // A word with no entry is remembered too.
    await service.lookup({ userId: "u1", term: "Zeitung", src: "de", tgt: "en" });
    const after = net.calls.length;
    const missing = await service.lookup({ userId: "u1", term: "Zeitung", src: "de", tgt: "en" });
    expect(net.calls.length).toBe(after);
    expect(missing).toMatchObject({ wiktionary: null, failed: [], machine: { term: "EN(Zeitung)" } });
  });

  test("an old answer is fetched again, and served as it is when the source is down", async () => {
    const database = memoryCache();
    let now = Date.parse("2026-01-01T00:00:00Z");
    const up = outside();
    await createLanguageLookupService({ database, env: {}, fetchImpl: up.fetchImpl, now: () => now }).lookup({ userId: "u1", term: "und", src: "de", tgt: "en" });
    now += 31 * 86_400_000;
    const down = outside({ wikimedia: 500, kaikki: "down" });
    const stale = await createLanguageLookupService({ database, env: {}, fetchImpl: down.fetchImpl, now: () => now }).lookup({ userId: "u1", term: "und", src: "de", tgt: "en" });
    expect(down.calls.length).toBeGreaterThan(0);
    expect(stale.wiktionary!.senses[0].glosses).toEqual(["and"]);
    expect(stale.failed).toEqual([]);
  });

  test("each source fails on its own", async () => {
    const noWiki = outside({ wikimedia: 500, kaikki: "down" });
    const one = await createLanguageLookupService({ database: memoryCache(), env, fetchImpl: noWiki.fetchImpl }).lookup({ userId: "u1", term: "und", src: "de", tgt: "en" });
    expect(one).toMatchObject({ wiktionary: null, failed: ["wiktionary"], machine: { term: "EN(und)" } });

    const noGoogle = outside({ google: 403 });
    const two = await createLanguageLookupService({ database: memoryCache(), env, fetchImpl: noGoogle.fetchImpl }).lookup({ userId: "u1", term: "und", src: "de", tgt: "en" });
    expect(two.machine).toBeNull();
    expect(two.failed).toEqual(["machine"]);
    expect(two.wiktionary!.senses).toHaveLength(1);

    const nothing = outside({ wikimedia: 500, google: 500, kaikki: "down" });
    const three = await createLanguageLookupService({ database: memoryCache(), env, fetchImpl: nothing.fetchImpl }).lookup({ userId: "u1", term: "und", src: "de", tgt: "en" });
    expect(three).toMatchObject({ term: "und", resolvedTerm: "und", wiktionary: null, machine: null, machineAvailable: true });
    expect(three.failed.sort()).toEqual(["machine", "wiktionary"]);
    // A failure isn't remembered as "no entry".
    const back = outside();
    const database = memoryCache();
    await createLanguageLookupService({ database, env: {}, fetchImpl: nothing.fetchImpl }).lookup({ userId: "u1", term: "und", src: "de", tgt: "en" });
    expect((await createLanguageLookupService({ database, env: {}, fetchImpl: back.fetchImpl }).lookup({ userId: "u1", term: "und", src: "de", tgt: "en" })).wiktionary).not.toBeNull();
  });

  test("when Wikimedia says too many requests, Kaikki's copy answers and Wikimedia is left alone for a while", async () => {
    const kaikki = JSON.stringify({ lang_code: "de", pos: "verb", senses: [{ glosses: ["third-person singular present of machen"], form_of: [{ word: "machen" }] }] });
    const net = outside({ wikimedia: 429, kaikki });
    const service = createLanguageLookupService({ database: memoryCache(), env: {}, fetchImpl: net.fetchImpl });
    const result = await service.lookup({ userId: "u1", term: "macht", src: "de", tgt: "en" });
    expect(result.wiktionary!.senses[0]).toMatchObject({ pos: "verb", formOf: "machen" });
    expect(result).toMatchObject({ machine: null, machineAvailable: false, failed: [] });
    expect(net.calls.filter((call) => call.startsWith("en.wiktionary.org"))).toHaveLength(1);
    expect(net.calls).toContain("kaikki.org/dictionary/German/meaning/m/ma/macht.jsonl");
  });

  test("the page itself is read when the definition endpoint breaks", async () => {
    const calls: string[] = [];
    const source = createWiktionarySource({ userAgent: "test", fetchImpl: (async (input: unknown) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.includes("/rest_v1/")) return new Response("gone", { status: 501 });
      return Response.json({ parse: { text: "<h2>German</h2><h3>Conjunction</h3><ol><li><a>and</a></li></ol>" } });
    }) as typeof fetch });
    expect(await source.senses("und", "de")).toEqual([{ pos: "conjunction", glosses: ["and"], examples: [] }]);
    expect(calls).toEqual(["/api/rest_v1/page/definition/und", "/w/api.php"]);
  });

  test("refuses what isn't a word or a pair of languages, and stops machine translation at the day's limit", async () => {
    const net = outside();
    const service = createLanguageLookupService({ database: memoryCache(), env, fetchImpl: net.fetchImpl });
    await expect(service.lookup({ userId: "u1", term: "", src: "de", tgt: "en" })).rejects.toThrow("Look up a word");
    await expect(service.lookup({ userId: "u1", term: "x".repeat(81), src: "de", tgt: "en" })).rejects.toThrow("Look up a word");
    await expect(service.lookup({ userId: "u1", term: "und", src: "../x", tgt: "en" })).rejects.toThrow("which language");
    const sentence = "a".repeat(590);
    for (let index = 0; index < Math.floor(MACHINE_DAILY_CHARACTERS / 600); index++) {
      await service.lookup({ userId: "u9", term: `w${index}`, src: "de", tgt: "en", sentence: `${sentence}${index}` });
    }
    const over = await service.lookup({ userId: "u9", term: "nochmal", src: "de", tgt: "en", sentence: `${sentence} mehr und mehr` });
    expect(over).toMatchObject({ machine: null, failed: ["machine"] });
    expect((await service.lookup({ userId: "u1", term: "nochmal", src: "de", tgt: "en" })).machine).not.toBeNull();
  });

  test("the translator is chosen by what the server has keys for", async () => {
    expect(machineTranslatorFor({})).toBeNull();
    expect(machineTranslatorFor({ GOOGLE_TRANSLATE_API_KEY: "g" })!.provider).toBe("google");
    expect(machineTranslatorFor({ DEEPL_API_KEY: "d" })!.provider).toBe("deepl");
    expect(machineTranslatorFor({ GOOGLE_TRANSLATE_API_KEY: "g", DEEPL_API_KEY: "d" })!.provider).toBe("google");
    expect(machineTranslatorFor({ GOOGLE_TRANSLATE_API_KEY: "g", DEEPL_API_KEY: "d", MACHINE_TRANSLATOR: "deepl" })!.provider).toBe("deepl");
    let sent: { url: string; body: any; auth: string } | null = null;
    const deepl = createDeepLTranslator({ apiKey: "abc:fx", fetchImpl: (async (input: unknown, init: RequestInit) => {
      sent = { url: String(input), body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).Authorization };
      return Response.json({ translations: [{ text: "and" }, { text: "And then." }] });
    }) as typeof fetch });
    expect(await deepl.translate({ texts: ["und", "Und dann."], source: "de", target: "en" })).toEqual(["and", "And then."]);
    expect(sent!).toEqual({ url: "https://api-free.deepl.com/v2/translate", body: { text: ["und", "Und dann."], source_lang: "DE", target_lang: "EN-US" }, auth: "DeepL-Auth-Key abc:fx" });
  });
});

describe("the lookup cache and a meaning's source in the database", () => {
  const databases: PGlite[] = [];
  afterEach(async () => { await Promise.all(databases.splice(0).map((database) => database.close())); });

  test("keeps one answer per source, languages and term, and remembers where a saved meaning came from", async () => {
    const pg = new PGlite({ extensions: { vector } });
    databases.push(pg);
    const client = { async query(sql: string, values?: unknown[]) {
      const result = values === undefined && sql.includes(";") ? (await pg.exec(sql)).at(-1)! : await pg.query(sql, values);
      return { ...result, rowCount: result.rows.length || (result as { affectedRows?: number }).affectedRows || 0 };
    } };
    await migrateDatabase(client, { migrations: await loadMigrations() });
    const key = { source: "wiktionary", srcLang: "de", tgtLang: "en", term: "und" };
    expect(await languageTermRepository.readLookupCache(client, key)).toBeNull();
    await languageTermRepository.saveLookupCache(client, { ...key, payload: { missing: true }, fetchedAt: "2026-11-01T00:00:00.000Z" });
    await languageTermRepository.saveLookupCache(client, { ...key, payload: { resolvedTerm: "und", senses: [] }, fetchedAt: "2026-11-15T00:00:00.000Z" });
    expect(await languageTermRepository.readLookupCache(client, key)).toEqual({ payload: { resolvedTerm: "und", senses: [] }, fetchedAt: "2026-11-15T00:00:00.000Z" });
    expect(await languageTermRepository.readLookupCache(client, { ...key, source: "google" })).toBeNull();

    await pg.query("insert into marginchat_users (id,email,password_hash,display_name) values ('u1','u1@example.test','hash','U1')");
    const term = { language: "de", key: "und", meaning: "and", source: "wiktionary", status: 1, tags: [], docIds: [], createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z" };
    // A device that hasn't updated yet sends no source.
    const { source: _source, ...older } = { ...term, key: "dann", meaning: "then" };
    await languageTermRepository.saveLanguageTerms(client, { userId: "u1", terms: [term, older] });
    const read = await languageTermRepository.readLanguageTerms(client, { userId: "u1" });
    expect(read.terms.map((item: any) => [item.key, item.source]).sort()).toEqual([["dann", ""], ["und", "wiktionary"]]);
  });
});

describe("a saved meaning's source on this device", () => {
  const memory = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; };

  test("is the reader unless a picked meaning says otherwise, and stays when only the rating changes", () => {
    const store = new LanguageTermStore("device", memory());
    expect(store.set("de", "und", { meaning: "and", source: "wiktionary" })?.source).toBe("wiktionary");
    expect(store.set("de", "und", { status: 3 })?.source).toBe("wiktionary");
    expect(store.set("de", "und", { meaning: "and also" })?.source).toBe("user");
    expect(store.set("de", "und", { meaning: "and", source: "ai" })?.source).toBe("ai");
    expect(store.set("de", "und", { meaning: "" })?.source).toBe("");
    expect(store.set("de", "dann", { status: 1 })?.source).toBe("");
  });
});

describe("the AI's meaning in context", () => {
  const pair = { target: "de", base: "en" };

  test("is asked with the dictionary's senses to choose from", () => {
    const messages = buildLookupMessages({ text: "macht", sentence: "Und dann macht sie das Frühstück.", pair, senses: ["(verb) to make, to do"] }, (prefix) => `${prefix}-1`);
    expect(messages[0].content).toContain("dictionary senses");
    expect(JSON.parse(messages[1].content.slice(messages[1].content.indexOf("{")))).toMatchObject({ selected: "macht", dictionarySenses: ["(verb) to make, to do"] });
    const plain = buildLookupMessages({ text: "macht", sentence: "", pair }, (prefix) => `${prefix}-1`);
    expect(plain[1].content).not.toContain("dictionarySenses");
  });

  test("shows as much of the meaning and the sentence as has streamed in", () => {
    expect(partialLookupReply('{"mea')).toEqual({ meaning: "", sentenceTranslation: "" });
    expect(partialLookupReply('{"meaning":"mak')).toEqual({ meaning: "mak", sentenceTranslation: "" });
    expect(partialLookupReply('{"meaning":"makes \\"it\\"","sentenceTranslation":"And then she ma')).toEqual({ meaning: 'makes "it"', sentenceTranslation: "And then she ma" });
    expect(partialLookupReply('{"meaning":"caf\\u00e9 \\u00')).toEqual({ meaning: "café ", sentenceTranslation: "" });
    expect(partialLookupReply('{"meaning":"a\\')).toEqual({ meaning: "a", sentenceTranslation: "" });
    expect(parseLookupReply('{"meaning":"makes","sentenceTranslation":"And then she makes breakfast.","from":"de","to":"en"}', pair))
      .toMatchObject({ meaning: "makes", sentenceTranslation: "And then she makes breakfast." });
  });

  test("the Wiktionary pane opens the page at the language's section", () => {
    expect(wiktionaryFrameUrl("Frühstück", "de")).toBe("https://en.wiktionary.org/wiki/Fr%C3%BChst%C3%BCck?useskin=minerva#German");
  });
});

describe("looking a word up with the person's own translation key", () => {
  test("a server with no translator uses the person's Google key, and no daily cap applies", async () => {
    const net = outside();
    const service = createLanguageLookupService({ database: memoryCache(), env: {}, fetchImpl: net.fetchImpl });
    const without = await service.lookup({ userId: "u1", term: "und", src: "de", tgt: "en" });
    expect(without.machineAvailable).toBe(false);
    const own = await service.lookup({ userId: "u1", term: "Frühstück", src: "de", tgt: "en", keys: { google_translate: "own-key-123" } });
    expect(own).toMatchObject({ machineAvailable: true, machine: { provider: "google", term: "EN(Frühstück)" } });
  });
});
