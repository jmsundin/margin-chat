import { pastedWebAddresses } from "./webTools.mjs";

/** Prompts this long usually carry their own material, so a bare "the plan" in them is not a lookup. */
const SHORT_PROMPT_CHARACTERS = 240;

const ASKS_ABOUT_VAULT = [
  /\b(?:my|our)\s+(?:own\s+)?(?:saved\s+)?(?:notes?|vault|docs?|documents?|files?|pdfs?|chats?|conversations?|journal|highlights?|bookmarks?|reading\s+list|workspace|second\s+brain)\b/iu,
  /\b(?:what|where|when)\s+(?:did|have|had)\s+(?:i|we)\s+(?:ever\s+)?(?:write|wrote|save|saved|note|noted|mention|mentioned|say|said|discuss|discussed|decide|decided|read)\b/iu,
  /\b(?:i|we)\s+(?:wrote|saved|noted\s+down|bookmarked|highlighted)\b/iu,
];

const REFERS_TO_SOMETHING = /\b(?:the|that)\s+(?:doc|document|note|notes|plan|project|draft|meeting|spec|outline|proposal|list|article|paper|book|essay|email|idea|ideas|thread|conversation|chat|research|summary)\b/iu;
const REFERS_BACK = /\b(?:as|like)\s+(?:i|we)\s+(?:said|discussed|mentioned|planned)\b|\b(?:last\s+time|the\s+other\s+day|remind\s+me)\b/iu;

function latestPrompt(chatRequest) {
  return [...(chatRequest.messages ?? [])].reverse().find((message) => message.role === "user")?.content?.trim() ?? "";
}

/** Nothing besides the prompt (no earlier message, document text, quote, file or parent) tells the
 * model what "the plan" or "last time" means. */
function promptStandsAlone(chatRequest) {
  const conversation = chatRequest.conversation ?? {};
  return (chatRequest.messages ?? []).filter((message) => message.content?.trim()).length === 1
    && !conversation.branchAnchor && !conversation.file && !(conversation.documents ?? []).length
    && !(conversation.ancestorContext ?? []).length;
}

/**
 * Why the latest prompt needs Agent mode, as a short clause ("it includes a web link to read"),
 * or null. Rules only: deliberately conservative, since an agent run costs several plain replies.
 */
export function agentNeedFromPrompt(chatRequest) {
  const prompt = latestPrompt(chatRequest);
  if (!prompt) return null;
  if (pastedWebAddresses({ messages: [{ role: "user", content: prompt }] }).length) return "it includes a web link to read";
  if (ASKS_ABOUT_VAULT.some((pattern) => pattern.test(prompt))) return "it asks about your saved documents and notes";
  if (prompt.length <= SHORT_PROMPT_CHARACTERS && promptStandsAlone(chatRequest)
      && (REFERS_TO_SOMETHING.test(prompt) || REFERS_BACK.test(prompt))) {
    return "it refers to something that isn't in this conversation";
  }
  return null;
}
