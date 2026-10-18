import { pastedWebAddresses } from "./webTools.mjs";

/** Prompts this long usually carry their own material, so a bare "the plan" in them is not a lookup. */
const SHORT_PROMPT_CHARACTERS = 240;

const ASKS_ABOUT_VAULT = [
  /\b(?:my|our)\s+(?:own\s+)?(?:saved\s+)?(?:notes?|vault|docs?|documents?|files?|pdfs?|chats?|conversations?|journal|highlights?|bookmarks?|reading\s+list|workspace|second\s+brain)\b/iu,
  /\b(?:what|where|when)\s+(?:did|have|had)\s+(?:i|we)\s+(?:ever\s+)?(?:write|wrote|save|saved|note|noted|mention|mentioned|say|said|discuss|discussed|decide|decided|read)\b/iu,
  /\b(?:i|we)\s+(?:wrote|saved|noted\s+down|bookmarked|highlighted)\b/iu,
];

/** Asks for something only the web has now, or asks for a web look-up outright. */
const NEEDS_THE_WEB = [
  /\b(?:search|check|look)\s+(?:it\s+|this\s+|that\s+)?(?:up\s+)?(?:on\s+)?(?:the\s+)?(?:web|internet|online)\b/iu,
  /\b(?:google|look\s+up)\b/iu,
  /\b(?:latest|newest|most\s+recent|current|today'?s|this\s+week'?s|this\s+year'?s|up[-\s]to[-\s]date)\s+(?:news|version|versions|release|releases|price|prices|pricing|rates?|research|studies|study|developments?|updates?|guidelines?|recommendations?|figures?|numbers|statistics|stats|scores?|results?|weather|forecast|events?)\b/iu,
  /\b(?:news|headlines)\s+(?:about|on|from|today)\b/iu,
  /\bwhat(?:'s|\s+is)\s+(?:happening|new)\s+(?:with|in|at|on)\b/iu,
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
 * `web` says whether the agent could search the web; without it, questions about current events
 * stay plain replies, since an agent run couldn't answer them any better.
 */
export function agentNeedFromPrompt(chatRequest, { web = false } = {}) {
  const prompt = latestPrompt(chatRequest);
  if (!prompt) return null;
  if (pastedWebAddresses({ messages: [{ role: "user", content: prompt }] }).length) return "it includes a web link to read";
  if (ASKS_ABOUT_VAULT.some((pattern) => pattern.test(prompt))) return "it asks about your saved documents and notes";
  if (web && NEEDS_THE_WEB.some((pattern) => pattern.test(prompt))) return "it needs current information from the web";
  if (prompt.length <= SHORT_PROMPT_CHARACTERS && promptStandsAlone(chatRequest)
      && (REFERS_TO_SOMETHING.test(prompt) || REFERS_BACK.test(prompt))) {
    return "it refers to something that isn't in this conversation";
  }
  return null;
}
