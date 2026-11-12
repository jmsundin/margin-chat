#!/usr/bin/env bun
/**
 * Ratchet eval harness (docs/ratchet-in-margin-chat-design.md §3.3, §6).
 *
 * Runs the same claim check the app runs against a fixture vault of Markdown
 * files, then scores it against a case set:
 *   - extraction recall: expected claims found, matched by their words;
 *   - verdict accuracy: matched claims given the expected verdict;
 *   - citation grounding: verdicts other than insufficient-evidence whose every
 *     citation resolves to the cited lines and quote in the vault (must be 100%);
 *   - invented claims in documents that have none.
 *
 *   bun scripts/ratchet-eval.ts [--set tests/fixtures/ratchet/example-set.json] [--model oracle | claude-opus-5-5] [--out report.json]
 *
 * --model oracle (the default, and what CI runs) answers from the case set
 * itself: it names the expected claims and cites the expected quote only when
 * the vault search put that passage in front of it. It needs no key and tests
 * everything around the model: line anchors, retrieval, hidden documents and
 * the grounding check. A Claude model id runs the real thing through the
 * Anthropic API (ANTHROPIC_API_KEY or an `ant auth login` profile) and costs money.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  resolveEvidence, runClaimCheck, searchSources,
  type RatchetAsk, type RatchetClaim, type RatchetCorpus, type RatchetSource, type RatchetVerdict,
} from "../client/src/lib/ratchet";

interface Case { id: string; span: string; expected: RatchetVerdict; evidence?: { document: string; quote: string }; stance?: string; comment?: string }
interface CaseSet {
  name: string;
  vault: string;
  thresholds: { extractionRecall: number; verdictAccuracy: number; citationGrounding: number };
  checks: Array<{ document: string; cases: Case[] }>;
}

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const index = args.indexOf(`--${name}`); return index >= 0 && args[index + 1] ? args[index + 1] : fallback; };
const setPath = resolve(option("set", "tests/fixtures/ratchet/example-set.json"));
const model = option("model", "oracle");
const out = option("out", "");

const fold = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** One Markdown file is one document of one block, as plain Markdown is in the app. */
async function loadVault(dir: string) {
  const documents = new Map<string, RatchetSource & { hidden: boolean }>();
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".md")).sort()) {
    const raw = await readFile(join(dir, file), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
    const meta = Object.fromEntries((match?.[1] ?? "").split("\n").map((line) => line.split(/:\s*/, 2)).filter((pair) => pair.length === 2));
    const id = basename(file, ".md");
    const content = match ? raw.slice(match[0].length) : raw;
    documents.set(id, { id, title: meta.title ?? id, updatedAt: meta.updated, hidden: meta.hidden === "true", blocks: [{ id: `${id}-body`, content: content.replace(/\n$/, "") }] });
  }
  const byTitle = new Map([...documents.values()].map((doc) => [doc.title.toLowerCase(), doc.id]));
  for (const doc of documents.values()) {
    doc.linkedIds = [...doc.blocks[0].content.matchAll(/\[\[([^\]|#]+)/g)].map((link) => byTitle.get(link[1].trim().toLowerCase()) ?? link[1].trim()).filter((target) => documents.has(target));
  }
  return documents;
}

function corpusOf(documents: Map<string, RatchetSource & { hidden: boolean }>): RatchetCorpus {
  // Hidden documents are left out exactly as the app leaves them out.
  const readable = [...documents.values()].filter((doc) => !doc.hidden);
  return {
    get: (id) => { const doc = documents.get(id); return doc && !doc.hidden ? doc : undefined; },
    async search(query, { limit }) { return searchSources(readable, query, limit); },
  };
}

/** Answers from the case set, citing only passages actually shown to it. */
function oracle(source: RatchetSource, cases: Case[], documents: Map<string, RatchetSource>): RatchetAsk {
  return async (prompt, { purpose }) => {
    if (purpose === "extract") {
      const claims = cases.flatMap((item) => {
        const block = source.blocks.findIndex((candidate) => candidate.content.includes(item.span));
        if (block < 0) return [];
        const line = source.blocks[block].content.split("\n").findIndex((text) => text.includes(item.span));
        return [{ from: `${block}:${line + 1}`, to: `${block}:${line + 1}`, span: item.span, claim: item.span }];
      });
      return { text: JSON.stringify({ claims }), model: "oracle" };
    }
    const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n\n") + 2)) as { claims: Array<{ id: string; words: string; passages: Array<{ id: string; document: string; text: string }> }> };
    const results = data.claims.map((claim) => {
      const item = cases.find((candidate) => candidate.span === claim.words);
      if (!item || item.expected === "insufficient-evidence" || !item.evidence) return { claim: claim.id, verdict: "insufficient-evidence", evidence: [], reason: "Oracle: nothing expected." };
      const title = documents.get(item.evidence.document)?.title;
      const passage = data.claims.flatMap((entry) => entry.passages).find((candidate) => candidate.document === title && fold(candidate.text).includes(fold(item.evidence!.quote)));
      if (!passage) return { claim: claim.id, verdict: "insufficient-evidence", evidence: [], reason: "Oracle: the expected passage wasn't retrieved." };
      const stance = item.stance ?? (item.expected === "supported" ? "supports" : item.expected === "contradicted" ? "contradicts" : item.expected === "stale" ? "supersedes" : "related");
      return { claim: claim.id, verdict: item.expected, evidence: [{ passage: passage.id, quote: item.evidence.quote, stance }], reason: "Oracle." };
    });
    return { text: JSON.stringify({ results }), model: "oracle" };
  };
}

function claude(modelId: string): RatchetAsk {
  const client = new Anthropic();
  return async (prompt, { signal }) => {
    const response = await client.messages.create({ model: modelId, max_tokens: 16000, messages: [{ role: "user", content: prompt }] }, { signal });
    if (response.stop_reason === "refusal") throw new Error(`${modelId} declined the request.`);
    const text = response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
    return { text, model: response.model };
  };
}

/** The extracted claim a case means: same words, either way round. */
function matchCase(item: Case, claims: RatchetClaim[]) {
  const want = fold(item.span);
  return claims.find((claim) => fold(claim.span).includes(want) || want.includes(fold(claim.span)) && fold(claim.span).length >= want.length * 0.6);
}

const set = JSON.parse(await readFile(setPath, "utf8")) as CaseSet;
const documents = await loadVault(resolve(dirname(setPath), set.vault));
const corpus = corpusOf(documents);
const rows: Array<Record<string, unknown>> = [];
let expectedClaims = 0, found = 0, judged = 0, correct = 0, grounded = 0, groundable = 0, invented = 0, modelCalls = 0;

for (const check of set.checks) {
  const source = documents.get(check.document);
  if (!source) throw new Error(`The case set names ${check.document}, which isn't in the vault.`);
  const ask = model === "oracle" ? oracle(source, check.cases, documents) : claude(model);
  const { claims, run } = await runClaimCheck({ source, corpus, ask, runId: `eval-${check.document}` });
  modelCalls += run.modelCalls;
  for (const claim of claims) {
    if (claim.verdict === "insufficient-evidence") continue;
    groundable += 1;
    const states = await Promise.all(claim.evidence.map((evidence) => resolveEvidence(evidence, corpus)));
    if (claim.evidence.length && states.every((state) => state.state === "ok")) grounded += 1;
    else rows.push({ document: check.document, problem: "ungrounded citation", claim: claim.span });
  }
  if (!check.cases.length) {
    invented += claims.length;
    rows.push({ document: check.document, expected: "no claims", found: claims.length, ok: claims.length === 0 });
  }
  for (const item of check.cases) {
    expectedClaims += 1;
    const claim = matchCase(item, claims);
    if (claim) { found += 1; judged += 1; }
    const ok = Boolean(claim && claim.verdict === item.expected);
    if (ok) correct += 1;
    rows.push({ id: item.id, expected: item.expected, got: claim?.verdict ?? "not extracted", ok,
      ...(claim?.evidence.length ? { cited: claim.evidence.map((evidence) => `${evidence.documentId}: ${evidence.quote}`) } : {}) });
  }
}

const ratio = (part: number, whole: number) => (whole ? part / whole : 1);
const scores = {
  extractionRecall: ratio(found, expectedClaims),
  verdictAccuracy: ratio(correct, judged),
  citationGrounding: ratio(grounded, groundable),
  inventedClaims: invented,
};
const passed = scores.extractionRecall >= set.thresholds.extractionRecall && scores.verdictAccuracy >= set.thresholds.verdictAccuracy
  && scores.citationGrounding >= set.thresholds.citationGrounding && invented === 0;
const report = { set: set.name, model, thresholds: set.thresholds, scores, modelCalls, passed, cases: rows };
if (out) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exit(1);
