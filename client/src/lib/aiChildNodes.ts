import type { Tokens } from "marked";
import type { AppState, Conversation } from "../types";
import type { DocumentBlock, DocumentGeneration, EditableDocument } from "./editableDocument";
import { latexMarkdownLexer } from "./latex";
import { getEditableDocument, splitDocumentMarkdown } from "./editableDocument";
import { addChildConversation } from "./workspaceCommands";
import { closeDocument } from "./documentWorkspace";

/** One proposed child node: a titled part of an AI response, anchored to its passage in the parent. */
export interface AIChildNodeProposal {
  id: string;
  title: string;
  content: string;
  /** The parent block and source offsets the child's highlight anchors to. */
  blockId: string;
  from: number;
  to: number;
}

export const MAX_AI_CHILD_NODES = 12;
const TITLE_LENGTH = 72;

type Token = ReturnType<typeof latexMarkdownLexer.lexer>[number];
interface Located { token: Token; block: DocumentBlock; start: number }

/** Markdown inline syntax removed for a readable title; the anchor keeps the source text. */
export function plainTitle(markdown: string): string {
  const text = markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[:：.\s–—-]+$/, "");
  return text.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : text;
}

/** The blocks currently showing a generation, in document order (edits and splits keep its ID). */
export function getGenerationBlocks(document: EditableDocument, generation: Pick<DocumentGeneration, "id" | "blockIds">): DocumentBlock[] {
  return document.blocks.filter((block) => block.generationId === generation.id || generation.blockIds.includes(block.id));
}

function locate(blocks: DocumentBlock[]): Located[] {
  const located: Located[] = [];
  for (const block of blocks) {
    let offset = 0;
    for (const token of latexMarkdownLexer.lexer(block.content)) {
      // Tokens cover the source exactly; find each one so offsets stay exact even if the lexer normalizes.
      const start = block.content.indexOf(token.raw, offset);
      if (start < 0) continue;
      offset = start + token.raw.length;
      if (token.type !== "space") located.push({ token, block, start });
    }
  }
  return located;
}

/** An exact source range for the title text, so the parent shows a highlight that opens the child. */
function anchor(block: DocumentBlock, searchFrom: number, searchTo: number, quote: string) {
  const trimmed = quote.trim();
  const from = trimmed ? block.content.indexOf(trimmed, searchFrom) : -1;
  if (from < 0 || from + trimmed.length > searchTo) return null;
  return { blockId: block.id, from, to: from + trimmed.length };
}

function fromHeadings(located: Located[]): AIChildNodeProposal[] {
  const headings = located.filter((item) => item.token.type === "heading") as Array<Located & { token: Tokens.Heading }>;
  if (!headings.length) return [];
  const levels = [...new Set(headings.map((item) => item.token.depth))].sort((a, b) => a - b);
  // A single top heading is usually the response's own title; split by the level below it.
  const depth = levels.find((level) => headings.filter((item) => item.token.depth === level).length >= 2) ?? levels[0];
  const proposals: AIChildNodeProposal[] = [];
  located.forEach((item, index) => {
    if (item.token.type !== "heading" || (item.token as Tokens.Heading).depth !== depth) return;
    const heading = item.token as Tokens.Heading;
    const end = located.findIndex((next, nextIndex) => nextIndex > index && next.token.type === "heading" && (next.token as Tokens.Heading).depth <= depth);
    const body = located.slice(index + 1, end < 0 ? undefined : end).map((part) => part.token.raw).join("").trim();
    const title = plainTitle(heading.text);
    const range = anchor(item.block, item.start, item.start + heading.raw.length, heading.text);
    if (title && range) proposals.push({ id: `heading:${item.block.id}:${item.start}`, title, content: body || title, ...range });
  });
  return proposals;
}

/** Bold lead-ins ("**Topic**: …" or "Topic: …") make the best titles; otherwise the first sentence. */
function itemTitle(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? "";
  const bold = /^\s*(\*\*|__)(.+?)\1/.exec(firstLine);
  if (bold) return bold[2];
  const leadIn = /^([^:.!?]{2,60}):\s/.exec(firstLine);
  if (leadIn) return leadIn[1];
  return /^(.+?[.!?])(\s|$)/.exec(firstLine)?.[1] ?? firstLine;
}

function dedent(raw: string): string {
  const lines = raw.replace(/\s+$/, "").split(/\r?\n/);
  const first = lines[0].replace(/^\s*(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "");
  const indent = Math.min(...lines.slice(1).filter((line) => line.trim()).map((line) => /^\s*/.exec(line)![0].length));
  return [first, ...lines.slice(1).map((line) => line.slice(Number.isFinite(indent) ? indent : 0))].join("\n").trim();
}

function fromLists(located: Located[]): AIChildNodeProposal[] {
  const lists = located.filter((item) => item.token.type === "list" && (item.token as Tokens.List).items.length >= 2) as Array<Located & { token: Tokens.List }>;
  if (!lists.length) return [];
  // The response's main list is its longest one; nested lists stay inside their item.
  const main = lists.reduce((best, item) => item.token.items.length > best.token.items.length ? item : best);
  const proposals: AIChildNodeProposal[] = [];
  let offset = main.start;
  for (const item of main.token.items) {
    const start = main.block.content.indexOf(item.raw, offset);
    if (start < 0) continue;
    offset = start + item.raw.length;
    const content = dedent(item.raw);
    const quote = itemTitle(content);
    const title = plainTitle(quote);
    const range = anchor(main.block, start, start + item.raw.length, quote.replace(/^(\*\*|__)|(\*\*|__)$/g, ""));
    if (title && range) proposals.push({ id: `item:${main.block.id}:${start}`, title, content, ...range });
  }
  return proposals;
}

function fromParagraphs(located: Located[]): AIChildNodeProposal[] {
  const paragraphs = located.filter((item) => item.token.type === "paragraph");
  if (paragraphs.length < 2) return [];
  return paragraphs.flatMap((item) => {
    const content = item.token.raw.trim();
    const quote = itemTitle(content).replace(/^(\*\*|__)|(\*\*|__)$/g, "");
    const title = plainTitle(quote);
    const range = anchor(item.block, item.start, item.start + item.token.raw.length, quote);
    return title && range ? [{ id: `paragraph:${item.block.id}:${item.start}`, title, content, ...range }] : [];
  });
}

/** Split an AI response into child-node proposals by its headings, else its main list, else its paragraphs. */
export function proposeAIChildNodes(blocks: DocumentBlock[]): AIChildNodeProposal[] {
  const located = locate(blocks);
  for (const strategy of [fromHeadings, fromLists, fromParagraphs]) {
    const proposals = strategy(located);
    if (proposals.length) return proposals.slice(0, MAX_AI_CHILD_NODES);
  }
  return [];
}

function childDocument(content: string, createdAt: string, idBase: string): EditableDocument {
  let offset = 0;
  const blocks = splitDocumentMarkdown(content).map((part, index): DocumentBlock => {
    const block: DocumentBlock = { id: index ? `${idBase}:part:${offset}` : idBase, kind: "markdown", content: part, createdAt, updatedAt: createdAt, authorship: "ai" };
    offset += part.length;
    return block;
  });
  return { schemaVersion: 1, blocks, prompts: [], generations: [] };
}

/**
 * Create each picked proposal as a child document of the parent: anchored to its passage (so it is a
 * child, not a peer), placed beside the parent in the map, and left closed in Document view.
 */
export function addAIChildNodes(state: AppState, parentId: string, proposals: AIChildNodeProposal[], options: {
  createId: (prefix: string) => string;
  now?: string;
}): { state: AppState; createdIds: string[] } {
  const parent = state.conversations[parentId];
  if (!parent) return { state, createdIds: [] };
  const now = options.now ?? new Date().toISOString();
  const createdIds: string[] = [];
  let next = state;
  for (const proposal of proposals) {
    const block = getEditableDocument(parent).blocks.find((candidate) => candidate.id === proposal.blockId);
    const title = proposal.title.trim();
    if (!title) continue;
    const quote = block?.content.slice(proposal.from, proposal.to) ?? "";
    const id = options.createId("conversation");
    const child: Conversation = {
      id, kind: "chat", title, parentId: parent.id,
      serviceId: parent.serviceId, modelId: parent.modelId, ...(parent.ai ? { ai: structuredClone(parent.ai) } : {}),
      branchAnchor: block && quote.trim() ? { id: options.createId("anchor"), sourceConversationId: parent.id,
        sourceMessageId: block.sourceMessageId ?? `document:${block.id}`, sourceBlockId: block.id,
        startOffset: proposal.from, endOffset: proposal.to, quote, prompt: "Child node from AI response", createdAt: now } : null,
      childIds: [], documents: [], messages: [], notes: [], createdAt: now, updatedAt: now,
      document: childDocument(proposal.content.trim() || title, now, options.createId("block")),
    };
    next = closeDocument(addChildConversation(next, child), id);
    if (next.conversations[id]) createdIds.push(id);
  }
  return { state: next, createdIds };
}
