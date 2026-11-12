import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import * as ratchetRepository from "../server/db/ratchetRepository.mjs";
import { createRatchetService } from "../server/ratchet/index.mjs";
import {
  buildExtractionPrompt, checkVerdict, claimOffsets, locateClaim, parseExtractionReply, resolveEvidence, runClaimCheck,
  RATCHET_MAX_MODEL_CALLS, type RatchetAsk, type RatchetCorpus, type RatchetSource,
} from "../client/src/lib/ratchet";

const checked: RatchetSource = {
  id: "doc-checked", title: "Rapamycin notes", linkedIds: ["doc-itp"],
  blocks: [
    { id: "b0", content: "# Rapamycin\n\nRapamycin extended median lifespan in male mice by 23% in the ITP study.\nI want to read more about dosing." },
    { id: "b1", content: "Metformin doubled lifespan in mice.\nExercise is good." },
  ],
};
const itp: RatchetSource = {
  id: "doc-itp", title: "ITP results", updatedAt: "2026-10-01T00:00:00.000Z",
  blocks: [{ id: "i0", content: "Interventions Testing Program\n\nIn the ITP, rapamycin increased median lifespan by 23% in males and 26% in females.\nStarted at 9 months of age." }],
};
const metformin: RatchetSource = {
  id: "doc-met", title: "Metformin review",
  blocks: [{ id: "m0", content: "Metformin did not extend lifespan in the ITP mouse cohorts.\nHuman trials are ongoing." }],
};
const hidden: RatchetSource = { id: "doc-hidden", title: "Private", blocks: [{ id: "h0", content: "Metformin doubled lifespan in mice, according to my diary." }] };

function corpus(docs: RatchetSource[], options: { failSearch?: boolean } = {}): RatchetCorpus {
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  return {
    get: (id) => byId.get(id),
    async search(query) {
      if (options.failSearch) throw new Error("offline");
      const words = query.toLowerCase().split(/\W+/).filter((word) => word.length > 3);
      return docs.filter((doc) => doc.blocks.some((block) => words.some((word) => block.content.toLowerCase().includes(word))))
        .map((doc) => ({ documentId: doc.id, text: doc.blocks[0].content.slice(0, 80) }));
    },
  };
}

const EXTRACT = JSON.stringify({ claims: [
  { from: "0:3", to: "0:3", span: "Rapamycin extended median lifespan in male mice by 23% in the ITP study.", claim: "Rapamycin extended median lifespan of male mice by 23% in the ITP." },
  { from: "1:1", to: "1:1", span: "Metformin doubled lifespan in mice.", claim: "Metformin doubled the lifespan of mice." },
] });

function scripted(replies: Array<(prompt: string) => string>): RatchetAsk & { prompts: string[] } {
  const prompts: string[] = [];
  const ask = (async (prompt: string) => {
    prompts.push(prompt);
    const next = replies.shift();
    if (!next) throw new Error("No reply scripted.");
    return { text: next(prompt), model: "test-model" };
  }) as RatchetAsk & { prompts: string[] };
  ask.prompts = prompts;
  return ask;
}

/** The passage key the verify prompt gave a document. */
function passageFor(prompt: string, title: string) {
  const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n\n") + 2));
  for (const claim of data.claims) for (const passage of claim.passages) if (passage.document === title) return passage.id as string;
  throw new Error(`No passage from ${title}`);
}

describe("finding claims", () => {
  test("numbers lines by block and line, leaving blank lines out", () => {
    const { prompt } = buildExtractionPrompt(checked);
    expect(prompt).toContain("[0:3] Rapamycin extended");
    expect(prompt).toContain("[1:2] Exercise is good.");
    expect(prompt).not.toContain("[0:2]");
  });

  test("keeps claims whose words are on the named lines, and drops the rest", () => {
    const reply = JSON.stringify({ claims: [
      { from: "0:3", to: "0:3", span: "extended median lifespan in male mice by 23%", claim: "A" },
      // Off by one line: found on the line next to it.
      { from: "0:4", to: "0:4", span: "Rapamycin extended median lifespan", claim: "B" },
      { from: "1:1", to: "1:1", span: "Aspirin cures ageing", claim: "Invented" },
      { from: "0:3", to: "1:1", span: "Rapamycin", claim: "Across blocks" },
      { from: "9:1", to: "9:1", span: "x", claim: "No such block" },
    ] });
    const result = parseExtractionReply(`\`\`\`json\n${reply}\n\`\`\``, checked);
    expect(result.claims.map((claim) => [claim.claim, claim.anchor.blockId, claim.anchor.lineStart])).toEqual([["A", "b0", 2], ["B", "b0", 2]]);
    expect(result.dropped).toBe(3);
  });

  test("an unreadable reply finds nothing and says so", () => {
    expect(parseExtractionReply("I could not find any.", checked)).toEqual({ claims: [], dropped: 0, unreadable: true });
  });
});

describe("checking a verdict's citations", () => {
  const item = { key: "C1", claim: "Rapamycin extended male mouse lifespan by 23%.", span: "", passages: [
    { key: "P1", documentId: "doc-itp", title: "ITP results", blockId: "i0", lineStart: 2, lines: ["In the ITP, rapamycin increased median lifespan by 23% in males and 26% in females."], linked: true },
  ] };
  const vault = corpus([checked, itp]);

  test("keeps a verdict whose quote is in the cited passage, with the lines' hashes", async () => {
    const result = await checkVerdict({ verdict: "supported", reason: "ITP says so.", evidence: [{ passage: "P1", quote: "rapamycin increased median lifespan by 23% in males", stance: "supports" }] }, item, vault);
    expect(result.verdict).toBe("supported");
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ documentId: "doc-itp", blockId: "i0", lineStart: 2, lineEnd: 2, stance: "supports" });
    expect(result.evidence[0].lineHashes[0]).toMatch(/^[0-9a-f]{16}$/);
  });

  test("no citation, no verdict: an invented or mismatched quote becomes insufficient-evidence", async () => {
    for (const evidence of [
      [],
      [{ passage: "P1", quote: "rapamycin tripled lifespan in every mouse", stance: "supports" }],
      [{ passage: "P9", quote: "rapamycin increased median lifespan by 23% in males", stance: "supports" }],
      [{ passage: "P1", quote: "rapamycin increased median lifespan by 23% in males", stance: "contradicts" }],
      [{ passage: "P1", quote: "by 23%", stance: "supports" }],
    ]) {
      const result = await checkVerdict({ verdict: "supported", evidence }, item, vault);
      expect(result).toMatchObject({ verdict: "insufficient-evidence", evidence: [], downgraded: true });
    }
  });

  test("a passage whose document changed since it was shown can't carry a verdict", async () => {
    const edited = corpus([{ ...itp, blocks: [{ id: "i0", content: "Interventions Testing Program\n\nRewritten." }] }]);
    const result = await checkVerdict({ verdict: "supported", evidence: [{ passage: "P1", quote: "rapamycin increased median lifespan by 23% in males", stance: "supports" }] }, item, edited);
    expect(result.verdict).toBe("insufficient-evidence");
  });
});

describe("a claim check run", () => {
  test("extracts, checks against linked documents and search, and grounds every verdict", async () => {
    const ask = scripted([
      () => EXTRACT,
      (prompt) => JSON.stringify({ results: [
        { claim: "C1", verdict: "supported", reason: "The ITP note gives 23% for males.", evidence: [{ passage: passageFor(prompt, "ITP results"), quote: "rapamycin increased median lifespan by 23% in males", stance: "supports" }] },
        { claim: "C2", verdict: "contradicted", reason: "The review says it didn't extend lifespan.", evidence: [{ passage: passageFor(prompt, "Metformin review"), quote: "Metformin did not extend lifespan in the ITP mouse cohorts.", stance: "contradicts" }] },
      ] }),
    ]);
    const { claims, run } = await runClaimCheck({ source: checked, corpus: corpus([checked, itp, metformin]), ask, runId: "run-1", now: () => "2026-11-11T00:00:00.000Z" });
    expect(claims.map((claim) => [claim.anchor.blockId, claim.anchor.lineStart, claim.verdict])).toEqual([["b0", 2, "supported"], ["b1", 0, "contradicted"]]);
    // The checked document never counts as evidence for itself.
    expect(ask.prompts[1]).not.toContain("\"document\":\"Rapamycin notes\"");
    // Linked documents are offered first.
    expect(passageFor(ask.prompts[1], "ITP results")).toBe("P1");
    expect(run).toMatchObject({ modelCalls: 2, claims: 2, verdicts: { supported: 1, contradicted: 1 }, models: ["test-model"], omissions: [] });
    expect(run.documentsConsulted.sort()).toEqual(["doc-itp", "doc-met"]);
    for (const claim of claims) {
      expect(claim.evidence.length).toBeGreaterThan(0);
      for (const evidence of claim.evidence) expect(await resolveEvidence(evidence, corpus([itp, metformin]))).toMatchObject({ state: "ok" });
    }
    expect(claims[0].id).toMatch(/^claim-[0-9a-f]{16}$/);
  });

  test("a document hidden from AI is never read as evidence", async () => {
    const ask = scripted([() => JSON.stringify({ claims: [JSON.parse(EXTRACT).claims[1]] })]);
    // The corpus the app builds leaves hidden documents out of get(); search may still name them.
    const vault = corpus([checked, hidden]);
    const withoutHidden: RatchetCorpus = { get: (id) => id === hidden.id ? undefined : vault.get(id), search: vault.search };
    const { claims, run } = await runClaimCheck({ source: checked, corpus: withoutHidden, ask, runId: "run-2" });
    expect(claims[0]).toMatchObject({ verdict: "insufficient-evidence", evidence: [], reason: "Nothing in your vault bears on this claim." });
    expect(run.modelCalls).toBe(1);
    expect(run.documentsConsulted).toEqual([]);
  });

  test("a document with no checkable claims finishes cleanly", async () => {
    const ask = scripted([() => "{\"claims\":[]}"]);
    const { claims, run } = await runClaimCheck({ source: { id: "plain", title: "Shopping", blocks: [{ id: "x", content: "Eggs\nMilk" }] }, corpus: corpus([]), ask, runId: "run-3" });
    expect(claims).toEqual([]);
    expect(run).toMatchObject({ claims: 0, modelCalls: 1, omissions: [] });
  });

  test("a failed search is listed, and linked documents still count", async () => {
    const ask = scripted([() => JSON.stringify({ claims: [JSON.parse(EXTRACT).claims[0]] }), () => "{\"results\":[]}"]);
    const { claims, run } = await runClaimCheck({ source: checked, corpus: corpus([checked, itp], { failSearch: true }), ask, runId: "run-4" });
    expect(claims[0].verdict).toBe("insufficient-evidence");
    expect(run.omissions.join(" ")).toContain("vault search failed for 1 claim");
    expect(ask.prompts[1]).toContain("ITP results");
  });

  test("stops at its limit of model calls", () => {
    expect(RATCHET_MAX_MODEL_CALLS).toBe(8);
  });
});

describe("saved claims against an edited vault", () => {
  test("follows its lines when text above them changes, and goes stale when they change", async () => {
    const ask = scripted([() => JSON.stringify({ claims: [JSON.parse(EXTRACT).claims[0]] }), () => "{\"results\":[]}"]);
    const { claims: [claim] } = await runClaimCheck({ source: checked, corpus: corpus([checked]), ask, runId: "run-5" });
    const moved = { ...checked, blocks: [{ id: "b0", content: `New intro line.\n${checked.blocks[0].content}` }, checked.blocks[1]] };
    expect(await locateClaim(claim, moved)).toEqual({ state: "ok", blockId: "b0", lineStart: 3, lineEnd: 3 });
    // A block renamed by an edit above it: the lines are found by their hashes in the new block.
    const renamed = { ...checked, blocks: [{ id: "b0:part:40", content: checked.blocks[0].content }, checked.blocks[1]] };
    expect(await locateClaim(claim, renamed)).toEqual({ state: "ok", blockId: "b0:part:40", lineStart: 2, lineEnd: 2 });
    const edited = { ...checked, blocks: [{ id: "b0", content: checked.blocks[0].content.replace("23%", "25%") }, checked.blocks[1]] };
    expect(await locateClaim(claim, edited)).toEqual({ state: "anchor-stale" });
    expect(await locateClaim(claim, undefined)).toEqual({ state: "anchor-stale" });
  });

  test("a citation whose lines changed reads as source-changed, a deleted document as source-missing", async () => {
    const evidence = { documentId: "doc-itp", title: "ITP results", blockId: "i0", lineStart: 2, lineEnd: 2, lineHashes: ["0000000000000000"], quote: "rapamycin increased median lifespan", stance: "supports" as const };
    expect(await resolveEvidence(evidence, corpus([itp]))).toEqual({ state: "source-changed" });
    expect(await resolveEvidence(evidence, corpus([]))).toEqual({ state: "source-missing" });
  });

  test("highlights the claim's words, or its lines when the words moved", () => {
    const content = checked.blocks[0].content;
    const span = "extended median lifespan";
    const at = claimOffsets(content, 2, 2, span)!;
    expect(content.slice(at.from, at.to)).toBe(span);
    const whole = claimOffsets(content, 2, 2, "words no longer here")!;
    expect(content.slice(whole.from, whole.to)).toBe("Rapamycin extended median lifespan in male mice by 23% in the ITP study.");
    expect(claimOffsets(content, 9, 9, span)).toBeNull();
  });
});

const databases: PGlite[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((database) => database.close())); });

describe("saved claim checks on the server", () => {
  test("a check replaces the document's claims, stays private to the account, and refuses a verdict without a citation", async () => {
    const pg = new PGlite({ extensions: { vector } });
    databases.push(pg);
    const client = { async query(sql: string, values?: unknown[]) {
      const result = values === undefined && sql.includes(";") ? (await pg.exec(sql)).at(-1)! : await pg.query(sql, values);
      return { ...result, rowCount: result.rows.length || (result as { affectedRows?: number }).affectedRows || 0 };
    } };
    await migrateDatabase(client, { migrations: await loadMigrations() });
    await pg.query("insert into marginchat_users (id,email,password_hash,display_name) values ('u1','u1@example.test','hash','U1'), ('u2','u2@example.test','hash','U2')");
    const service = createRatchetService({ database: {
      saveRatchetCheck: (args: any) => ratchetRepository.saveRatchetCheck(client, args),
      readRatchetCheck: (args: any) => ratchetRepository.readRatchetCheck(client, args),
    } });

    const ask = scripted([
      () => EXTRACT,
      (prompt) => JSON.stringify({ results: [
        { claim: "C1", verdict: "supported", reason: "Yes.", evidence: [{ passage: passageFor(prompt, "ITP results"), quote: "rapamycin increased median lifespan by 23% in males", stance: "supports" }] },
      ] }),
    ]);
    const first = await runClaimCheck({ source: checked, corpus: corpus([checked, itp, metformin]), ask, runId: "run-a" });
    expect(await service.save({ userId: "u1", body: { documentId: checked.id, ...first } })).toEqual({ saved: 2, runId: "run-a" });
    const read = await service.read({ userId: "u1", documentId: checked.id });
    expect(read.claims).toEqual(JSON.parse(JSON.stringify(first.claims)));
    expect(read.run).toMatchObject({ id: "run-a", claims: 2 });
    expect(await service.read({ userId: "u2", documentId: checked.id })).toEqual({ claims: [], run: null });

    // A re-check that finds one claim leaves only that one.
    const again = { claims: [first.claims[1]], run: { ...first.run, id: "run-b", claims: 1, finishedAt: "2030-01-01T00:00:00.000Z" } };
    await service.save({ userId: "u1", body: { documentId: checked.id, ...again } });
    expect((await service.read({ userId: "u1", documentId: checked.id })).claims.map((claim: any) => claim.id)).toEqual([first.claims[1].id]);

    const bare = { ...first.claims[0], verdict: "supported", evidence: [] };
    await expect(service.save({ userId: "u1", body: { documentId: checked.id, claims: [bare], run: { ...first.run, claims: 1 } } })).rejects.toMatchObject({ statusCode: 400 });
    const elsewhere = { ...first.claims[0], documentId: "other" };
    await expect(service.save({ userId: "u1", body: { documentId: checked.id, claims: [elsewhere], run: { ...first.run, claims: 1 } } })).rejects.toMatchObject({ statusCode: 400 });
    // A refused check changes nothing.
    expect((await service.read({ userId: "u1", documentId: checked.id })).run).toMatchObject({ id: "run-b" });
  }, 30_000);
});
