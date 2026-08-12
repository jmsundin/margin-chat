import type { Conversation } from "../types";
import { excerpt } from "./tree";

export type ChatOutlineItem = {
  id: string;
  kind: "heading" | "prompt";
  label: string;
  level: number;
  messageId: string;
};

const MARKDOWN_HEADING_PATTERN = /^(#{1,3})[ \t]+(.+?)\s*#*\s*$/gm;

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

  for (const message of conversation.messages) {
    if (message.role === "user") {
      const label = cleanOutlineLabel(message.content);

      if (label) {
        outline.push({
          id: getMessageOutlineId(message.id),
          kind: "prompt",
          label: excerpt(label, 58),
          level: 0,
          messageId: message.id,
        });
      }

      continue;
    }

    if (message.role !== "assistant") {
      continue;
    }

    let headingIndex = 0;

    for (const match of message.content.matchAll(MARKDOWN_HEADING_PATTERN)) {
      const label = cleanOutlineLabel(match[2] ?? "");

      if (!label) {
        continue;
      }

      outline.push({
        id: getHeadingOutlineId(message.id, headingIndex),
        kind: "heading",
        label: excerpt(label, 58),
        level: Math.min(match[1]?.length ?? 1, 3),
        messageId: message.id,
      });
      headingIndex += 1;
    }
  }

  return outline;
}
