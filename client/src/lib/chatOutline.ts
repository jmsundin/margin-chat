import { Marked } from "marked";
import type { Conversation } from "../types";
import { excerpt } from "./tree";

export type ChatOutlineItem = {
  id: string;
  kind: "heading" | "prompt" | "response";
  label: string;
  level: number;
  messageId: string;
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
