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

export const PROPOSE_ROADMAP_DEFINITION = {
  name: "propose_roadmap",
  description: "Draft a learning roadmap for the user to approve: ordered stages of steps, with the steps each one needs first. A step points at one of the user's own documents that teaches it, or, when the vault has none, carries notes for a new document that approving creates under the roadmap. Search the vault before calling this and cite only documents your tools returned. Nothing is saved until the user approves it; approving adds the stages and steps to the roadmap document.",
  parameters: { type: "object", properties: {
    roadmap_id: documentRef("The roadmap document the stages are added to"),
    goal: { type: "string", description: "What the roadmap is for, in a few words, such as \"Understand the biology of aging\"." },
    stages: { type: "array", description: "Stages in learning order, from where to start to the most advanced.", items: { type: "object", properties: {
      title: { type: "string", description: "A short stage name." },
      steps: { type: "array", description: "The stage's steps, in a sensible order.", items: { type: "object", properties: {
        key: { type: "string", description: "A short ID for this step, unique in the roadmap, used in needs." },
        document_id: { type: "string", description: "The document that teaches this step: an ID from search_vault, read_document or list_related. An empty string when the vault has no document for it and notes is given." },
        title: { type: "string", description: "A short name for the step, or an empty string to use the document's title. Required for a step with notes: it names the new document." },
        // Strict tool schemas need every property in required, so "none" is null.
        notes: { type: ["string", "null"], description: "null for a step with a document_id. For a step the vault has no document for: the new document's starting text in Markdown, such as the subtopics to cover as a list. Keep it short; the user fills it in as they learn." },
        why: { type: "string", description: "One short line on what the step covers or why it is here." },
        needs: { type: "array", items: { type: "string" }, description: "Keys of steps that must come first. Only real prerequisites; never a loop." },
      }, required: ["key", "document_id", "title", "notes", "why", "needs"], additionalProperties: false } },
    }, required: ["title", "steps"], additionalProperties: false } },
    summary: { type: "string", description: "One short line on the roadmap, shown to the user beside it." },
  }, required: ["roadmap_id", "goal", "stages", "summary"], additionalProperties: false },
};

export const PROPOSAL_TOOL_DEFINITIONS = [PROPOSE_EDIT_DEFINITION, PROPOSE_DOCUMENT_DEFINITION, PROPOSE_ROADMAP_DEFINITION];
const NAMES = new Set(PROPOSAL_TOOL_DEFINITIONS.map((tool) => tool.name));

const MAX_PROPOSALS = 8;
const FIND_CHARACTERS = 4_000;
const REPLACE_CHARACTERS = 20_000;
const CONTENT_CHARACTERS = 40_000;
/** Text one run may propose across all its proposals, so a saved answer stays a reasonable size. */
const RUN_CHARACTERS = 80_000;
const ROADMAP_STAGES = 12;
const ROADMAP_STEPS = 60;
const ROADMAP_NOTES_CHARACTERS = 2_000;
const STEP_KEY = /^[A-Za-z0-9_.-]{1,60}$/u;
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

  function roadmap(args) {
    const roadmapId = resolve(args.roadmap_id);
    const goal = line(args.goal, 200);
    if (!allowed(roadmapId)) return { ok: false, error: "That roadmap document isn't one you can reach. Use an ID from your tools, or an empty string for the document in the user's message." };
    if (!goal) return { ok: false, error: "Say in a few words what the roadmap is for, in goal." };
    const inputStages = Array.isArray(args.stages) ? args.stages : [];
    if (!inputStages.length || inputStages.length > ROADMAP_STAGES) return { ok: false, error: `Give between 1 and ${ROADMAP_STAGES} stages.` };
    const keys = new Set();
    const stages = [];
    let replaced = 0;
    let size = goal.length;
    for (const input of inputStages) {
      const title = line(input?.title, 200);
      if (!title) return { ok: false, error: "Every stage needs a title." };
      const steps = [];
      for (const step of Array.isArray(input?.steps) ? input.steps : []) {
        const key = String(step?.key ?? "").trim();
        if (!STEP_KEY.test(key)) return { ok: false, error: `Step keys are short IDs of letters, digits, dots, dashes or underscores; "${line(key, 40)}" isn't one.` };
        if (keys.has(key)) return { ok: false, error: `The key "${key}" is used twice. Give every step its own key.` };
        keys.add(key);
        const cited = String(step?.document_id ?? "").trim();
        const stepTitle = line(step?.title, 200);
        // A step cites the user's own material only where the run could read it. Any other step with a
        // title becomes a new document under the roadmap on approval, carrying its notes: a roadmap built
        // from a page or from the model's own knowledge shouldn't be thrown out over one bad citation.
        const documentId = cited && allowed(cited) && cited !== roadmapId ? cited : "";
        const notes = documentId ? null : (typeof step?.notes === "string" ? step.notes.trim() : "").slice(0, ROADMAP_NOTES_CHARACTERS);
        if (!documentId && !stepTitle) return { ok: false, error: `Step "${key}" has no document you can reach and no title. Give it a title (and notes) to make a new document, or cite a document ID your tools returned.` };
        if (!documentId && cited) replaced += 1;
        const why = line(step?.why, 300);
        const needs = [...new Set((Array.isArray(step?.needs) ? step.needs : []).map((value) => String(value).trim()).filter(Boolean))];
        size += stepTitle.length + why.length + (notes?.length ?? 0) + 80;
        steps.push({ key, ...(notes !== null ? { notes } : { documentId }), ...(stepTitle ? { title: stepTitle } : {}), ...(why ? { why } : {}), needs });
      }
      if (!steps.length) return { ok: false, error: `The stage "${title}" has no steps. Give each stage at least one step, or leave it out.` };
      stages.push({ title, steps });
    }
    if (keys.size > ROADMAP_STEPS) return { ok: false, error: `Keep a roadmap to ${ROADMAP_STEPS} steps or fewer.` };
    const all = stages.flatMap((stage) => stage.steps);
    // A need that names no other step is dropped rather than failing the whole roadmap.
    for (const step of all) step.needs = step.needs.filter((key) => keys.has(key) && key !== step.key);
    // Prerequisites must not loop: peel off steps whose needs are all placed.
    const placed = new Set();
    for (let progress = true; progress;) {
      progress = false;
      for (const step of all) if (!placed.has(step.key) && step.needs.every((key) => placed.has(key))) { placed.add(step.key); progress = true; }
    }
    if (placed.size < all.length) {
      const stuck = all.filter((step) => !placed.has(step.key)).map((step) => step.key).slice(0, 6);
      return { ok: false, error: `These steps' needs loop back on each other: ${stuck.join(", ")}. A roadmap can't loop; remove one of the needs.` };
    }
    const added = add({ kind: "roadmap", roadmapId, roadmapTitle: line(titleOf(roadmapId), 300), goal, stages, summary: line(args.summary, 200) }, size);
    return added.ok && replaced ? { ...added, note: `${added.note} ${replaced} step${replaced === 1 ? "" : "s"} cited documents you can't reach, so each will be made as a new document instead. Don't call propose_roadmap again for that.` } : added;
  }

  return {
    has: (name) => NAMES.has(name),
    run: (name, args = {}) => name === PROPOSE_EDIT_DEFINITION.name ? edit(args) : name === PROPOSE_ROADMAP_DEFINITION.name ? roadmap(args) : create(args),
    list: () => proposals.map((proposal) => ({ ...proposal })),
  };
}

const quoted = (value) => `“${line(value, 80) || "Untitled"}”`;

/** A run-log line for a proposal; never includes the proposed text. */
export function describeProposalStep(name, args = {}, output = {}) {
  if (output?.ok === false) {
    const label = name === PROPOSE_EDIT_DEFINITION.name ? "Couldn't propose an edit" : name === PROPOSE_ROADMAP_DEFINITION.name ? "Couldn't propose the roadmap" : "Couldn't propose a new document";
    return { label, detail: line(output.error, 160) || null, ok: false };
  }
  if (name === PROPOSE_ROADMAP_DEFINITION.name) {
    const steps = (Array.isArray(args.stages) ? args.stages : []).reduce((sum, stage) => sum + (Array.isArray(stage?.steps) ? stage.steps.length : 0), 0);
    return { label: `Proposed a roadmap for ${quoted(args.goal)}`, detail: `${steps} step${steps === 1 ? "" : "s"} for you to approve`, ok: true };
  }
  return name === PROPOSE_EDIT_DEFINITION.name
    ? { label: "Proposed an edit for you to approve", detail: line(args.summary, 160) || null, ok: true }
    : { label: `Proposed a new document ${quoted(args.title)}`, detail: line(args.summary, 160) || null, ok: true };
}
