/**
 * Writes today's news topics for the free trial at /try. For each topic it reads
 * a few public news feeds, has a small Claude model write short original
 * summaries that link to their sources, checks the result, and publishes it to
 * the Blob store, where GET /api/trial/topics serves it to visitors.
 *
 * Run: bun scripts/trial-topics.mjs [--dry-run] [--out file.json]
 * Needs ANTHROPIC_API_KEY, and BLOB_READ_WRITE_TOKEN unless --dry-run.
 * A failed topic is left out; with fewer than MIN_TOPICS, yesterday's copy stays.
 */
import Anthropic from "@anthropic-ai/sdk";
import { writeFile } from "node:fs/promises";
import { normalizeTrialTopics } from "../client/src/lib/trialTopics.ts";
import { TRIAL_TOPICS_KEY } from "../server/trial/topics.mjs";

export const TOPICS = [
  { id: "food", name: "Food", feeds: ["https://www.theguardian.com/food/rss"] },
  { id: "sports", name: "Sports", feeds: ["https://feeds.bbci.co.uk/sport/rss.xml", "https://www.theguardian.com/uk/sport/rss"] },
  { id: "politics", name: "Politics", feeds: ["https://feeds.bbci.co.uk/news/politics/rss.xml", "https://www.theguardian.com/politics/rss"] },
  { id: "fashion", name: "Fashion", feeds: ["https://www.theguardian.com/fashion/rss"] },
  { id: "people", name: "People", feeds: ["https://www.theguardian.com/lifeandstyle/celebrity/rss", "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml"] },
  { id: "science", name: "Science", feeds: ["https://feeds.bbci.co.uk/news/science_and_environment/rss.xml", "https://www.theguardian.com/science/rss"] },
  { id: "technology", name: "Technology", feeds: ["https://feeds.bbci.co.uk/news/technology/rss.xml", "https://www.theguardian.com/uk/technology/rss"] },
];
const MODEL = "claude-haiku-5-5";
const MIN_TOPICS = 5;
const ITEMS_PER_TOPIC = 8;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
function decode(value) {
  // Descriptions often carry escaped HTML, so tags are dropped after entities are decoded.
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => code[0] === "#"
      ? String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1)))
      : ENTITIES[code.toLowerCase()] ?? whole)
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Title, link and description of each <item> in an RSS feed. */
export function parseFeed(xml, sourceName) {
  const tag = (item, name) => decode(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(item)?.[1] ?? "");
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(([item]) => ({
    title: tag(item, "title"), url: tag(item, "link"), description: tag(item, "description").slice(0, 400), source: sourceName,
  })).filter((item) => item.title && /^https:\/\//.test(item.url));
}

async function readFeeds(topic) {
  const lists = [];
  for (const feed of topic.feeds) {
    try {
      const response = await fetch(feed, { headers: { "User-Agent": "MarginChat-TrialTopics/1.0 (+https://www.marginchat.com)" }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const name = new URL(feed).hostname.includes("bbc") ? "BBC" : "The Guardian";
      lists.push(parseFeed(await response.text(), name));
    } catch (error) {
      console.warn(`${topic.name}: ${feed} failed (${error.message}).`);
    }
  }
  // Take the top stories from each feed in turn, so one outlet doesn't fill the list.
  const items = [];
  const seen = new Set();
  for (let index = 0; items.length < ITEMS_PER_TOPIC && lists.some((list) => index < list.length); index += 1) {
    for (const item of lists.map((list) => list[index]).filter(Boolean)) {
      if (items.length < ITEMS_PER_TOPIC && !seen.has(item.url)) { seen.add(item.url); items.push(item); }
    }
  }
  return items;
}

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["intro", "stories", "question"],
  properties: {
    intro: { type: "string" },
    stories: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["item", "title", "paragraphs", "note"],
      properties: {
        item: { type: "integer" },
        title: { type: "string" },
        paragraphs: { type: "array", items: { type: "string" } },
        note: { type: "object", additionalProperties: false, required: ["quote", "text"],
          properties: { quote: { type: "string" }, text: { type: "string" } } },
      },
    } },
    question: { type: "object", additionalProperties: false, required: ["story", "quote", "question", "answer"],
      properties: { story: { type: "integer" }, quote: { type: "string" }, question: { type: "string" }, answer: { type: "string" } } },
  },
};

const INSTRUCTIONS = `You write the example notes a new visitor sees when they try Margin Chat, a workspace for exploring ideas with linked documents and AI. You get today's headlines for one topic.

Pick the 3 or 4 headlines a curious general reader would most like to explore, and for each write:
- title: a short, plain title of your own (not the headline), at most 8 words, no brackets.
- paragraphs: 2 short paragraphs in your own words. Say only what the headline and description support, attribute claims to the outlet ("The Guardian reports…"), and add general background only when it is well established. Never copy more than a few words in a row from the source. Neutral tone, no opinions, no speculation about real people.
- note: a margin note a thoughtful reader might leave. quote is a phrase of 2 to 6 words copied exactly from one of your paragraphs; text is one sentence: a question it raises or a connection worth following.
- item: the number of the headline it came from.

Also write:
- intro: one sentence on what this topic covers today.
- question: one question a reader might ask Margin Chat's AI about one of the stories (story is its position in your list, from 0; quote is 2 to 6 words copied exactly from that story's paragraphs) and a helpful answer of 80 to 150 words in Markdown, giving background rather than new claims about the news itself.

Plain, friendly English. No emoji.`;

/** Long runs of the source's own words would make the summary a copy. */
export function copiesSource(paragraphs, item, run = 10) {
  const words = (value) => value.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const source = words(`${item.title} ${item.description}`);
  const runs = new Set();
  for (let index = 0; index + run <= source.length; index += 1) runs.add(source.slice(index, index + run).join(" "));
  const own = words(paragraphs.join(" "));
  for (let index = 0; index + run <= own.length; index += 1) if (runs.has(own.slice(index, index + run).join(" "))) return true;
  return false;
}

async function writeTopic(client, topic, items) {
  const headlines = items.map((item, index) => `${index}. ${item.title} (${item.source})\n   ${item.description}`).join("\n");
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: INSTRUCTIONS,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: `Topic: ${topic.name}\n\nToday's headlines:\n${headlines}` }],
  });
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") throw new Error(`stopped: ${response.stop_reason}`);
  const textBlock = response.content.find((block) => block.type === "text");
  const written = JSON.parse(textBlock?.text ?? "{}");
  const kept = [];
  for (const story of written.stories ?? []) {
    const item = items[story.item];
    if (!item || copiesSource(story.paragraphs ?? [], item)) continue;
    kept.push({ title: story.title, paragraphs: story.paragraphs, note: story.note, source: { name: item.source, url: item.url }, from: story });
  }
  const askedIndex = kept.findIndex((story) => story.from === written.stories?.[written.question?.story]);
  return {
    id: topic.id, name: topic.name, intro: written.intro,
    stories: kept.map(({ from: _from, ...story }) => story),
    ...(askedIndex >= 0 ? { question: { ...written.question, story: askedIndex } } : {}),
  };
}

async function publish(json) {
  const { put } = await import("@vercel/blob");
  const options = process.env.BLOB_STORE_ID ? { storeId: process.env.BLOB_STORE_ID } : { token: process.env.BLOB_READ_WRITE_TOKEN };
  await put(TRIAL_TOPICS_KEY, json, { ...options, access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
}

async function main(args) {
  const dryRun = args.includes("--dry-run");
  const outIndex = args.indexOf("--out");
  // GitHub passes a missing secret as an empty string, which the SDK reports only as an auth error per topic.
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is empty. Add it as a secret named exactly ANTHROPIC_API_KEY on the GitHub \"production\" environment (Settings → Environments → production), or as a repository secret.");
  if (!dryRun && !process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) throw new Error("BLOB_READ_WRITE_TOKEN is empty, so there is nowhere to publish. Use --dry-run to try without publishing.");
  const client = new Anthropic();
  const topics = [];
  for (const topic of TOPICS) {
    const items = await readFeeds(topic);
    if (items.length < 3) { console.warn(`${topic.name}: only ${items.length} headlines, skipped.`); continue; }
    try {
      topics.push(await writeTopic(client, topic, items));
    } catch (error) {
      console.warn(`${topic.name}: writing failed (${error.message}).`);
    }
  }
  const content = normalizeTrialTopics({ version: 1, generatedAt: new Date().toISOString(), topics });
  const count = content?.topics.length ?? 0;
  for (const topic of content?.topics ?? []) console.log(`${topic.name}: ${topic.stories.length} stories${topic.question ? ", 1 AI answer" : ""}`);
  const json = JSON.stringify(content, null, 2);
  if (outIndex >= 0 && args[outIndex + 1]) await writeFile(args[outIndex + 1], json);
  if (count < MIN_TOPICS) throw new Error(`Only ${count} topics were usable; keeping the copy already published.`);
  if (dryRun) { console.log("Dry run: nothing published."); return; }
  await publish(json);
  console.log(`Published ${count} topics to ${TRIAL_TOPICS_KEY}.`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exit(1); });
}
