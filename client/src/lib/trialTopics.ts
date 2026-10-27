import type { AppState, ConversationGroup, WorkspaceSession } from "../types";
import { CONVERSATION_GROUP_COLORS } from "./conversationGroups";
import { addExampleChild, addStartHereLine, blocks } from "./exampleVault";
import { SESSION_COLORS } from "./workspaceSessions";

/**
 * Today's news topics for the free trial at /try. A daily job
 * (scripts/trial-topics.mjs) writes them; GET /api/trial/topics serves them; a
 * first visit turns them into one Group and one Session per topic, beside the
 * example vault. Everything here is untrusted input, so it is checked and
 * trimmed before it becomes documents.
 */
export const TRIAL_TOPICS_PATH = "/api/trial/topics";
export const TOPIC_ID_PREFIX = "topic-";

export interface TrialStory {
  title: string;
  paragraphs: string[];
  source: { name: string; url: string };
  /** A margin note on a phrase that appears word for word in the paragraphs. */
  note?: { quote: string; text: string };
}

export interface TrialTopic {
  id: string;
  name: string;
  intro: string;
  stories: TrialStory[];
  /** One question about a story, answered the way Ask AI answers. */
  question?: { story: number; quote: string; question: string; answer: string };
}

export interface TrialTopics { version: 1; generatedAt: string; topics: TrialTopic[] }

export const TRIAL_TOPIC_LIMITS = { topics: 8, stories: 5, paragraphs: 4, title: 120, paragraph: 900, note: 400, answer: 2400 } as const;

const text = (value: unknown, max: number) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
const markdown = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
// Titles become [[links]], so they can't hold the characters that end one.
const title = (value: unknown) => text(text(value, TRIAL_TOPIC_LIMITS.title).replace(/[[\]|#^]/g, ""), TRIAL_TOPIC_LIMITS.title);

function webUrl(value: unknown) {
  try {
    const url = new URL(text(value, 600));
    return url.protocol === "https:" ? url.href : "";
  } catch { return ""; }
}

/** Keeps only well-formed topics and stories; returns null when nothing usable is left. */
export function normalizeTrialTopics(input: unknown): TrialTopics | null {
  const raw = input as { version?: unknown; generatedAt?: unknown; topics?: unknown } | null;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.topics)) return null;
  const generatedAt = Number.isFinite(Date.parse(String(raw.generatedAt))) ? new Date(String(raw.generatedAt)).toISOString() : null;
  if (!generatedAt) return null;
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const topics: TrialTopic[] = [];
  for (const candidate of raw.topics.slice(0, TRIAL_TOPIC_LIMITS.topics) as Array<Record<string, unknown>>) {
    const id = text(candidate?.id, 40).toLowerCase();
    const name = text(candidate?.name, 40);
    if (!/^[a-z][a-z0-9-]*$/.test(id) || !name || seenIds.has(id)) continue;
    const stories: TrialStory[] = [];
    for (const story of (Array.isArray(candidate.stories) ? candidate.stories : []).slice(0, TRIAL_TOPIC_LIMITS.stories) as Array<Record<string, unknown>>) {
      const storyTitle = title(story?.title);
      const paragraphs = (Array.isArray(story?.paragraphs) ? story.paragraphs : [])
        .map((paragraph) => text(paragraph, TRIAL_TOPIC_LIMITS.paragraph)).filter(Boolean).slice(0, TRIAL_TOPIC_LIMITS.paragraphs);
      const source = story?.source as { name?: unknown; url?: unknown } | undefined;
      const url = webUrl(source?.url);
      if (!storyTitle || !paragraphs.length || !url || seenTitles.has(storyTitle.toLowerCase())) continue;
      seenTitles.add(storyTitle.toLowerCase());
      const note = story.note as { quote?: unknown; text?: unknown } | undefined;
      const quote = text(note?.quote, 200);
      const noteText = text(note?.text, TRIAL_TOPIC_LIMITS.note);
      stories.push({ title: storyTitle, paragraphs, source: { name: text(source?.name, 60) || new URL(url).hostname, url },
        ...(quote && noteText && paragraphs.some((paragraph) => paragraph.includes(quote)) ? { note: { quote, text: noteText } } : {}) });
    }
    if (!stories.length || seenTitles.has(name.toLowerCase())) continue;
    seenIds.add(id);
    seenTitles.add(name.toLowerCase());
    const question = candidate.question as { story?: unknown; quote?: unknown; question?: unknown; answer?: unknown } | undefined;
    const storyIndex = Number(question?.story);
    const asked = Number.isInteger(storyIndex) ? stories[storyIndex] : undefined;
    const quote = text(question?.quote, 200);
    const prompt = text(question?.question, 200);
    const answer = markdown(question?.answer, TRIAL_TOPIC_LIMITS.answer);
    topics.push({ id, name, intro: text(candidate.intro, TRIAL_TOPIC_LIMITS.paragraph), stories,
      ...(asked && quote && prompt && answer && asked.paragraphs.some((paragraph) => paragraph.includes(quote))
        ? { question: { story: storyIndex, quote, question: prompt, answer } } : {}) });
  }
  return topics.length ? { version: 1, generatedAt, topics } : null;
}

/** The latest topics, or null when there are none or they don't arrive within a few seconds. */
export async function loadTrialTopics(fetchImpl: typeof fetch = fetch, timeoutMs = 4_000): Promise<TrialTopics | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(TRIAL_TOPICS_PATH, { signal: controller.signal, credentials: "omit" });
    return response.ok ? normalizeTrialTopics(await response.json()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const storyId = (topic: TrialTopic, index: number) => `${TOPIC_ID_PREFIX}${topic.id}-${index + 1}`;
// A minute apart, so lists that sort by recency show the topics in the job's order.
const stamp = (content: TrialTopics, topicIndex: number) => new Date(Date.parse(content.generatedAt) - topicIndex * 60_000).toISOString();

/** One Group and one Session per topic: an overview document linking to a document per story. */
export function addTrialTopics(state: AppState, content: TrialTopics): AppState {
  const day = new Date(content.generatedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const conversations = { ...state.conversations };
  const groups: Record<string, ConversationGroup> = { ...state.groups };
  const sessions: Record<string, WorkspaceSession> = {};
  content.topics.forEach((topic, topicIndex) => {
    const at = stamp(content, topicIndex);
    const rootId = `${TOPIC_ID_PREFIX}${topic.id}`;
    if (conversations[rootId]) return;
    const ids = topic.stories.map((_, index) => storyId(topic, index));
    const base = { kind: "note" as const, parentId: null, childIds: [], branchAnchor: null, messages: [], notes: [],
      serviceId: state.defaultServiceId, modelId: state.defaultModelId, createdAt: at, updatedAt: at };
    conversations[rootId] = { ...base, id: rootId, title: topic.name, nodeType: "topic",
      document: { schemaVersion: 1, prompts: [], generations: [], blocks: blocks(rootId, [
        ...(topic.intro ? [topic.intro] : []),
        `## In the news, ${day}\n\n${topic.stories.map((story) => `- [[${story.title}]]`).join("\n")}`,
        "Each story is a short summary written by AI from the day's headlines, with a link to the original article.",
      ], at) } };
    topic.stories.forEach((story, index) => {
      const id = ids[index];
      conversations[id] = { ...base, id, title: story.title,
        relations: [{ type: "part-of", targetConversationId: rootId, origin: "ai", createdAt: at }],
        linkedConversationIds: ids.filter((other) => other !== id).slice(0, 2),
        document: { schemaVersion: 1, prompts: [], generations: [], blocks: blocks(id, [
          ...story.paragraphs, `Source: [${story.source.name}](${story.source.url})`], at, "ai") } };
    });
    groups[`${TOPIC_ID_PREFIX}group-${topic.id}`] = { id: `${TOPIC_ID_PREFIX}group-${topic.id}`, name: topic.name,
      color: CONVERSATION_GROUP_COLORS[(topicIndex + 3) % CONVERSATION_GROUP_COLORS.length], collapsed: true, conversationIds: [rootId, ...ids] };
    sessions[`${TOPIC_ID_PREFIX}session-${topic.id}`] = { id: `${TOPIC_ID_PREFIX}session-${topic.id}`, name: topic.name, nameSource: "user",
      color: SESSION_COLORS[(topicIndex + 2) % SESSION_COLORS.length], documentIds: [rootId, ...ids], activeDocumentId: rootId,
      createdAt: at, lastOpenedAt: at };
  });
  let next: AppState = { ...state, conversations, groups };
  content.topics.forEach((topic, topicIndex) => {
    const at = stamp(content, topicIndex);
    topic.stories.forEach((story, index) => {
      const id = storyId(topic, index);
      if (!story.note || state.conversations[id]) return;
      const block = next.conversations[id].document!.blocks.findIndex((item) => item.content.includes(story.note!.quote));
      next = addExampleChild(next, { kind: "note", id: `${id}-note`, parentId: id, block, quote: story.note.quote, text: story.note.text }, at);
    });
    const question = topic.question;
    const parentId = question ? storyId(topic, question.story) : null;
    if (!question || !parentId || state.conversations[parentId]) return;
    const block = next.conversations[parentId].document!.blocks.findIndex((item) => item.content.includes(question.quote));
    next = addExampleChild(next, { kind: "ai", id: `${parentId}-answer`, parentId, block, quote: question.quote,
      question: question.question, answer: question.answer }, at);
  });
  // Topic sessions wait in the Sessions panel; only the first two sessions keep their tabs.
  if (next.sessions && Object.keys(sessions).length) next = { ...next, sessions: { ...next.sessions, items: { ...next.sessions.items, ...sessions } } };
  const added = content.topics.filter((topic) => !state.conversations[`${TOPIC_ID_PREFIX}${topic.id}`]);
  if (added.length) next = addStartHereLine(next, "topics", `Today's news is here too, as short stories with their sources: ${
    added.map((topic) => `[[${topic.name}]]`).join(", ")}. Each topic is a Group and a Session.`, content.generatedAt);
  return next;
}
