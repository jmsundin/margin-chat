import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import { HttpError } from "../lib/errors.mjs";

/**
 * What a tapped word or phrase means, from sources that answer at once: English
 * Wiktionary's senses and a machine translation of the term and its sentence.
 * Every answer is kept in a shared cache, so a word anyone has looked up before
 * needs no outside request. Each source fails on its own: the other still answers.
 */
export const LOOKUP_MAX_TERM = 80;
export const LOOKUP_MAX_SENTENCE = 600;
export const LOOKUP_MAX_SENSES = 5;
const DAY = 86_400_000;
export const LOOKUP_TTL = { wiktionary: 30 * DAY, machine: 90 * DAY, missing: 7 * DAY };
/** The most text one account may have machine-translated a day, so a runaway page can't run up the bill. */
export const MACHINE_DAILY_CHARACTERS = 60_000;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** A definition's HTML as plain text: no tags, scripts or styles survive, so nothing from Wiktionary can run or link here. */
export function plainText(html) {
  return String(html ?? "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<[^>]*>/gu, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, code) => {
      if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
      const point = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    })
    .replace(/[<>]/gu, "").replace(/\s+/gu, " ").replace(/\s+([,.;:!?)])/gu, "$1").trim();
}

export const normalizeTerm = (term) => String(term ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();

/** The spellings to try, in order: as tapped, lowercase (a sentence's first word), capitalized (German nouns). */
export function termCandidates(term, language = "") {
  const exact = normalizeTerm(term);
  if (!exact) return [];
  const locale = language.split("-")[0] || undefined;
  const lower = exact.toLocaleLowerCase(locale);
  const capital = lower.charAt(0).toLocaleUpperCase(locale) + lower.slice(1);
  return [...new Set([exact, lower, capital])];
}

const FORM_OF = /\b(?:inflection|form|plural|singular|participle|present|past|preterite|imperative|subjunctive|indicative|genitive|dative|accusative|nominative|feminine|masculine|neuter|comparative|superlative|gerund|infinitive|diminutive|spelling|misspelling|abbreviation|contraction) of ([\p{L}\p{M}'’-]+(?: [\p{L}\p{M}'’-]+)?)\s*[:;,.(]?/iu;

/** The word a "form of" definition points at (`macht`: inflection of `machen`), or "". */
export function formOfTarget(html) {
  const source = String(html ?? "");
  if (/form-of-definition/u.test(source)) {
    const link = source.match(/form-of-definition-link[\s\S]*?<a\b[^>]*\bhref="[^"]*\/wiki\/([^"#?]+)/u) ?? source.match(/form-of-definition[\s\S]*?<a\b[^>]*\btitle="([^"]+)"/u);
    if (link) { try { return decodeURIComponent(link[1]).replaceAll("_", " ").trim(); } catch { return link[1].replaceAll("_", " ").trim(); } }
  }
  const text = plainText(source);
  const match = text.length <= 120 ? text.match(FORM_OF) : null;
  return match ? match[1].trim() : "";
}

const sense = (pos, gloss, examples, formOf) => ({ pos, glosses: [gloss], examples, ...(formOf ? { formOf } : {}) });

/** Wikimedia's REST definitions for one language of a page, as senses. */
export function readRestDefinitions(body, language) {
  const entries = body && typeof body === "object" ? body[language.split("-")[0]] : null;
  if (!Array.isArray(entries)) return [];
  const senses = [];
  for (const entry of entries) {
    const pos = typeof entry?.partOfSpeech === "string" ? entry.partOfSpeech.toLowerCase() : "";
    for (const item of Array.isArray(entry?.definitions) ? entry.definitions : []) {
      const gloss = plainText(item?.definition);
      if (!gloss) continue;
      const first = Array.isArray(item.parsedExamples) ? item.parsedExamples.find((example) => plainText(example?.example)) : null;
      const loose = !first && Array.isArray(item.examples) ? item.examples.find((example) => plainText(example)) : null;
      const examples = first ? [{ text: plainText(first.example), translation: plainText(first.translation) }] : loose ? [{ text: plainText(loose), translation: "" }] : [];
      senses.push(sense(pos, gloss, examples, formOfTarget(item.definition)));
    }
  }
  return senses;
}

/** Kaikki's per-word lines (wiktextract), as senses. Each line is one part of speech of the word in one language. */
export function readKaikki(lines, language) {
  const senses = [];
  for (const line of String(lines ?? "").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.lang_code !== language.split("-")[0]) continue;
    for (const item of Array.isArray(entry.senses) ? entry.senses : []) {
      const gloss = plainText((Array.isArray(item?.glosses) ? item.glosses : []).filter((part) => typeof part === "string").join(" "));
      if (!gloss) continue;
      const example = Array.isArray(item.examples) ? item.examples.find((candidate) => typeof candidate?.text === "string" && candidate.text.trim()) : null;
      const target = Array.isArray(item.form_of) && typeof item.form_of[0]?.word === "string" ? item.form_of[0].word.trim() : "";
      senses.push(sense(typeof entry.pos === "string" ? entry.pos : "", gloss,
        example ? [{ text: plainText(example.text), translation: plainText(example.translation ?? example.english ?? "") }] : [], target));
    }
  }
  return senses;
}

const PARTS_OF_SPEECH = /^(noun|proper noun|verb|adjective|adverb|pronoun|preposition|postposition|conjunction|interjection|article|determiner|particle|numeral|phrase|proverb|prefix|suffix|contraction|participle|idiom)$/iu;

/** A whole Wiktionary page's HTML (the Action API's `parse`), read for one language's section. */
export function readParsedPage(html, languageName) {
  const { document } = parseHTML(`<html><body>${String(html ?? "")}</body></html>`);
  const senses = [];
  let inLanguage = false;
  let pos = "";
  for (const element of document.querySelectorAll("h2, h3, h4, h5, ol")) {
    const tag = element.tagName.toLowerCase();
    if (tag === "h2") { inLanguage = plainText(element.textContent).replace(/\[edit\]/iu, "").trim() === languageName; pos = ""; continue; }
    if (!inLanguage) continue;
    if (tag !== "ol") { const title = plainText(element.textContent).replace(/\[edit\]/iu, "").trim(); pos = PARTS_OF_SPEECH.test(title) ? title.toLowerCase() : ""; continue; }
    if (!pos || element.parentElement?.closest("ol")) continue;
    for (const item of element.children) {
      if (item.tagName.toLowerCase() !== "li") continue;
      const copy = item.cloneNode(true);
      for (const nested of copy.querySelectorAll("dl, ul, ol, .citation-whole, .nyms")) nested.remove();
      const gloss = plainText(copy.innerHTML);
      if (!gloss) continue;
      const example = item.querySelector(".h-usage-example .e-example, .e-example");
      const translation = item.querySelector(".h-usage-example .e-translation, .e-translation");
      senses.push(sense(pos, gloss, example ? [{ text: plainText(example.innerHTML), translation: plainText(translation?.innerHTML) }] : [], formOfTarget(copy.innerHTML)));
    }
  }
  return senses;
}

export function englishLanguageName(code) {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code.split("-")[0]) ?? code; } catch { return code; }
}

export function wiktionaryPageUrl(term, language) {
  return `https://en.wiktionary.org/wiki/${encodeURIComponent(term.replaceAll(" ", "_"))}#${encodeURIComponent(englishLanguageName(language).replaceAll(" ", "_"))}`;
}

class SourceBusy extends Error {}

/**
 * English Wiktionary, read three ways behind one face: Wikimedia's definition
 * endpoint first; the page itself when that endpoint breaks; and Kaikki's copy
 * of the same entries when Wikimedia says we're asking too often.
 */
export function createWiktionarySource({ fetchImpl = globalThis.fetch, userAgent, now = () => Date.now(), timeoutMs = 2500 } = {}) {
  let wikimediaBusyUntil = 0;
  const headers = { Accept: "application/json", "User-Agent": userAgent, "Api-User-Agent": userAgent };
  const get = (url, signal) => fetchImpl(url, { headers, redirect: "follow", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });

  function busy(response) {
    const wait = Number(response.headers?.get?.("retry-after"));
    wikimediaBusyUntil = now() + Math.min(15 * 60_000, Math.max(60_000, Number.isFinite(wait) ? wait * 1000 : 0));
    throw new SourceBusy("Wikimedia asked for fewer requests.");
  }

  async function fromRest(page, language, signal) {
    const response = await get(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(page)}`, signal);
    if (response.status === 404) return [];
    if (response.status === 429) busy(response);
    if (!response.ok) throw new Error(`Wiktionary answered ${response.status}.`);
    return readRestDefinitions(await response.json(), language);
  }

  async function fromPage(page, language, signal) {
    const response = await get(`https://en.wiktionary.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json&formatversion=2&redirects=1`, signal);
    if (response.status === 429) busy(response);
    if (!response.ok) throw new Error(`Wiktionary answered ${response.status}.`);
    const body = await response.json();
    if (body?.error) { if (body.error.code === "missingtitle") return []; throw new Error("Wiktionary couldn't open the page."); }
    return readParsedPage(body?.parse?.text, englishLanguageName(language));
  }

  async function fromKaikki(word, language, signal) {
    const name = englishLanguageName(language);
    const response = await get(`https://kaikki.org/dictionary/${encodeURIComponent(name)}/meaning/${encodeURIComponent([...word][0])}/${encodeURIComponent([...word].slice(0, 2).join(""))}/${encodeURIComponent(word)}.jsonl`, signal);
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`Kaikki answered ${response.status}.`);
    return readKaikki(await response.text(), language);
  }

  /** One spelling's senses in one language; empty when the page or the language's section doesn't exist. */
  async function senses(word, language, signal) {
    const page = word.replaceAll(" ", "_");
    if (now() >= wikimediaBusyUntil) {
      try { return await fromRest(page, language, signal); }
      catch (error) {
        if (signal?.aborted) throw error;
        if (!(error instanceof SourceBusy)) {
          try { return await fromPage(page, language, signal); }
          catch (second) { if (signal?.aborted) throw second; }
        }
      }
    }
    return fromKaikki(word, language, signal);
  }

  return { senses };
}

/** Google Cloud Translation, basic edition: several texts in one request. */
export function createGoogleTranslator({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 2500 }) {
  return {
    provider: "google",
    async translate({ texts, source, target, signal }) {
      const response = await fetchImpl("https://translation.googleapis.com/language/translate/v2", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
        body: JSON.stringify({ q: texts, source: source.split("-")[0], target: target.split("-")[0], format: "text" }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Google Translate answered ${response.status}.`);
      const body = await response.json();
      const rows = body?.data?.translations;
      if (!Array.isArray(rows) || rows.length !== texts.length) throw new Error("Google Translate sent an unreadable answer.");
      return rows.map((row) => plainText(row?.translatedText));
    },
  };
}

const DEEPL_TARGETS = { en: "EN-US", pt: "PT-BR", zh: "ZH-HANS", no: "NB" };

/** DeepL. A free plan's key ends in ":fx" and is served from its own host. */
export function createDeepLTranslator({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 2500 }) {
  const host = apiKey.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
  return {
    provider: "deepl",
    async translate({ texts, source, target, signal }) {
      const from = source.split("-")[0].toLowerCase(), to = target.split("-")[0].toLowerCase();
      const response = await fetchImpl(`https://${host}/v2/translate`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `DeepL-Auth-Key ${apiKey}` },
        body: JSON.stringify({ text: texts, source_lang: (from === "no" ? "nb" : from).toUpperCase(), target_lang: DEEPL_TARGETS[to] ?? to.toUpperCase() }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`DeepL answered ${response.status}.`);
      const body = await response.json();
      const rows = body?.translations;
      if (!Array.isArray(rows) || rows.length !== texts.length) throw new Error("DeepL sent an unreadable answer.");
      return rows.map((row) => plainText(row?.text));
    },
  };
}

/** The machine translator this server is set up with: MACHINE_TRANSLATOR names one, else whichever has a key. Null when neither does. */
export function machineTranslatorFor(env, fetchImpl = globalThis.fetch) {
  const google = env.GOOGLE_TRANSLATE_API_KEY?.trim(), deepl = env.DEEPL_API_KEY?.trim();
  const wanted = env.MACHINE_TRANSLATOR?.trim().toLowerCase();
  if (deepl && (wanted === "deepl" || !google)) return createDeepLTranslator({ apiKey: deepl, fetchImpl });
  if (google) return createGoogleTranslator({ apiKey: google, fetchImpl });
  return null;
}

/** A cache key for any text: short text as it is, long text by its hash. */
export function cacheTerm(text) {
  const term = normalizeTerm(text);
  return term.length <= 200 ? term : `sha256:${createHash("sha256").update(term).digest("hex")}`;
}

export function isFresh(row, ttl, now) {
  return Boolean(row) && now - new Date(row.fetchedAt).getTime() < ttl;
}

export function createLanguageLookupService({ database, env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), wiktionary, translator } = {}) {
  const contact = env.WIKIMEDIA_CONTACT?.trim() || env.SUPPORT_EMAIL?.trim() || "support@marginchat.com";
  const source = wiktionary ?? createWiktionarySource({ fetchImpl, now, userAgent: `MarginChat/1.0 (https://www.marginchat.com; ${contact})` });
  const serverMachine = translator === undefined ? machineTranslatorFor(env, fetchImpl) : translator;
  const used = new Map();

  const read = async (key) => { try { return await database.readLookupCache(key); } catch { return null; } };
  const save = async (key, payload) => { try { await database.saveLookupCache({ ...key, payload, fetchedAt: new Date(now()).toISOString() }); } catch { /* The answer still goes out; it's fetched again next time. */ } };

  /** A term's entry: the first spelling with senses, and the dictionary form when every sense is only a form of it. */
  async function resolve(term, language, signal) {
    for (const candidate of termCandidates(term, language)) {
      const senses = await source.senses(candidate, language, signal);
      if (!senses.length) continue;
      const targets = [...new Set(senses.map((item) => item.formOf).filter(Boolean))];
      const lemmaTerm = targets.length && senses.some((item) => item.formOf) ? targets[0] : "";
      let lemma = null;
      if (lemmaTerm && lemmaTerm !== candidate) {
        try {
          const lemmaSenses = (await source.senses(lemmaTerm, language, signal)).filter((item) => !item.formOf);
          if (lemmaSenses.length) lemma = { term: lemmaTerm, senses: lemmaSenses.slice(0, LOOKUP_MAX_SENSES), url: wiktionaryPageUrl(lemmaTerm, language) };
        } catch (error) { if (signal?.aborted) throw error; }
      }
      return { resolvedTerm: candidate, senses: senses.slice(0, LOOKUP_MAX_SENSES), url: wiktionaryPageUrl(candidate, language), lemma };
    }
    return { missing: true };
  }

  async function wiktionaryFor(term, src, signal) {
    const key = { source: "wiktionary", srcLang: src.split("-")[0], tgtLang: "en", term: cacheTerm(term) };
    const cached = await read(key);
    if (isFresh(cached, cached?.payload?.missing ? LOOKUP_TTL.missing : LOOKUP_TTL.wiktionary, now())) return cached.payload;
    try {
      const payload = await resolve(term, src, signal);
      await save(key, payload);
      return payload;
    } catch (error) {
      // An old answer is better than none while Wikimedia is unreachable.
      if (cached) return cached.payload;
      throw error;
    }
  }

  /** The person's own DeepL or Google key comes first: it is their account, so no daily cap here. */
  function ownTranslator(keys) {
    if (keys?.deepl?.trim()) return createDeepLTranslator({ apiKey: keys.deepl.trim(), fetchImpl });
    if (keys?.google_translate?.trim()) return createGoogleTranslator({ apiKey: keys.google_translate.trim(), fetchImpl });
    return null;
  }

  async function machineFor({ userId, term, sentence, src, tgt, signal, own = null }) {
    const machine = own ?? serverMachine;
    if (!machine) return null;
    const texts = [term, ...(sentence && sentence !== term ? [sentence] : [])];
    const keys = texts.map((text) => ({ source: machine.provider, srcLang: src.split("-")[0], tgtLang: tgt.split("-")[0], term: cacheTerm(text) }));
    const cached = await Promise.all(keys.map(read));
    const answers = cached.map((row) => (isFresh(row, LOOKUP_TTL.machine, now()) && typeof row.payload?.text === "string" ? row.payload.text : null));
    const wanted = texts.map((text, index) => ({ text, index })).filter((item) => answers[item.index] === null);
    if (wanted.length) {
      const day = Math.floor(now() / DAY);
      const tally = used.get(userId);
      const spent = tally?.day === day ? tally.characters : 0;
      const size = wanted.reduce((total, item) => total + item.text.length, 0);
      if (!own && spent + size > MACHINE_DAILY_CHARACTERS) throw new Error("Today's machine translation limit is used up.");
      if (!own) used.set(userId, { day, characters: spent + size });
      const translated = await machine.translate({ texts: wanted.map((item) => item.text), source: src, target: tgt, signal });
      await Promise.all(wanted.map((item, at) => { answers[item.index] = translated[at]; return save(keys[item.index], { text: translated[at] }); }));
    }
    return { provider: machine.provider, term: answers[0] ?? "", sentence: texts.length > 1 ? answers[1] ?? "" : "" };
  }

  /** Never throws for a source's failure: that source is null and `failed` names it. */
  async function lookup({ userId, term, src, tgt, sentence = "", signal, keys = null }) {
    const own = ownTranslator(keys);
    const clean = normalizeTerm(term);
    if (!clean || clean.length > LOOKUP_MAX_TERM) throw new HttpError(400, `Look up a word or a short phrase, at most ${LOOKUP_MAX_TERM} characters.`);
    if (!LANGUAGE.test(src ?? "") || !LANGUAGE.test(tgt ?? "")) throw new HttpError(400, "Say which language the text is in and which to translate into.");
    const context = normalizeTerm(sentence).slice(0, LOOKUP_MAX_SENTENCE);
    const failed = [];
    const [entry, translation] = await Promise.all([
      wiktionaryFor(clean, src, signal).catch(() => { failed.push("wiktionary"); return null; }),
      machineFor({ userId, term: clean, sentence: context, src, tgt, signal, own }).catch(() => { failed.push("machine"); return null; }),
    ]);
    const found = entry && !entry.missing ? entry : null;
    return {
      term: clean, resolvedTerm: found?.resolvedTerm ?? clean, ...(found?.lemma ? { lemma: found.lemma.term } : {}),
      wiktionary: found ? { senses: found.senses, url: found.url, lemma: found.lemma } : null,
      machine: translation, machineAvailable: Boolean(own ?? serverMachine), failed,
    };
  }

  return { lookup };
}
