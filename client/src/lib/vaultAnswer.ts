import type { AIRetrievalPassage, AIRetrievalRecord, AISettings, Conversation, DocumentRelation, Message } from "../types";
import type { DocumentBlock } from "./editableDocument";
import { splitDocumentMarkdown } from "./editableDocument";
import { normalizeAISettings } from "@margin-chat/workspace-contracts";
import { excerpt } from "./tree";

/**
 * "Answer from my vault": a short answer to a search, written only from passages
 * of the user's own vault and citing them, which the user can save as a
 * document linked to its sources.
 */

/** How the answer must be written. The question itself goes in as the user's message, so the vault is searched by it. */
export const VAULT_ANSWER_INSTRUCTION = [
  "Answer the user's question from the passages of their own vault that come with this request.",
  "Cite every claim that comes from a passage as [Vault N]. Do not answer from general knowledge; when the passages don't cover the question, say so in one line and name what is missing.",
  "If one passage's document already answers the question on its own, say so in the first line, citing it.",
  "Keep it short: a direct answer first, then a few lines or bullets of support. Use Markdown. Do not repeat the question as a heading.",
].join(" ");

const CITATION = /\[Vault ((?:\d+\s*,\s*)*\d+)\]/gu;
/** A citation with the space before it, so one that can't be linked leaves no gap behind. */
const SPACED_CITATION = /[ \t]?\[Vault ((?:\d+\s*,\s*)*\d+)\]/gu;

/** Most passages search sends with one reply ("thorough" sends 10). */
const ANSWER_MODE = "thorough" as const;

/** Search my workspace, no agent: the server adds the vault's best passages as [Vault N]. */
export function vaultAnswerSettings(ai: AISettings | undefined): AISettings {
  const base = normalizeAISettings(ai);
  return { ...base, mode: ANSWER_MODE, contextScope: "workspace", agent: false, agentAuto: false, selectedConversationIds: [] };
}

export function vaultAnswerMessages(question: string, now = new Date().toISOString(), createId: (prefix: string) => string): Message[] {
  return [
    { id: createId("message"), role: "system", content: VAULT_ANSWER_INSTRUCTION, createdAt: now },
    { id: createId("message"), role: "user", content: question.trim(), createdAt: now },
  ];
}

/** Marks the passages `answer` cites as [Vault N] (also "[Vault 1, 3]"), as the server does once the reply is done. */
export function markCitedPassages(retrieval: AIRetrievalRecord | null | undefined, answer: string): AIRetrievalRecord | null {
  if (!retrieval) return null;
  const cited = new Set<string>();
  for (const match of answer.matchAll(CITATION)) for (const value of match[1].split(",")) cited.add(`Vault ${value.trim()}`);
  return { ...retrieval, passages: retrieval.passages.map((passage) => ({ ...passage, ...(passage.label && cited.has(passage.label) ? { cited: true } : {}) })) };
}

/** The passages an answer drew on, cited ones first, one per document. */
export function vaultAnswerSources(retrieval: AIRetrievalRecord | null | undefined): AIRetrievalPassage[] {
  if (!retrieval?.passages?.length) return [];
  const seen = new Set<string>();
  const ordered = [...retrieval.passages.filter((passage) => passage.cited), ...retrieval.passages.filter((passage) => !passage.cited)];
  return ordered.filter((passage) => {
    const key = passage.openId ?? passage.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);
const wikiTitle = (title: string) => title.replace(/[[\]|#^\n]/gu, " ").replace(/\s+/gu, " ").trim() || "Untitled";

/**
 * The answer as a document's Markdown: each [Vault N] becomes a [[link]] to the
 * document it came from, and a Sources list links every cited document, so the
 * Map draws the answer among them.
 */
export function vaultAnswerMarkdown(answer: string, retrieval: AIRetrievalRecord | null | undefined): string {
  const passages = retrieval?.passages ?? [];
  const byLabel = new Map(passages.flatMap((passage) => passage.label ? [[passage.label, passage] as const] : []));
  const cited: AIRetrievalPassage[] = [];
  const body = answer.replace(SPACED_CITATION, (_match, numbers: string) => {
    const links = [...new Set(numbers.split(",").map((value) => byLabel.get(`Vault ${value.trim()}`)).filter((passage): passage is AIRetrievalPassage => !!passage)
      .map((passage) => {
        if (!cited.some((item) => (item.openId ?? item.id) === (passage.openId ?? passage.id))) cited.push(passage);
        return `[[${wikiTitle(passage.title)}]]`;
      }))];
    return links.length ? ` (${links.join(", ")})` : "";
  }).trim();
  const sources = cited.length ? cited : vaultAnswerSources(retrieval).filter((passage) => passage.cited);
  if (!sources.length) return body;
  const list = sources.map((passage) => `- [[${wikiTitle(passage.title)}]]${passage.heading ? ` · ${passage.heading.replace(/\n/gu, " ")}` : ""}`);
  return `${body}\n\n## Sources\n\n${list.join("\n")}`;
}

/**
 * A new top-level document holding the question and the answer. The answer's
 * blocks come from the assistant message, so line authorship credits them to AI.
 */
export function createVaultAnswerDocument(args: {
  question: string;
  answer: string;
  retrieval: AIRetrievalRecord | null | undefined;
  serviceId: Conversation["serviceId"];
  modelId: string;
  ai?: AISettings;
  createId: (prefix: string) => string;
  now?: string;
}): Conversation {
  const now = args.now ?? new Date().toISOString();
  const markdown = vaultAnswerMarkdown(args.answer, args.retrieval);
  const question: Message = { id: args.createId("message"), role: "user", content: args.question.trim(), createdAt: now };
  const reply: Message = { id: args.createId("message"), role: "assistant", content: markdown, createdAt: now };
  const blocks = answerBlocks(markdown, reply.id, args.createId("block"), now);
  return {
    nodeType: ANSWER_NODE_TYPE, relations: citesRelations(markCitedPassages(args.retrieval, args.answer), now),
    id: args.createId("conversation"), kind: "chat", title: capitalize(excerpt(args.question.trim().replace(/\?+$/u, ""), 80)) || "Answer",
    parentId: null, serviceId: args.serviceId, modelId: args.modelId, ...(args.ai ? { ai: structuredClone(args.ai) } : {}),
    branchAnchor: null, childIds: [], documents: [], messages: [question, reply], notes: [], createdAt: now, updatedAt: now,
    document: { schemaVersion: 1, blocks, prompts: [], generations: [] },
  };
}

/** Saved answers carry `type: answer`, so they can be told apart and refreshed. */
export const ANSWER_NODE_TYPE = "answer";

export const isVaultAnswer = (conversation: Conversation | undefined | null) => conversation?.nodeType === ANSWER_NODE_TYPE;

function answerBlocks(markdown: string, messageId: string, blockBase: string, now: string): DocumentBlock[] {
  let offset = 0;
  return splitDocumentMarkdown(markdown).map((content, index): DocumentBlock => {
    const block: DocumentBlock = { id: index ? `${blockBase}:part:${offset}` : blockBase, kind: "markdown", content, createdAt: now, updatedAt: now,
      sourceMessageId: messageId, authorship: "ai" };
    offset += content.length;
    return block;
  });
}

/**
 * A "cites" relation to each document the answer cites, dated now: the Map draws
 * them, and a source edited after that date marks the answer as worth refreshing.
 */
export function citesRelations(retrieval: AIRetrievalRecord | null | undefined, now: string): DocumentRelation[] {
  const seen = new Set<string>();
  return vaultAnswerSources(retrieval).filter((passage) => passage.cited).flatMap((passage): DocumentRelation[] => {
    const target = passage.openId ?? passage.id;
    if (seen.has(target)) return [];
    seen.add(target);
    return [{ type: "cites", targetConversationId: target, ...(passage.kind === "document" && passage.blockId ? { targetBlockId: passage.blockId } : {}),
      origin: "ai", createdAt: now }];
  });
}

const words = (text: string) => new Set(text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2));

/** How alike two questions are, by the words they share (0 to 1). */
export function questionSimilarity(left: string, right: string) {
  const a = words(left), b = words(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

const SAME_QUESTION = 0.75;

/** A saved answer to (nearly) the same question, so the user can update it instead of saving a second copy. */
export function findSavedAnswer(conversations: Record<string, Conversation>, question: string): Conversation | null {
  let best: Conversation | null = null;
  let bestScore = SAME_QUESTION;
  for (const conversation of Object.values(conversations)) {
    if (!isVaultAnswer(conversation) || !conversation.document) continue;
    const score = questionSimilarity(conversation.title, question);
    if (score >= bestScore) { best = conversation; bestScore = score; }
  }
  return best;
}

/** The cited documents edited since the answer cited them. */
export function changedAnswerSources(conversations: Record<string, Conversation>, answer: Conversation): Conversation[] {
  if (!isVaultAnswer(answer)) return [];
  const changed = new Map<string, Conversation>();
  for (const relation of answer.relations ?? []) {
    if (relation.type !== "cites" || !relation.targetConversationId || !relation.createdAt) continue;
    const target = conversations[relation.targetConversationId];
    if (target && Date.parse(target.updatedAt) > Date.parse(relation.createdAt) + 1000) changed.set(target.id, target);
  }
  return [...changed.values()];
}

/**
 * A saved answer updated with a new one. When every line is still the AI's, the
 * new answer replaces it; when the user wrote in it, their lines stay and the new
 * answer is added under an "Updated" heading. Its "cites" relations are renewed.
 */
export function updateVaultAnswerDocument(existing: Conversation, args: {
  answer: string; retrieval: AIRetrievalRecord | null | undefined; createId: (prefix: string) => string; now?: string;
}): Conversation {
  const now = args.now ?? new Date().toISOString();
  const blocks = existing.document?.blocks ?? [];
  const untouched = blocks.every((block) => block.authorship === "ai" || !block.content.trim());
  const day = now.slice(0, 10);
  const markdown = untouched ? vaultAnswerMarkdown(args.answer, args.retrieval) : `## Updated answer, ${day}\n\n${vaultAnswerMarkdown(args.answer, args.retrieval)}`;
  const reply: Message = { id: args.createId("message"), role: "assistant", content: markdown, createdAt: now };
  const added = answerBlocks(markdown, reply.id, args.createId("block"), now);
  const cites = citesRelations(markCitedPassages(args.retrieval, args.answer), now);
  const kept = (existing.relations ?? []).filter((relation) => relation.type !== "cites"
    || (!untouched && !cites.some((cite) => cite.targetConversationId === relation.targetConversationId)));
  return {
    ...existing, nodeType: ANSWER_NODE_TYPE, relations: [...kept, ...cites], messages: [...existing.messages, reply], updatedAt: now,
    document: { schemaVersion: 1, prompts: [], generations: [], ...existing.document, blocks: untouched ? added : [...blocks, ...added] },
  };
}
