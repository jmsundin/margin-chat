import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { expandWikipediaTopic, rankWikipediaLinks, searchWikipediaTopics, wikipediaRelationLabel } from "../client/src/lib/wikipedia";
import type { PublicTopic } from "../client/src/lib/publicKnowledge";
import { matchesPublicRelationFilter } from "../client/src/lib/publicRelationFilters";
import { groupRelations } from "../client/src/lib/publicRelationGroups";
import { isPrivateAnswer } from "../client/src/lib/publicMapApi";
import { createPublicMapService, createWikipediaResolver } from "../server/publicMap/index.mjs";
import { createWebSearchService, normalizeTavilyResults } from "../server/webSearch/index.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { createEmptyState } from "../client/src/initialState";
import { connectPublicTopics, findSavedPublicTopic, savePublicTopic, wikipediaConnectionKind } from "../client/src/lib/publicTopicWorkspace";
import { stateToVaultFiles, vaultToState } from "../client/src/lib/vaultWorkspace";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const ECOLOGY = `{{Short description|Study of organisms and their environment}}
{{Infobox science|field=[[Template junk]]}}
'''Ecology''' (from {{lang|grc|οἶκος}}, [[Ancient Greek]]) is the [[Natural science|natural science]] of the relationships among [[Organism|living organisms]], including [[Human]]s, and their [[Biophysical environment|physical environment]].<ref>[[Some Citation]]</ref> Ecology considers organisms at the individual, [[Population]], [[Community (ecology)|community]], [[Ecosystem]] levels.

[[File:Blue Linckia Starfish.JPG|thumb|A starfish in a [[Coral reef]]]]

== Levels of organization ==
{{Main|Ecological hierarchy}}
The [[Ecosystem]] is the main unit. See [[ecosystem]] and [[Biome]]s.
<!-- [[Hidden link]] -->

=== Population ecology ===
{{Further|Population ecology|Population dynamics}}
[[Population]] growth, as in [[1859]] and [[19th century]].

== History ==
Ecology was named by [[Ernst Haeckel]] in [[1866]]. [[Charles Darwin]] influenced it.

== See also ==
* [[Biology]]
* [[Environmentalism]]

== References ==
* [[Reference Book]]

[[Category:Ecology]]
`;

describe("Wikipedia connections", () => {
  test("ranks an article's links into broader topics, the lead's key topics and sections", () => {
    const ranked = rankWikipediaLinks("Ecology", ECOLOGY, ["Biology", "Branches of biology"]);
    const byTitle = Object.fromEntries(ranked.map((item) => [item.title, item]));
    expect(ranked[0]).toMatchObject({ title: "Natural science", kind: "broader" });
    expect(byTitle.Biology.kind).toBe("broader");
    expect(byTitle["Branches of biology"].kind).toBe("broader");
    expect(byTitle.Organism).toMatchObject({ kind: "lead", section: null });
    expect(byTitle["Ecological hierarchy"]).toMatchObject({ kind: "main", section: "Levels of organization" });
    expect(byTitle["Population dynamics"]).toMatchObject({ kind: "main", section: "Levels of organization" });
    expect(byTitle["Ernst Haeckel"]).toMatchObject({ kind: "section", section: "History" });
    expect(byTitle.Environmentalism).toMatchObject({ kind: "see-also", section: "See also" });
    // Repeated mentions add weight: Ecosystem appears in the lead and twice later.
    expect(byTitle.Ecosystem.score).toBeGreaterThan(byTitle.Human.score);
    for (const missing of ["Ecology", "Some Citation", "Template junk", "Hidden link", "Reference Book", "Blue Linckia Starfish.JPG", "1866", "1859", "19th century"]) {
      expect(byTitle[missing]).toBeUndefined();
    }
    expect(ranked.findIndex((item) => item.kind !== "broader")).toBe(3);
    expect(wikipediaRelationLabel(byTitle["Ernst Haeckel"])).toBe("History");
    expect(wikipediaRelationLabel(byTitle.Biology)).toBe("broader topic");
  });

  test("expands a topic from its article, resolving each link to its Wikidata identity", async () => {
    const calls: URL[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url);
      // Wikidata only backs up edges; when it is rate limited the article's links still load.
      if (url.hostname === "www.wikidata.org") return new Response("", { status: 429 });
      expect(url.origin + url.pathname).toBe("https://en.wikipedia.org/w/api.php");
      expect(url.searchParams.get("origin")).toBe("*");
      expect(init?.credentials).toBe("omit");
      if (url.searchParams.get("action") === "parse") {
        expect(url.searchParams.get("page")).toBe("Ecology");
        return Response.json({ parse: { title: "Ecology", wikitext: ECOLOGY, properties: { wikibase_item: "Q7150", "wikibase-shortdesc": "Study of organisms and their environment" },
          categories: [{ category: "Ecology" }, { category: "Biology" }, { category: "Articles_with_short_description", hidden: true }] } });
      }
      const titles = url.searchParams.get("titles")!.split("|");
      expect(titles.length).toBeLessThanOrEqual(12);
      expect(titles).not.toContain("Articles with short description");
      return Response.json({ query: {
        redirects: [{ from: "Human", to: "Human being" }],
        pages: titles.map((title, index) => title === "Human"
          ? { title: "Human being", pageprops: { wikibase_item: "Q5" }, description: "Species of hominid" }
          : title === "Population" ? { title, pageprops: { wikibase_item: "Q2", disambiguation: "" } }
          : title === "Biophysical environment" ? { title, missing: true }
          : { title, pageprops: { wikibase_item: `Q${1000 + index}` }, description: `About ${title}` }),
      } });
    }) as typeof fetch;
    const ecology: PublicTopic = { id: "Q7150", aliases: [], label: "Ecology", description: "", wikidataUrl: "https://www.wikidata.org/wiki/Q7150",
      wikipediaUrl: "https://en.wikipedia.org/wiki/Ecology", retrievedAt: "2026-10-09T00:00:00.000Z" };
    const result = await expandWikipediaTopic(ecology, 0);
    expect(result.topic.description).toBe("Study of organisms and their environment");
    expect(result.relations[0]).toMatchObject({ sourceId: "Q7150", propertyId: "wikipedia-broader", label: "broader topic" });
    expect(result.topics.find((topic) => topic.label === "Human being")).toMatchObject({ id: "Q5", wikipediaUrl: "https://en.wikipedia.org/wiki/Human_being" });
    expect(result.topics.some((topic) => topic.label === "Population" || topic.label === "Biophysical environment")).toBe(false);
    expect(result.relations.every((relation) => relation.sourceUrl.startsWith("https://en.wikipedia.org/wiki/Ecology"))).toBe(true);
    expect(result.relations.some((relation) => relation.wikidata)).toBe(false);
    expect(calls.some((url) => url.hostname === "www.wikidata.org")).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.nextOffset).toBe(12);
    const second = await expandWikipediaTopic(ecology, result.nextOffset);
    expect(calls.filter((url) => url.searchParams.get("action") === "parse")).toHaveLength(1);
    expect(second.relations.some((relation) => relation.label === "History")).toBe(true);
    // Broader topics count as types and categories; section links as parts.
    expect(matchesPublicRelationFilter({ propertyId: "wikipedia-broader" }, { relation: "types", includeMetadata: false })).toBe(true);
    expect(matchesPublicRelationFilter({ propertyId: "wikipedia-section" }, { relation: "parts", includeMetadata: false })).toBe(true);
    const groups = groupRelations("Q7150", [...result.relations, ...second.relations]).map((group) => group.label);
    expect(groups[0]).toBe("Broader topics");
    expect(groups[1]).toBe("Key topics");
    expect(groups).toContain("History");
  });

  test("searches titles first, then article text, skipping disambiguation pages", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("generator") === "prefixsearch") return Response.json({ query: { pages: [
        { index: 2, title: "Ecology (disambiguation)", pageprops: { wikibase_item: "Q9", disambiguation: "" } },
        { index: 1, title: "Ecology", pageprops: { wikibase_item: "Q7150" }, description: "Study of organisms" },
      ] } });
      return Response.json({ query: { pages: [
        { index: 1, title: "Ecology", pageprops: { wikibase_item: "Q7150" } },
        { index: 2, title: "Ecosystem", pageprops: { wikibase_item: "Q37813" } },
        { index: 3, title: "No identity" },
      ] } });
    }) as typeof fetch;
    expect((await searchWikipediaTopics("ecolog")).map((topic) => topic.label)).toEqual(["Ecology", "Ecosystem"]);
  });
});

describe("server Wikipedia resolver", () => {
  test("prefers the exact article, then the best search match", async () => {
    const seen: string[] = [];
    const resolve = createWikipediaResolver({ fetchImpl: (async (url: URL) => {
      seen.push(url.searchParams.get("titles") ?? `search:${url.searchParams.get("gsrsearch")}`);
      if (url.searchParams.get("titles") === "Charles Darwin") return Response.json({ query: { pages: [{ title: "Charles Darwin", pageprops: { wikibase_item: "Q1035" }, description: "English naturalist" }] } });
      if (url.searchParams.get("titles")) return Response.json({ query: { pages: [{ title: url.searchParams.get("titles"), missing: true }] } });
      return Response.json({ query: { pages: [{ index: 1, title: "Natural selection", pageprops: { wikibase_item: "Q43514" } }] } });
    }) as any });
    expect(await resolve("Charles Darwin")).toEqual({ id: "Q1035", label: "Charles Darwin", description: "English naturalist" });
    expect(await resolve("selection by nature")).toEqual({ id: "Q43514", label: "Natural selection", description: "" });
    expect(seen).toEqual(["Charles Darwin", "selection by nature", "search:selection by nature"]);
  });
});

const member = { id: "member", displayName: "Member", role: "member", billing: { hasAccess: true } };
const reader = { id: "reader", displayName: "Reader", role: "member", billing: { hasAccess: false } };
const admin = { id: "admin", displayName: "Admin", role: "admin", billing: { hasAccess: false } };

describe("private AI questions in My map", () => {
  const output = JSON.stringify({ answer: "Haeckel coined the word.", related: [{ label: "Ernst Haeckel", relation: "named it" }, { label: "Ecology", relation: "is" }] });
  function service(calls: any[] = [], database: any = {}) {
    return createPublicMapService({ database, executeChatReply: async (args: any) => { calls.push(args); return { reply: output }; },
      resolveTopic: async (label: string) => label === "Ernst Haeckel" ? { id: "Q48255", label, description: "German zoologist" } : null });
  }

  test("answers with the note as context, resolves related topics and saves nothing", async () => {
    const calls: any[] = [];
    const createPublicAnswer = () => { throw new Error("private answers are never shared"); };
    const answer = await service(calls, { createPublicAnswer }).askPrivate({ user: member, payload: {
      topic: { label: "Ecology" }, noteContent: "My notes on Haeckel.", question: "Who named ecology?",
      ai: { mode: "fast", contextScope: "workspace", selectedConversationIds: ["other"] } } });
    expect(answer).toEqual({ question: "Who named ecology?", answer: "Haeckel coined the word.",
      related: [{ id: "Q48255", label: "Ernst Haeckel", description: "German zoologist", relation: "named it" }] });
    expect(isPrivateAnswer(answer)).toBe(true);
    expect(calls[0].operation).toBe("map-question");
    expect(calls[0].payload.ai).toMatchObject({ contextScope: "conversation", selectedConversationIds: [] });
    expect(JSON.parse(calls[0].payload.messages[1].content)).toMatchObject({ note: "My notes on Haeckel." });
    await expect(service().askPrivate({ user: reader, payload: { topic: { label: "Ecology" }, question: "Why?" } })).rejects.toMatchObject({ statusCode: 402 });
    await service().askPrivate({ user: admin, payload: { topic: { label: "Ecology" }, question: "Who?" } });
    await expect(service().askPrivate({ user: member, payload: { topic: { label: "Ecology" }, noteContent: "x".repeat(6001), question: "Why?" } })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("web search", () => {
  function billing() {
    const events: any[] = [];
    return { events, reserveHostedRequest: async (args: any) => { events.push(["reserve", args.amountMicros]); },
      settleHostedRequest: async (args: any) => { events.push(["settle", args.amountMicros, args.metadata.outcome]); } };
  }
  const tavily = (results: unknown[]) => (async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.tavily.com/search");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key");
    expect(JSON.parse(String(init.body))).toMatchObject({ query: "ecology", search_depth: "basic", max_results: 8, include_raw_content: false });
    return Response.json({ query: "ecology", results });
  }) as any;

  test("keeps only plain http(s) results with plain text", () => {
    const results = normalizeTavilyResults({ results: [
      { title: "<strong>Ecology</strong> &amp; more", url: "https://example.com/eco", content: "About <b>ecology</b>", score: 0.9, published_date: "Tue, 11 Mar 2025 17:00:00 GMT" },
      { title: "Bad", url: "javascript:alert(1)" },
      { title: "Dup", url: "https://example.com/eco" },
      { title: "", url: "http://www.site.org/page", published_date: null },
    ] });
    expect(results).toEqual([
      { title: "Ecology & more", url: "https://example.com/eco", description: "About ecology", siteName: "example.com", age: "Tue, 11 Mar 2025 17:00:00 GMT" },
      { title: "www.site.org", url: "http://www.site.org/page", description: "", siteName: "site.org" },
    ]);
  });

  test("charges members for each search, lets admins search free, and gates free members", async () => {
    const meter = billing();
    const search = createWebSearchService({ env: { TAVILY_API_KEY: "key" }, billingService: meter, fetchImpl: tavily([{ title: "A", url: "https://a.example/", content: "" }]) });
    expect(await search.search({ user: member, payload: { query: "  ecology  " } })).toMatchObject({ query: "ecology", chargedMicros: 10_000, results: [{ url: "https://a.example/" }] });
    expect(meter.events).toEqual([["reserve", 10_000], ["settle", 10_000, "completed"]]);
    expect((await search.search({ user: admin, payload: { query: "ecology" } })).chargedMicros).toBe(0);
    expect(meter.events).toHaveLength(2);
    await expect(search.search({ user: reader, payload: { query: "ecology" } })).rejects.toMatchObject({ statusCode: 402 });
    await expect(search.search({ user: member, payload: { query: "x" } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createWebSearchService({ env: {}, billingService: meter }).search({ user: member, payload: { query: "ecology" } })).rejects.toMatchObject({ statusCode: 503 });
  });

  test("gives the agent an unbilled search that needs the key", async () => {
    const meter = billing();
    const search = createWebSearchService({ env: { TAVILY_API_KEY: "key" }, billingService: meter, fetchImpl: tavily([{ title: "A", url: "https://a.example/", content: "About A" }]) });
    expect(search.configured).toBe(true);
    expect(await search.request("ecology")).toEqual([{ title: "A", url: "https://a.example/", description: "About A", siteName: "a.example" }]);
    expect(meter.events).toEqual([]);
    const unset = createWebSearchService({ env: { TAVILY_API_KEY: " " }, billingService: meter });
    expect(unset.configured).toBe(false);
    await expect(unset.request("ecology")).rejects.toMatchObject({ statusCode: 503 });
  });

  test("releases the held credit when the provider fails", async () => {
    const meter = billing();
    const search = createWebSearchService({ env: { TAVILY_API_KEY: "key", WEB_SEARCH_PRICE_MICROS: "5000" }, billingService: meter, fetchImpl: (async () => new Response("no", { status: 500 })) as any });
    await expect(search.search({ user: member, payload: { query: "ecology" } })).rejects.toMatchObject({ statusCode: 502 });
    expect(meter.events).toEqual([["reserve", 5000], ["settle", 0, "failed"]]);
  });
});

describe("map source routes", () => {
  let server: Server, origin = "";
  const headers = { "Content-Type": "application/json", "X-Test-User": "member", "X-Margin-Vault-User": "member" };
  beforeAll(async () => {
    const users: Record<string, any> = { member, reader };
    server = createServer(createApiHandler({
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      authService: { getAuthContext: async (request: any) => ({ user: users[request.headers["x-test-user"]] ?? null }) },
      publicMapService: { askPrivate: async ({ onProgress }: any) => { onProgress("Thinking…"); return { question: "Q?", answer: "A.", related: [] }; } },
      webSearchService: { search: async ({ user, payload }: any) => ({ query: payload.query, results: [], chargedMicros: user.role === "admin" ? 0 : 10_000 }) },
    } as any));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  test("streams a private answer and returns web results", async () => {
    const ask = await fetch(`${origin}/api/graph/ask`, { method: "POST", headers, body: JSON.stringify({ topic: { label: "Ecology" }, question: "Q?" }) });
    expect(ask.status).toBe(200);
    const lines = (await ask.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.at(-1)).toEqual({ type: "done", answer: { question: "Q?", answer: "A.", related: [] } });
    const web = await fetch(`${origin}/api/web-search`, { method: "POST", headers, body: JSON.stringify({ query: "ecology" }) });
    expect(await web.json()).toEqual({ query: "ecology", results: [], chargedMicros: 10_000 });
    expect((await fetch(`${origin}/api/web-search`, { method: "POST", headers: { ...headers, "Sec-Fetch-Site": "cross-site" }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${origin}/api/web-search`, { method: "POST", headers: { ...headers, "X-Margin-Vault-User": "reader" }, body: "{}" })).status).toBe(409);
  });
});

describe("Wikipedia connections in My map", () => {
  const source = (id: string, label: string): PublicTopic => ({ id, aliases: [], label, description: `About ${label}`,
    wikidataUrl: `https://www.wikidata.org/wiki/${id}`, wikipediaUrl: `https://en.wikipedia.org/wiki/${label}`, retrievedAt: "2026-10-09T00:00:00.000Z" });

  test("saves topics as notes linked by typed relations that survive the Markdown vault", () => {
    const ecology = savePublicTopic(createEmptyState(), source("Q7150", "Ecology"));
    const existing = savePublicTopic(ecology.state, source("Q420", "Biology"));
    const createdAt = "2026-10-09T12:00:00.000Z";
    const connections = [
      { topic: source("Q420", "Biology"), kind: wikipediaConnectionKind("wikipedia-broader"), note: "Wikipedia · broader topic" },
      { topic: source("Q37813", "Ecosystem"), kind: wikipediaConnectionKind("wikipedia-lead"), note: "Wikipedia · key topic" },
      { topic: source("Q48255", "Ernst Haeckel"), kind: wikipediaConnectionKind("wikipedia-section"), note: "Wikipedia · History" },
      { topic: source("Q1", "Environmentalism"), kind: wikipediaConnectionKind("wikipedia-see-also") },
      { topic: source("Q7150", "Ecology"), kind: "narrower" as const },
    ];
    const first = connectPublicTopics(existing.state, ecology.conversationId, connections, { createdAt, origin: "import" });
    expect(first.added).toBe(4);
    const state = first.state;
    const id = (topicId: string) => findSavedPublicTopic(state.conversations, topicId)!.id;
    expect(id("Q420")).toBe(existing.conversationId);
    expect(state.conversations[ecology.conversationId].relations).toEqual([
      { type: "part-of", targetConversationId: existing.conversationId, origin: "import", createdAt, note: "Wikipedia · broader topic" },
    ]);
    expect(state.conversations[id("Q37813")].relations).toEqual([
      { type: "elaborates", targetConversationId: ecology.conversationId, origin: "import", createdAt, note: "Wikipedia · key topic" },
    ]);
    const linked = [state.conversations[ecology.conversationId], state.conversations[id("Q1")]].flatMap((item) => item.linkedConversationIds ?? []);
    expect(linked).toContain(id("Q1") === [ecology.conversationId, id("Q1")].sort()[0] ? ecology.conversationId : id("Q1"));
    // A second pass adds nothing that is already connected.
    expect(connectPublicTopics(state, ecology.conversationId, connections, { createdAt, origin: "import" }).added).toBe(0);
    const reopened = vaultToState(stateToVaultFiles(state, {}), createEmptyState());
    const reopenedEcology = findSavedPublicTopic(reopened.conversations, "Q7150")!;
    expect(reopenedEcology.relations?.[0]).toMatchObject({ type: "part-of", targetConversationId: findSavedPublicTopic(reopened.conversations, "Q420")!.id });
    expect(findSavedPublicTopic(reopened.conversations, "Q48255")!.relations?.[0]).toMatchObject({ type: "elaborates", targetConversationId: reopenedEcology.id });
  });
});
