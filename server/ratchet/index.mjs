import { HttpError } from "../lib/errors.mjs";

/**
 * Saved Ratchet checks (docs/ratchet-in-margin-chat-design.md §6). The browser
 * runs the check, since the vault lives there, and saves the claims it found
 * here so every device shows them and Slice 2 can re-check them without
 * finding them again. These rows are private to the account and never touch
 * the document. The server can't read a local vault to re-check citations, but
 * it refuses any verdict that carries none (principle 5).
 */

export const RATCHET_BODY_LIMIT = 2 * 1024 * 1024;
const MAX_CLAIMS = 25;
const MAX_EVIDENCE = 6;
const VERDICTS = new Set(["supported", "unsupported", "contradicted", "stale", "insufficient-evidence"]);
const STANCES = new Set(["supports", "contradicts", "supersedes", "related"]);
const HASH = /^[0-9a-f]{16}$/;

const text = (value, max) => (typeof value === "string" && value.length <= max ? value : null);
const id = (value) => (typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null);
const time = (value) => {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};
const line = (value) => (Number.isSafeInteger(value) && value >= 0 && value < 1_000_000 ? value : null);
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);

function readLines(input) {
  if (!isRecord(input)) return null;
  const lines = { blockId: id(input.blockId), lineStart: line(input.lineStart), lineEnd: line(input.lineEnd),
    lineHashes: Array.isArray(input.lineHashes) && input.lineHashes.every((hash) => typeof hash === "string" && HASH.test(hash)) ? input.lineHashes : null };
  if (!lines.blockId || lines.lineStart === null || lines.lineEnd === null || !lines.lineHashes) return null;
  return lines.lineEnd >= lines.lineStart && lines.lineHashes.length === lines.lineEnd - lines.lineStart + 1 && lines.lineHashes.length <= 40 ? lines : null;
}

const readModel = (input) => (isRecord(input) && text(input.model, 200) !== null && id(input.runId) ? { model: input.model, runId: input.runId } : null);

function readEvidence(input) {
  const lines = readLines(input);
  if (!lines) return null;
  const evidence = { documentId: id(input.documentId), title: text(input.title, 1000), ...lines, quote: text(input.quote, 1000), stance: STANCES.has(input.stance) ? input.stance : null };
  return evidence.documentId && evidence.title !== null && evidence.quote && evidence.stance ? evidence : null;
}

function readClaim(input, documentId) {
  if (!isRecord(input)) return null;
  const anchor = readLines(input.anchor);
  const evidence = Array.isArray(input.evidence) && input.evidence.length <= MAX_EVIDENCE ? input.evidence.map(readEvidence) : null;
  const claim = {
    id: id(input.id), documentId: input.documentId === documentId ? documentId : null, anchor,
    span: text(input.span, 2000), claim: text(input.claim, 1000),
    extractedBy: readModel(input.extractedBy), createdAt: time(input.createdAt),
    verdict: VERDICTS.has(input.verdict) ? input.verdict : null, verdictAt: time(input.verdictAt), verdictBy: readModel(input.verdictBy),
    evidence, reason: text(input.reason ?? "", 1000),
  };
  if (!claim.id || !claim.documentId || !anchor || !claim.span || !claim.claim || !claim.extractedBy || !claim.createdAt
    || !claim.verdict || !claim.verdictAt || !claim.verdictBy || !evidence || evidence.some((item) => !item) || claim.reason === null) return null;
  // No citation, no verdict.
  if ((claim.verdict === "insufficient-evidence") !== (evidence.length === 0)) return null;
  return claim;
}

function readRun(input, documentId) {
  if (!isRecord(input)) return null;
  const strings = (value, max, count) => (Array.isArray(value) && value.length <= count && value.every((item) => text(item, max) !== null) ? value : null);
  const verdicts = isRecord(input.verdicts) && Object.entries(input.verdicts).every(([key, value]) => VERDICTS.has(key) && line(value) !== null) ? input.verdicts : null;
  const run = {
    id: id(input.id), documentId: input.documentId === documentId ? documentId : null, startedAt: time(input.startedAt), finishedAt: time(input.finishedAt),
    models: strings(input.models, 200, 10), modelCalls: line(input.modelCalls), claims: line(input.claims), verdicts,
    passagesConsulted: line(input.passagesConsulted), documentsConsulted: strings(input.documentsConsulted, 200, 500), omissions: strings(input.omissions, 1000, 20),
  };
  return Object.values(run).every((value) => value !== null) ? run : null;
}

export function createRatchetService({ database }) {
  async function save({ userId, body }) {
    if (!isRecord(body)) throw new HttpError(400, "Send the claim check as JSON.");
    const documentId = id(body.documentId);
    if (!documentId) throw new HttpError(400, "Say which document was checked.");
    if (!Array.isArray(body.claims) || body.claims.length > MAX_CLAIMS) throw new HttpError(413, `Send at most ${MAX_CLAIMS} claims.`);
    const claims = body.claims.map((claim) => readClaim(claim, documentId));
    const run = readRun(body.run, documentId);
    // Refuse the whole check rather than keep part of it.
    if (claims.some((claim) => !claim) || !run || run.claims !== claims.length) throw new HttpError(400, "Some of the claim check was not readable.");
    if (new Set(claims.map((claim) => claim.id)).size !== claims.length) throw new HttpError(400, "A claim was sent twice.");
    await database.saveRatchetCheck({ userId, documentId, claims, run });
    return { saved: claims.length, runId: run.id };
  }

  async function read({ userId, documentId }) {
    const valid = id(documentId);
    if (!valid) throw new HttpError(400, "Say which document's claims to read.");
    return database.readRatchetCheck({ userId, documentId: valid });
  }

  return { save, read };
}
