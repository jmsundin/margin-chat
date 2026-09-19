import { Lexer, type Token, type Tokens } from "marked";
import type { Conversation } from "../types";
import { findObsidianInlineTokens } from "./obsidianMarkdown";
import { getStandaloneNote, getStandaloneNoteContextMessageId } from "./standaloneNotes";

export interface ConversationAnnotationPreview {
  kind: "chat" | "note";
  prompt?: string;
  content: string;
  messageCount?: number;
}

const MAX_SOURCE_LENGTH = 20_000;
const CONTEXT_MESSAGE_PREFIX = getStandaloneNoteContextMessageId("");

function decodeEntities(value: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name: string) => {
    if (!name.startsWith("#")) return named[name.toLowerCase()];
    const number = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
      ? String.fromCodePoint(number) : entity;
  });
}

function tokenText(tokens: Token[]): string {
  return tokens.map((token): string => {
    switch (token.type) {
      case "space": case "hr": case "br": return " ";
      case "checkbox": case "def": return "";
      case "escape": case "codespan": return token.text;
      case "code": return token.text + " ";
      case "list": return token.items.map((item: Tokens.ListItem) => tokenText(item.tokens)).join(" ") + " ";
      case "table": return [token.header, ...token.rows].map((row: Tokens.TableCell[]) => row.map((cell) => tokenText(cell.tokens)).join(" ")).join(" ") + " ";
      case "html": return decodeEntities(token.text
        .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
        .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
        .replace(/<\/?[a-z][^>]*>/gi, " "));
      case "paragraph": case "heading": case "blockquote":
        return tokenText(token.tokens ?? []) + " ";
      default:
        return "tokens" in token && token.tokens ? tokenText(token.tokens)
          : "text" in token ? decodeEntities(token.text) : "";
    }
  }).join("");
}

/** Plain text only; bounded work and output, without rendering HTML or loading media. */
export function summarizeAnnotationText(content: string, maxLength = 300): string {
  const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 300;
  if (!limit) return "";
  let source = content.slice(0, MAX_SOURCE_LENGTH);
  // Reuse the editor's code-aware ranges so literal Markdown inside code stays intact.
  for (const token of findObsidianInlineTokens(source).reverse()) {
    const replacement = token.kind === "comment" ? " "
      : source.slice(token.labelFrom ?? token.contentFrom, token.labelTo ?? token.contentTo);
    source = source.slice(0, token.from) + replacement + source.slice(token.to);
  }
  const plain = tokenText(Lexer.lex(source, { gfm: true })).replace(/\s+/g, " ").trim();
  if (!plain) return "";
  if (plain.length <= limit && content.length <= MAX_SOURCE_LENGTH) return plain;
  if (limit === 1) return "…";
  let prefix = plain.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
  const boundary = prefix.lastIndexOf(" ");
  if (boundary >= limit * 0.65) prefix = prefix.slice(0, boundary);
  return `${prefix}…`;
}

export function getConversationAnnotationPreview(conversation: Conversation): ConversationAnnotationPreview {
  if (conversation.kind === "note") {
    return { kind: "note", content: summarizeAnnotationText(getStandaloneNote(conversation)?.content ?? "") };
  }

  let prompt: string | undefined;
  let content = "";
  let messageCount = 0;
  for (const message of conversation.messages) {
    if (message.role === "system" || message.id.startsWith(CONTEXT_MESSAGE_PREFIX)) continue;
    const summary = summarizeAnnotationText(message.content, message.role === "user" ? 160 : 300);
    if (!summary) continue;
    messageCount++;
    if (message.role === "user" && prompt === undefined) prompt = summary;
    if (message.role === "assistant") content = summary;
  }
  return { kind: "chat", ...(prompt ? { prompt } : {}), content, messageCount };
}
