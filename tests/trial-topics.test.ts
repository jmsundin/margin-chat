import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { createEmptyState } from "../client/src/initialState";
import { addExampleVault } from "../client/src/lib/exampleVault";
import { completedStarterTasks, seedStarterDocument } from "../client/src/lib/starterDocument";
import { getDocumentGraphEdges } from "../client/src/lib/documentRelations";
import { ensureSessions } from "../client/src/lib/workspaceSessions";
import { addTrialTopics, loadTrialTopics, normalizeTrialTopics, TRIAL_TOPICS_PATH } from "../client/src/lib/trialTopics";
import { createApiHandler } from "../server/routes/api.mjs";
import { createTrialTopicsService, TRIAL_TOPICS_KEY } from "../server/trial/topics.mjs";
import { copiesSource, parseFeed } from "../scripts/trial-topics.mjs";

const at = "2026-10-27T10:00:00.000Z";

function story(title: string, quote = "a quiet harvest") {
  return {
    title,
    paragraphs: [`The Guardian reports ${quote} in several regions this year.`, "Growers say the season was mild."],
    source: { name: "The Guardian", url: `https://www.theguardian.com/food/${title.toLowerCase().replace(/\W+/g, "-")}` },
    note: { quote, text: "What changed in the weather?" },
  };
}

const sample = () => ({
  version: 1,
  generatedAt: at,
  topics: [
    { id: "food", name: "Food", intro: "What people are cooking and growing.", stories: [story("Apple harvest"), story("Bread prices"), story("Street food")],
      question: { story: 0, quote: "a quiet harvest", question: "Why would a harvest be quiet?", answer: "Harvests vary with **weather**." } },
    { id: "science", name: "Science", intro: "New findings.", stories: [story("Comet visit", "a bright comet")] },
  ],
});

const trial = () => addExampleVault(ensureSessions(seedStarterDocument(createEmptyState(), at), [], at), at);

describe("normalizeTrialTopics", () => {
  test("keeps well-formed topics", () => {
    const content = normalizeTrialTopics(sample())!;
    expect(content.topics.map((topic) => topic.name)).toEqual(["Food", "Science"]);
    expect(content.topics[0].question?.story).toBe(0);
    expect(content.topics[0].stories[0].note?.quote).toBe("a quiet harvest");
  });

  test("drops unsafe links, link-breaking characters, invented quotes and duplicates", () => {
    const input = sample();
    input.topics[0].stories[0].title = "Apple [[harvest]] | #1";
    input.topics[0].stories[1].source.url = "javascript:alert(1)";
    input.topics[0].stories[2].note.quote = "words that are not there";
    input.topics[1].stories.push(story("Apple harvest 1"));
    input.topics.push({ ...input.topics[1] });
    const content = normalizeTrialTopics(input)!;
    const food = content.topics[0];
    expect(food.stories.map((item) => item.title)).toEqual(["Apple harvest 1", "Street food"]);
    expect(food.stories[1].note).toBeUndefined();
    expect(content.topics[1].stories.map((item) => item.title)).toEqual(["Comet visit"]);
    expect(content.topics).toHaveLength(2);
  });

  test("rejects anything that isn't version 1 with a date and topics", () => {
    expect(normalizeTrialTopics(null)).toBeNull();
    expect(normalizeTrialTopics({ version: 2, generatedAt: at, topics: [] })).toBeNull();
    expect(normalizeTrialTopics({ version: 1, generatedAt: "soon", topics: sample().topics })).toBeNull();
    expect(normalizeTrialTopics({ version: 1, generatedAt: at, topics: [{ id: "x", name: "X", stories: [] }] })).toBeNull();
  });
});

describe("addTrialTopics", () => {
  test("adds a Group and a Session per topic, with linked stories, notes and an AI answer", () => {
    const before = trial();
    const state = addTrialTopics(before, normalizeTrialTopics(sample())!);
    expect(state.conversations["topic-food"].title).toBe("Food");
    expect(state.groups["topic-group-food"].conversationIds.slice(0, 4)).toEqual(["topic-food", "topic-food-1", "topic-food-2", "topic-food-3"]);
    const session = state.sessions!.items["topic-session-food"];
    expect(session.documentIds[0]).toBe("topic-food");
    // Topic sessions wait in the Sessions panel instead of crowding the tab row.
    expect(state.sessions!.tabIds).toEqual(before.sessions!.tabIds);
    expect(state.conversations["topic-food-1-note"].document?.marginNote).toBeTruthy();
    expect(state.conversations["topic-food-1-answer"]).toBeDefined();
    for (const item of Object.values(state.conversations)) {
      const anchor = item.branchAnchor;
      if (!anchor || !item.id.startsWith("topic-")) continue;
      const block = state.conversations[anchor.sourceConversationId].document!.blocks.find((candidate) => candidate.id === anchor.sourceBlockId)!;
      expect(block.content.slice(anchor.startOffset, anchor.endOffset)).toBe(anchor.quote);
    }
    const edges = getDocumentGraphEdges(state.conversations).filter((edge) => edge.sourceId.startsWith("topic-food") || edge.targetId.startsWith("topic-food"));
    expect(edges.some((edge) => edge.kind === "mention")).toBe(true);
    expect(edges.some((edge) => edge.kind === "relation")).toBe(true);
    // "Start here" points at the topics, right after the example vault's line.
    const start = Object.values(state.conversations).find((item) => item.title === "Start here")!;
    const lines = start.document!.blocks.map((block) => block.id.replace(`${start.id}-block-`, ""));
    expect(lines.slice(1, 3)).toEqual(["example", "topics"]);
    expect(start.document!.blocks[2].content).toContain("[[Food]], [[Science]]");
  });

  test("adding twice changes nothing, and topics don't tick the visitor's own tasks", () => {
    const content = normalizeTrialTopics(sample())!;
    const once = addTrialTopics(trial(), content);
    expect(Object.keys(addTrialTopics(once, content).conversations)).toEqual(Object.keys(once.conversations));
    expect(completedStarterTasks(once).has("session")).toBe(false);
    expect(completedStarterTasks(once).has("document")).toBe(false);
  });
});

test("loadTrialTopics returns null when the topics are missing, slow or malformed", async () => {
  const respond = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  expect((await loadTrialTopics(respond(sample())))?.topics).toHaveLength(2);
  expect(await loadTrialTopics(respond({ error: "No trial topics yet." }, 404))).toBeNull();
  expect(await loadTrialTopics(respond({ version: 1 }))).toBeNull();
  const never = ((_: unknown, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
  expect(await loadTrialTopics(never, 10)).toBeNull();
});

describe("daily topics job", () => {
  test("reads RSS items with entities and CDATA, skipping non-https links", () => {
    const xml = `<rss><channel><item><title><![CDATA[Bees &amp; honey]]></title><link>https://example.org/a</link><description>&lt;p&gt;Hives grew&#39;s numbers&lt;/p&gt;</description></item>
      <item><title>Plain</title><link>http://example.org/b</link></item></channel></rss>`;
    expect(parseFeed(xml, "BBC")).toEqual([{ title: "Bees & honey", url: "https://example.org/a", description: "Hives grew's numbers", source: "BBC" }]);
  });

  test("flags summaries that copy long runs of the source", () => {
    const item = { title: "Council approves", description: "The city council voted on Tuesday to approve a new park along the river after years of debate" };
    expect(copiesSource(["Reports say the city council voted on Tuesday to approve a new park along the river."], item)).toBe(true);
    expect(copiesSource(["The BBC reports a riverside park was approved after a long debate."], item)).toBe(false);
  });
});

describe("GET /api/trial/topics", () => {
  let server: Server;
  let origin: string;
  let stored: Buffer | null = null;
  let reads = 0;
  beforeAll(async () => {
    const storage = { read: async (key: string) => { reads += 1; expect(key).toBe(TRIAL_TOPICS_KEY); return stored ? { bytes: stored, etag: "1" } : null; } };
    let clock = 0;
    const trialTopicsService = createTrialTopicsService({ storage, now: () => clock });
    server = createServer(createApiHandler({
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      authService: { getAuthContext: async () => ({ user: null }) },
      trialTopicsService: { read: async () => { clock += 11 * 60 * 1000; return trialTopicsService.read(); } },
    } as any));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  test("is 404 before the first run, then public and cacheable", async () => {
    expect((await fetch(`${origin}${TRIAL_TOPICS_PATH}`)).status).toBe(404);
    stored = Buffer.from(JSON.stringify(sample()));
    const response = await fetch(`${origin}${TRIAL_TOPICS_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("s-maxage=3600");
    expect((await response.json()).topics).toHaveLength(2);
    expect(reads).toBe(2);
  });
});

test("the service caches a read for ten minutes", async () => {
  let reads = 0;
  let clock = 0;
  const service = createTrialTopicsService({ storage: { read: async () => { reads += 1; return { bytes: Buffer.from("{\"version\":1}"), etag: "1" }; } }, now: () => clock });
  await service.read();
  clock = 9 * 60 * 1000;
  await service.read();
  expect(reads).toBe(1);
  clock = 11 * 60 * 1000;
  expect(await service.read()).toEqual({ version: 1 });
  expect(reads).toBe(2);
  expect(await createTrialTopicsService({ env: {} }).read()).toBeNull();
});
