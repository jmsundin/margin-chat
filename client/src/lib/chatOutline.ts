import { Marked } from "marked";
import type { Conversation } from "../types";
import { excerpt } from "./tree";
import { getEditableDocument } from "./editableDocument";

export type ChatOutlineItem = {
  id: string;
  kind: "heading" | "prompt" | "response";
  label: string;
  level: number;
  messageId: string;
  /** Paragraph targets that share this response's navigation entry. */
  memberIds?: string[];
};

export type ChatOutlineResponse = {
  item: ChatOutlineItem;
  headings: ChatOutlineItem[];
};

export type ChatOutlineSection = {
  id: string;
  prompt: ChatOutlineItem | null;
  responses: ChatOutlineResponse[];
  headings: ChatOutlineItem[];
};

const outlineMarkdown = new Marked({ gfm: true, silent: true });

function cleanOutlineLabel(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function getMessageOutlineId(messageId: string) {
  return `message-${messageId}`;
}

export function getHeadingOutlineId(messageId: string, headingIndex: number) {
  return `heading-${messageId}-${headingIndex}`;
}

export function buildChatOutline(conversation: Conversation): ChatOutlineItem[] {
  if (conversation.document) return buildEditableDocumentOutline(conversation);
  const outline: ChatOutlineItem[] = [];
  let responseNumber = 0;

  for (const message of conversation.messages) {
    if (message.role === "user") {
      const label = cleanOutlineLabel(message.content);
      if (label) outline.push({
        id: getMessageOutlineId(message.id), kind: "prompt", label: excerpt(label, 58), level: 0, messageId: message.id,
      });
      continue;
    }
    if (message.role !== "assistant") continue;

    responseNumber += 1;
    outline.push({
      id: getMessageOutlineId(message.id), kind: "response", label: `AI response ${responseNumber}`, level: 0, messageId: message.id,
    });

    // Match the rendered h1–h3 order, including setext/nested headings and
    // excluding heading-like lines inside fenced code blocks.
    let headingIndex = 0;
    outlineMarkdown.walkTokens(outlineMarkdown.lexer(message.content), (token) => {
      if (token.type !== "heading" || token.depth > 3) return;
      const id = getHeadingOutlineId(message.id, headingIndex++);
      const label = cleanOutlineLabel(token.text);
      if (label) outline.push({ id, kind: "heading", label: excerpt(label, 58), level: token.depth, messageId: message.id });
    });
  }
  return outline;
}

/** Match the editable renderer, including the lazy projection of older chats. */
export function buildEditableDocumentOutline(conversation: Conversation): ChatOutlineItem[] {
  const document = getEditableDocument(conversation);
  const outline: ChatOutlineItem[] = [];
  const prompts = new Map(document.prompts.map((prompt) => [prompt.id, prompt]));
  const generations = new Map(document.generations.map((generation) => [generation.id, generation]));
  const visiblePromptIds = new Set(document.blocks.length ? document.prompts
    .filter((prompt) => !document.generations.some((generation) => generation.promptId === prompt.id && generation.alternativeOf))
    .map((prompt) => prompt.id) : []);
  const seenPrompts = new Set<string>();
  const responseNumbers = new Map<string, number>();
  let authoredNumber = 0;
  let previousResponseKey: string | undefined;
  let currentResponse: ChatOutlineItem | undefined;
  const addPrompt = (promptId: string) => {
    const prompt = prompts.get(promptId);
    if (!prompt || !visiblePromptIds.has(promptId) || seenPrompts.has(promptId)) return;
    seenPrompts.add(promptId);
    const messageId = prompt.sourceMessageId ?? `document-prompt:${prompt.id}`;
    outline.push({ id: getMessageOutlineId(messageId), messageId, kind: "prompt", label: excerpt(cleanOutlineLabel(prompt.content), 58), level: 0 });
  };
  const originalGeneration = (generation: typeof document.generations[number]) => {
    const seen = new Set<string>();
    while (generation.alternativeOf && !seen.has(generation.id)) {
      seen.add(generation.id);
      const original = generations.get(generation.alternativeOf);
      if (!original) break;
      generation = original;
    }
    return generation;
  };
  for (const block of document.blocks) {
    const generation = block.generationId ? generations.get(block.generationId) : undefined;
    if (generation) addPrompt(originalGeneration(generation).promptId);
    const messageId = `document:${block.id}`;
    const responseKey = generation?.id ?? (conversation.messages.some((message) => message.id === block.sourceMessageId && message.role === "assistant") ? block.sourceMessageId : undefined);
    if (responseKey && responseKey === previousResponseKey && currentResponse) {
      currentResponse.memberIds!.push(getMessageOutlineId(messageId));
    } else {
      let label: string;
      if (responseKey) {
        const continued = responseNumbers.has(responseKey);
        if (!continued) responseNumbers.set(responseKey, responseNumbers.size + 1);
        label = `AI response ${responseNumbers.get(responseKey)}${continued ? " · continued" : ""}`;
      } else label = `Written section ${++authoredNumber}`;
      currentResponse = { id: getMessageOutlineId(messageId), messageId, kind: "response", label, level: 0, memberIds: [getMessageOutlineId(messageId)] };
      outline.push(currentResponse);
    }
    previousResponseKey = responseKey;
    let headingIndex = 0;
    outlineMarkdown.walkTokens(outlineMarkdown.lexer(block.content), (token) => {
      if (token.type !== "heading" || token.depth > 3) return;
      const id = getHeadingOutlineId(messageId, headingIndex++);
      const heading = cleanOutlineLabel(token.text);
      if (heading) outline.push({ id, messageId: currentResponse!.messageId, kind: "heading", label: excerpt(heading, 58), level: token.depth });
    });
  }
  // Pending prompts and prompts whose generated text was removed still have a
  // saved margin control, so their navigation target remains useful.
  for (const prompt of document.prompts) addPrompt(prompt.id);
  return outline;
}

/** Group the navigation index without changing any message or heading target. */
export function groupChatOutline(items: ChatOutlineItem[]): ChatOutlineSection[] {
  const sections: ChatOutlineSection[] = [];
  let section: ChatOutlineSection | undefined;
  let response: ChatOutlineResponse | undefined;
  for (const item of items) {
    if (!section || item.kind === "prompt") {
      section = { id: item.id, prompt: item.kind === "prompt" ? item : null, responses: [], headings: [] };
      sections.push(section);
      response = undefined;
    }
    if (item.kind === "response") {
      response = { item, headings: [] };
      section.responses.push(response);
    } else if (item.kind === "heading") {
      // Older or note-only outline inputs still retain their original links.
      if (response?.item.messageId === item.messageId) response.headings.push(item);
      else section.headings.push(item);
    }
  }
  return sections;
}
