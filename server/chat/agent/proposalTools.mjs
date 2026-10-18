/**
 * Agent tools that draft changes for the user to approve: an edit to a document's text, or a new
 * document under a parent. The run only records them; the browser shows each one under the answer
 * and applies it when the user approves.
 */
const documentRef = (what) => ({ type: "string", description: `${what}: an ID from search_vault, read_document, list_related or get_conversation, or an empty string for the document in the user's message.` });

export const PROPOSE_EDIT_DEFINITION = {
  name: "propose_edit",
  description: "Draft a change to one of the user's documents for them to approve. It replaces find, copied exactly from the document's current text, with replace; an empty find adds replace at the end of the document. Nothing changes until the user approves it. To link a document to another, add a [[Document title]] link to its text.",
  parameters: { type: "object", properties: {
    document_id: documentRef("The document to change"),
    find: { type: "string", description: "The exact text to replace, as it appears in the document (not JSON-escaped), long enough to appear only once and no longer than needed. Empty to add at the end." },
    replace: { type: "string", description: "The new text, in Markdown. Empty to delete find." },
    summary: { type: "string", description: "One short line on what the change does, shown to the user beside it." },
  }, required: ["document_id", "find", "replace", "summary"], additionalProperties: false },
};

export const PROPOSE_DOCUMENT_DEFINITION = {
  name: "propose_document",
  description: "Draft a new document for the user to approve, saved as a child of a parent document. Nothing is created until the user approves it. Don't repeat the title as a heading in content.",
  parameters: { type: "object", properties: {
    title: { type: "string", description: "A short title." },
    content: { type: "string", description: "The document's text, in Markdown." },
    parent_id: documentRef("The parent document"),
    summary: { type: "string", description: "One short line on what the document is for, shown to the user beside it." },
  }, required: ["title", "content", "parent_id", "summary"], additionalProperties: false },
};

export const PROPOSAL_TOOL_DEFINITIONS = [PROPOSE_EDIT_DEFINITION, PROPOSE_DOCUMENT_DEFINITION];
const NAMES = new Set(PROPOSAL_TOOL_DEFINITIONS.map((tool) => tool.name));

const MAX_PROPOSALS = 8;
const FIND_CHARACTERS = 4_000;
const REPLACE_CHARACTERS = 20_000;
const CONTENT_CHARACTERS = 40_000;
/** Text one run may propose across all its proposals, so a saved answer stays a reasonable size. */
const RUN_CHARACTERS = 80_000;
const NOTE = "Shown to the user under your answer for approval; nothing has changed yet.";

const line = (value, maximum) => {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
};

/** The document a Margin Chat document prompt carries (title and full text), or null for other prompts.
 * Its JSON is one line between blank lines, so it is found without parsing the rest of the prompt. */
export function documentInPrompt(chatRequest) {
  const prompt = [...(chatRequest.messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? "";
  for (const part of prompt.split("\n\n")) {
    if (!part.startsWith("{\"title\":")) continue;
    try {
      const value = JSON.parse(part);
      if (typeof value?.document === "string") return { title: typeof value.title === "string" ? value.title : "", text: value.document };
    } catch { /* Not the document. */ }
  }
  return null;
}

function occurrences(text, find) {
  let count = 0;
  for (let index = text.indexOf(find); index >= 0 && count < 2; index = text.indexOf(find, index + 1)) count += 1;
  return count;
}

/**
 * The proposal tools for one run, when the caller can show proposals. `chatRequest.sourceDocumentId`
 * is the document the user asked from (in a side document, its parent); an empty ID means it.
 * `reachable(id)` says whether the agent may read a document, and so propose changes to it.
 */
export function createProposalTools({ chatRequest, snapshots, reachable = () => false }) {
  const currentId = chatRequest.sourceDocumentId ?? chatRequest.conversation.id;
  const prompted = documentInPrompt(chatRequest);
  const proposals = [];
  let characters = 0;
  const resolve = (value) => String(value ?? "").trim() || currentId;
  const allowed = (id) => id === currentId || snapshots.has(id) || reachable(id);
  const titleOf = (id) => id === currentId && prompted ? prompted.title : snapshots.get(id)?.title ?? "";

  function add(proposal, size) {
    if (proposals.length >= MAX_PROPOSALS) return { ok: false, error: `This run has already proposed ${MAX_PROPOSALS} changes. Answer now and say the rest can follow once these are reviewed.` };
    if (characters + size > RUN_CHARACTERS) return { ok: false, error: "This run has proposed as much text as one answer can carry. Answer now with what you have proposed." };
    characters += size;
    proposals.push({ id: `proposal-${proposals.length + 1}`, ...proposal });
    return { ok: true, proposal_id: proposals.at(-1).id, note: NOTE };
  }

  function edit(args) {
    const documentId = resolve(args.document_id);
    const find = typeof args.find === "string" ? args.find : "";
    const replace = typeof args.replace === "string" ? args.replace : "";
    const summary = line(args.summary, 200);
    if (!allowed(documentId)) return { ok: false, error: "That document isn't one you can reach. Use an ID from your tools, or an empty string for the document in the user's message." };
    if (!find && !replace.trim()) return { ok: false, error: "The edit is empty. Give the text to replace, the new text, or both." };
    if (find === replace) return { ok: false, error: "find and replace are the same, so nothing would change." };
    if (find.length > FIND_CHARACTERS || replace.length > REPLACE_CHARACTERS) return { ok: false, error: `Keep find under ${FIND_CHARACTERS} characters and replace under ${REPLACE_CHARACTERS}; split a bigger change into several edits.` };
    // The document in the prompt is its full current text, so the edit is checked against it now.
    if (find && documentId === currentId && prompted) {
      const found = occurrences(prompted.text, find);
      if (!found) return { ok: false, error: "That text isn't in the document. Copy find exactly from the document's text, without JSON escapes." };
      if (found > 1) return { ok: false, error: "That text appears more than once in the document. Include more of the text around it so it appears only once." };
    }
    return add({ kind: "edit", documentId, documentTitle: line(titleOf(documentId), 300), find, replace, summary }, find.length + replace.length);
  }

  function create(args) {
    const parentId = resolve(args.parent_id);
    const title = line(args.title, 200);
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!allowed(parentId)) return { ok: false, error: "That parent document isn't one you can reach. Use an ID from your tools, or an empty string for the document in the user's message." };
    if (!title) return { ok: false, error: "Give the new document a title." };
    if (content.length > CONTENT_CHARACTERS) return { ok: false, error: `Keep a new document under ${CONTENT_CHARACTERS} characters, or propose several.` };
    return add({ kind: "create", parentId, parentTitle: line(titleOf(parentId), 300), title, content, summary: line(args.summary, 200) }, content.length);
  }

  return {
    has: (name) => NAMES.has(name),
    run: (name, args = {}) => name === PROPOSE_EDIT_DEFINITION.name ? edit(args) : create(args),
    list: () => proposals.map((proposal) => ({ ...proposal })),
  };
}

const quoted = (value) => `“${line(value, 80) || "Untitled"}”`;

/** A run-log line for a proposal; never includes the proposed text. */
export function describeProposalStep(name, args = {}, output = {}) {
  if (output?.ok === false) return { label: name === PROPOSE_EDIT_DEFINITION.name ? "Couldn't propose an edit" : "Couldn't propose a new document", detail: line(output.error, 160) || null, ok: false };
  return name === PROPOSE_EDIT_DEFINITION.name
    ? { label: "Proposed an edit for you to approve", detail: line(args.summary, 160) || null, ok: true }
    : { label: `Proposed a new document ${quoted(args.title)}`, detail: line(args.summary, 160) || null, ok: true };
}
