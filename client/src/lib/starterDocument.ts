import { createMarginDocument, marginNoteToSideDocument, type DocumentBlock } from "@margin-chat/workspace-contracts";
import type { AppState, Conversation, ConversationNote } from "../types";
import { DEFAULT_MAIN_CHAT_TITLE } from "../initialState";
import { addChildConversation } from "./workspaceCommands";
import { minimizeDocument } from "./documentWorkspace";

/**
 * The "Start here" document a new, empty vault opens with. It teaches by doing
 * (a short list of tasks that tick themselves off) and shows what a document
 * can hold, in roughly the order people reach for each thing.
 */
export const STARTER_TITLE = "Start here";
export const STARTER_NOTE_ID = "starter-margin-note";
export const STARTER_SIDE_DOCUMENT_ID = "starter-side-document";
const ID_PREFIX = "starter-";
/** Images ship with the website, so the document reads the same on every device and in other apps. */
const ASSET_ORIGIN = "https://www.marginchat.com";

export type StarterTask = "note" | "side" | "ai" | "map" | "session";

export const STARTER_TASKS: { id: StarterTask; line: string }[] = [
  { id: "note", line: "Select a sentence below and choose **Note**: a comment that stays beside the text." },
  { id: "side", line: "Select a phrase and choose **Side doc**: a new idea that grows out of it, in its own pane." },
  { id: "ai", line: "Select some text and choose **✦ Ask AI**, or press Space on an empty line to ask about the page." },
  { id: "map", line: "Open **Map View** (⌘G) to see how your documents connect." },
  { id: "session", line: "Start a **new session** from the session name at the top: one set of open documents per project." },
];
const CONNECT_LINE = "Connect Claude, ChatGPT or Gemini to your vault: [marginchat.com/connect](https://www.marginchat.com/connect)";

const PASSAGE = "Cells repair damaged DNA thousands of times a day. When repair falls behind, damage builds up, and that buildup is one of the hallmarks of aging. Which repair pathways fail first is still an open question.";
const NOTE_QUOTE = "Cells repair damaged DNA thousands of times a day.";
const SIDE_QUOTE = "hallmarks of aging";

export function starterTaskBlock(done: ReadonlySet<StarterTask> = new Set()) {
  return ["## Try it", "",
    ...STARTER_TASKS.map((task) => `- [${done.has(task.id) ? "x" : " "}] ${task.line}`),
    `- [ ] ${CONNECT_LINE}`].join("\n");
}

const sections = [
  "Margin Chat is for working through hard questions with documents and AI. This page is an ordinary document: edit it, keep it as a reference, or delete it when you're done.",
  starterTaskBlock(),
  `## A passage to work with\n\n${PASSAGE}`,
  "The first sentence already has a margin note beside it, and “hallmarks of aging” has a side document. Click either highlight to open it.",
  "## What a document can hold\n\nEverything below is plain Markdown, so the same files open in Obsidian or any text editor. Click into a block to see how it's written.",
  "### Text\n\n**Bold**, *italic*, ==highlighted==, ~~struck out~~ and `inline code`. Links open with ⌘-click: [a web page](https://en.wikipedia.org/wiki/DNA_repair), or another document in your vault: [[Hallmarks of aging]].",
  "### Lists\n\n- Bullet points, with Tab to indent\n  - like this\n1. Numbered steps\n2. that renumber themselves\n- [ ] And tasks you can tick",
  `### Images\n\nDrop an image onto the page, paste one, or link to it.\n\n![How a cell answers DNA damage](${ASSET_ORIGIN}/starter/dna-repair.svg)`,
  "### Tables\n\n| Repair pathway | Fixes | Speed |\n| --- | --- | --- |\n| Base excision | Single damaged bases | Minutes |\n| Mismatch repair | Copying errors | Minutes |\n| Homologous recombination | Double-strand breaks | Hours |",
  "### Code\n\n```python\nimport math\n\n# Gompertz law: the risk of dying doubles every few years after 30.\ndef mortality(age, a=0.0001, b=0.085):\n    return a * math.exp(b * age)\n\nprint(f\"Doubling time: {math.log(2) / 0.085:.1f} years\")\n```",
  "### Quotes\n\n> Nothing in biology makes sense except in the light of evolution.\n> — Theodosius Dobzhansky",
  "### Math\n\nWrite LaTeX between dollar signs, inline like $h(t) = a e^{bt}$, or as its own line:\n\n$$\nT_{2} = \\frac{\\ln 2}{b}\n$$",
  "### Diagrams\n\nMermaid code turns into a diagram. Click it to edit the boxes and arrows.\n\n```mermaid\nflowchart LR\n  A[DNA damage] --> B{Can it be repaired?}\n  B -- yes --> C[Repair]\n  B -- no --> D[Cell stops dividing]\n  D --> E[Damage builds up with age]\n```",
  "### Video\n\nPaste a YouTube or Vimeo link on its own line. Times listed under it jump the video there.\n\n![But what is a neural network?](https://www.youtube.com/watch?v=aircAruvnKk)\n- 0:00 Start\n- 3:00 Neurons and layers",
  "### Files\n\nDrag PDFs, images and other files into the sidebar. A PDF opens as a document you can highlight and take notes on, and AI can read it.",
  "## Bring in what you already have\n\nHave chats in ChatGPT? Choose **Bring your chat history** from the ⋯ menu at the top of the sidebar. Want to see this again? **Take the tour** is in the same menu.",
  "## Turning on AI\n\nEverything above works without AI. For ✦ Ask AI and Agent mode, paste your own key from OpenAI, Anthropic, Google or another provider under **Settings → AI & privacy** (they bill you directly), or add credit or the Plus plan under **Settings → Billing**.",
];

function block(id: string, index: number, content: string, at: string): DocumentBlock {
  return { id: `${id}-block-${index + 1}`, kind: "markdown", content, createdAt: at, updatedAt: at, authorship: "user" };
}

/** True for the untouched workspace a brand-new account starts with. */
export function isPristineWorkspace(state: AppState): boolean {
  const conversations = Object.values(state.conversations);
  if (conversations.length !== 1) return false;
  const [only] = conversations;
  return only.parentId === null && only.title === DEFAULT_MAIN_CHAT_TITLE && !only.messages.length && !only.notes?.length
    && !only.documents?.length && !only.childIds.length && !only.document?.blocks.some((item) => item.content.trim());
}

/** Turns the pristine workspace into "Start here" with its margin note and side document. */
export function seedStarterDocument(state: AppState, at = new Date().toISOString()): AppState {
  if (!isPristineWorkspace(state)) return state;
  const root = Object.values(state.conversations)[0];
  const blocks = sections.map((content, index) => block(root.id, index, content, at));
  const passage = blocks[2];
  const passageStart = passage.content.indexOf(PASSAGE);
  const starter: Conversation = {
    ...root, title: STARTER_TITLE, updatedAt: at,
    document: { schemaVersion: 1, blocks, prompts: [], generations: [] },
  };
  const anchored = (id: string, quote: string, content: string): ConversationNote => {
    const startOffset = passageStart + PASSAGE.indexOf(quote);
    return { id, kind: "comment", content, sourceMessageId: `document:${passage.id}`, sourceBlockId: passage.id,
      startOffset, endOffset: startOffset + quote.length, quote, createdAt: at, updatedAt: at };
  };
  const note = createMarginDocument(starter, anchored(STARTER_NOTE_ID,
    NOTE_QUOTE, "Is this true for neurons too? They hardly divide, so damage can't be diluted."));
  const side = marginNoteToSideDocument({
    ...createMarginDocument(starter, anchored(STARTER_SIDE_DOCUMENT_ID, SIDE_QUOTE,
      "Researchers list about a dozen hallmarks of aging, from DNA damage to worn-out stem cells.\n\nA side document is a full document of its own. Give it a title, keep writing, and add side documents to it too.")),
    title: "Hallmarks of aging",
  }, at);
  let next: AppState = { ...state, conversations: { ...state.conversations, [root.id]: starter } };
  next = addChildConversation(next, note);
  next = addChildConversation(next, side);
  // The side document starts as a node beside the passage, so "Start here" keeps the full width.
  next = minimizeDocument(next, side.id);
  // The first session was named after "New chat"; it follows the new title.
  const items = next.sessions?.items;
  if (next.sessions && items) next = { ...next, sessions: { ...next.sessions, items: Object.fromEntries(Object.entries(items).map(([id, session]) =>
    [id, session.nameSource === "auto" && session.name === DEFAULT_MAIN_CHAT_TITLE ? { ...session, name: STARTER_TITLE } : session])) } };
  return { ...next, activeConversationId: root.id };
}

/** Which starter tasks the workspace shows were done by the person, not by the starter itself. */
export function completedStarterTasks(state: AppState, seen: { map?: boolean } = {}): Set<StarterTask> {
  const done = new Set<StarterTask>();
  for (const conversation of Object.values(state.conversations)) {
    if (conversation.id.startsWith(ID_PREFIX)) continue;
    if (conversation.parentId && conversation.document?.marginNote?.display === "compact") done.add("note");
    else if (conversation.parentId && conversation.branchAnchor && !conversation.document?.marginNote) done.add("side");
    if (conversation.document?.generations.length || conversation.messages.some((message) => message.role === "assistant")) done.add("ai");
  }
  if (seen.map) done.add("map");
  if (Object.keys(state.sessions?.items ?? {}).length > 1) done.add("session");
  return done;
}

/** Ticks finished tasks in the "Try it" list. Lines the person changed are left alone. */
export function tickStarterTasks(state: AppState, done: ReadonlySet<StarterTask>): AppState {
  if (!done.size) return state;
  const root = Object.values(state.conversations).find((conversation) => conversation.title === STARTER_TITLE
    && conversation.parentId === null && conversation.childIds.includes(STARTER_NOTE_ID));
  const blocks = root?.document?.blocks;
  if (!root || !blocks) return state;
  let changed = false;
  const nextBlocks = blocks.map((item) => {
    let content = item.content;
    for (const task of STARTER_TASKS) {
      if (!done.has(task.id)) continue;
      const open = `- [ ] ${task.line}`;
      if (content.includes(open)) content = content.replace(open, `- [x] ${task.line}`);
    }
    if (content === item.content) return item;
    changed = true;
    return { ...item, content };
  });
  if (!changed) return state;
  return { ...state, conversations: { ...state.conversations, [root.id]: { ...root, document: { ...root.document!, blocks: nextBlocks } } } };
}
