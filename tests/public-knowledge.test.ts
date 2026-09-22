import { afterEach, describe, expect, test } from "bun:test";
import { expandPublicTopic, getPublicTopic, searchPublicTopics } from "../client/src/lib/publicKnowledge";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function entity(id: string, label = `Topic ${id}`, extra: Record<string, unknown> = {}) {
  return { id, type: id.startsWith("Q") ? "item" : "property", lastrevid: 42,
    labels: { en: { language: "en", value: label } }, descriptions: {}, sitelinks: {}, ...extra };
}

function statement(targetId: string, extra: Record<string, unknown> = {}) {
  return { rank: "normal", mainsnak: { snaktype: "value", datatype: "wikibase-item",
    datavalue: { type: "wikibase-entityid", value: { "entity-type": "item", id: targetId } } }, ...extra };
}

function mockApi(handler: (url: URL, init?: RequestInit) => unknown | Promise<unknown>) {
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe("https://www.wikidata.org/w/api.php");
    expect(url.searchParams.get("origin")).toBe("*");
    expect(url.searchParams.get("format")).toBe("json");
    expect(init?.credentials).toBe("omit");
    expect(init?.referrerPolicy).toBe("no-referrer");
    const value = await handler(url, init);
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
}

describe("public knowledge identity and search", () => {
  test("canonicalizes redirects in search, keeps source metadata, and tolerates no Wikipedia article", async () => {
    const calls: URL[] = [];
    mockApi((url) => {
      calls.push(url);
      if (url.searchParams.get("action") === "wbsearchentities") {
        expect(url.searchParams.get("search")).toBe("systems & feedback");
        expect(url.searchParams.get("type")).toBe("item");
        expect(url.searchParams.get("limit")).toBe("12");
        return { search: [{ id: "Q880001" }, { id: "Q880002" }, { id: "Q880003" }, { id: "P31" }, { id: "Q880001" }] };
      }
      expect(url.searchParams.get("ids")).toBe("Q880001|Q880002|Q880003");
      expect(url.searchParams.get("redirects")).toBe("yes");
      expect(url.searchParams.get("props")).not.toContain("claims");
      const canonical = entity("Q880002", "Feedback", {
        descriptions: { en: { value: "Outputs affecting future inputs" } },
        sitelinks: { enwiki: { title: "Feedback (systems)", url: "https://untrusted.example/wrong" } },
      });
      return { entities: {
        Q880001: { ...canonical, redirects: { from: "Q880001", to: "Q880002" } },
        Q880002: canonical, Q880003: entity("Q880003", "A topic without an article"),
      } };
    });
    const topics = await searchPublicTopics("  systems & feedback  ");
    expect(calls).toHaveLength(2);
    expect(topics.map((topic) => topic.id)).toEqual(["Q880002", "Q880003"]);
    expect(topics[0]).toMatchObject({ aliases: ["Q880001"], label: "Feedback", description: "Outputs affecting future inputs",
      wikidataUrl: "https://www.wikidata.org/wiki/Q880002", wikipediaUrl: "https://en.wikipedia.org/wiki/Feedback_(systems)", revision: 42 });
    expect(Number.isNaN(Date.parse(topics[0].retrievedAt))).toBe(false);
    expect(topics[1].wikipediaUrl).toBeUndefined();
  });

  test("bounds search response hydration and makes no request for empty search or invalid IDs", async () => {
    let requests = 0;
    mockApi((url) => {
      requests++;
      if (url.searchParams.get("action") === "wbsearchentities") {
        expect(url.searchParams.get("search")).toHaveLength(200);
        return { search: Array.from({ length: 30 }, (_, index) => ({ id: `Q8801${index}` })) };
      }
      const ids = url.searchParams.get("ids")!.split("|");
      expect(ids).toHaveLength(12);
      return { entities: Object.fromEntries(ids.map((id) => [id, entity(id)])) };
    });
    expect(await searchPublicTopics("  ")).toEqual([]);
    await expect(getPublicTopic("https://example.com/Q42")).rejects.toThrow("valid Wikidata topic");
    await expect(getPublicTopic("P31")).rejects.toThrow("valid Wikidata topic");
    await expect(expandPublicTopic("Q42", -1)).rejects.toThrow("valid public map page");
    expect(requests).toBe(0);
    expect(await searchPublicTopics("a".repeat(1000))).toHaveLength(12);
    expect(requests).toBe(2);
  });

  test("shares canonical cache reads through an alias without exposing mutable cache state", async () => {
    let requests = 0;
    mockApi(() => {
      requests++;
      return { entities: { Q880201: entity("Q880202", "Original public label", {
        redirects: { from: "Q880201", to: "Q880202" }, labels: { mul: { value: "Original public label" } },
      }) } };
    });
    const topic = await getPublicTopic(" q880201 ");
    topic.label = "My edited label";
    topic.aliases.push("Q999999");
    expect(await getPublicTopic("Q880202")).toMatchObject({ label: "Original public label", aliases: ["Q880201"] });
    expect(await getPublicTopic("Q880201")).toMatchObject({ id: "Q880202", aliases: ["Q880201"] });
    expect(requests).toBe(1);
  });
});

describe("bounded public graph expansion", () => {
  test("loads topical statements before Wikimedia metadata while retaining both in pagination", async () => {
    const topicalIds = Array.from({ length: 11 }, (_, index) => `Q8851${String(index).padStart(2, "0")}`);
    mockApi((url) => {
      const ids = url.searchParams.get("ids")!.split("|");
      if (ids[0] === "Q885000") return { entities: { Q885000: entity("Q885000", "Root", { claims: {
        P910: [statement("Q885201")], P1151: [statement("Q885202")], P1424: [statement("Q885203")],
        P999999: topicalIds.map((id) => statement(id)),
      } }) } };
      return { entities: Object.fromEntries(ids.map((id) => [id, entity(id)])) };
    });
    const first = await expandPublicTopic("Q885000");
    expect(first.topics.map((item) => item.id)).toEqual(topicalIds.slice(0, 10));
    expect(first.nextOffset).toBe(10);
    expect(first.hasMore).toBe(true);
    const second = await expandPublicTopic("Q885000", first.nextOffset);
    expect(second.topics.map((item) => item.id)).toEqual([topicalIds[10], "Q885201", "Q885202", "Q885203"]);
    expect(second.relations.map((link) => link.propertyId)).toEqual(["P999999", "P910", "P1151", "P1424"]);
    expect(second.nextOffset).toBe(14);
    expect(second.hasMore).toBe(false);
  });

  test("paginates direct statements, excludes deprecated and non-item values, and never recursively fetches neighbors", async () => {
    const calls: URL[] = [];
    const neighbors = Array.from({ length: 13 }, (_, index) => `Q8811${String(index).padStart(2, "0")}`);
    mockApi((url) => {
      calls.push(url);
      const ids = url.searchParams.get("ids")!.split("|");
      expect(ids.length).toBeLessThanOrEqual(20);
      if (ids[0] === "Q881000") {
        expect(url.searchParams.get("props")).toContain("claims");
        return { entities: { Q881000: entity("Q881000", "Root", { claims: { P279: [
          ...neighbors.toReversed().map((id) => statement(id)), statement(neighbors[0]),
          statement("Q881999", { rank: "deprecated" }),
          statement("Q881998", { mainsnak: { snaktype: "novalue", datatype: "wikibase-item" } }),
          statement("Q881997", { mainsnak: { snaktype: "value", datatype: "string", datavalue: { type: "string", value: "text" } } }),
        ] } }) } };
      }
      expect(url.searchParams.get("props")).not.toContain("claims");
      return { entities: Object.fromEntries(ids.map((id) => [id, entity(id, id === "P279" ? "subclass of" : `Neighbor ${id}`)])) };
    });
    const first = await expandPublicTopic("Q881000");
    expect(first.topics.map((topic) => topic.id)).toEqual(neighbors.slice(0, 10));
    expect(first.relations).toHaveLength(10);
    expect(first.relations[0]).toEqual({ id: `Q881000:P279:${neighbors[0]}`, sourceId: "Q881000", targetId: neighbors[0],
      propertyId: "P279", label: "subclass of", sourceUrl: "https://www.wikidata.org/wiki/Q881000#P279" });
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(10);
    const second = await expandPublicTopic("Q881000", first.nextOffset);
    expect(second.topics.map((topic) => topic.id)).toEqual(neighbors.slice(10));
    expect(second.hasMore).toBe(false);
    expect(second.nextOffset).toBe(13);
    expect((await expandPublicTopic("Q881000", second.nextOffset)).topics).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(calls.filter((url) => url.searchParams.get("props")!.includes("claims"))).toHaveLength(1);
  });

  test("canonicalizes source and target aliases, removes duplicate edges and keeps different properties", async () => {
    mockApi((url) => {
      const ids = url.searchParams.get("ids")!.split("|");
      if (ids[0] === "Q882000") return { entities: { Q882000: entity("Q882010", "Canonical root", {
        redirects: { from: "Q882000", to: "Q882010" },
        claims: { P999101: [statement("Q882001"), statement("Q882002"), statement("Q882003"), statement("Q882010")], P999102: [statement("Q882002")] },
      }) } };
      return { entities: Object.fromEntries(ids.map((id) => [id,
        id === "Q882001" ? entity("Q882002", "Canonical neighbor", { redirects: { from: id, to: "Q882002" } }) :
        id === "Q882003" ? { id, missing: "" } : entity(id, id.startsWith("P") ? `Property ${id}` : "Canonical neighbor"),
      ])) };
    });
    const result = await expandPublicTopic("Q882000");
    expect(result.topic).toMatchObject({ id: "Q882010", aliases: ["Q882000"] });
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0]).toMatchObject({ id: "Q882002", aliases: ["Q882001"] });
    expect(result.relations.map((relation) => relation.id)).toEqual(["Q882010:P999101:Q882002", "Q882010:P999102:Q882002"]);
    expect(result.relations.every((relation) => relation.sourceUrl.startsWith("https://www.wikidata.org/wiki/Q882010#"))).toBe(true);
    expect(result.nextOffset).toBe(5);
    expect(result.hasMore).toBe(false);
  });

  test("advances pagination through deleted targets instead of trapping expansion on an empty page", async () => {
    const ids = Array.from({ length: 11 }, (_, index) => `Q8831${String(index).padStart(2, "0")}`);
    mockApi((url) => {
      const requested = url.searchParams.get("ids")!.split("|");
      if (requested[0] === "Q883000") return { entities: { Q883000: entity("Q883000", "Root", { claims: { P999201: ids.map((id) => statement(id)) } }) } };
      return { entities: Object.fromEntries(requested.map((id) => [id,
        id.startsWith("P") || id === ids[10] ? entity(id) : { id, missing: "" },
      ])) };
    });
    const first = await expandPublicTopic("Q883000");
    expect(first.topics).toEqual([]);
    expect(first.relations).toEqual([]);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(10);
    const last = await expandPublicTopic("Q883000", first.nextOffset);
    expect(last.topics.map((topic) => topic.id)).toEqual([ids[10]]);
    expect(last.hasMore).toBe(false);
  });
});

describe("public API failures and cancellation", () => {
  test("reports unavailable, missing, and malformed data and permits a later successful retry", async () => {
    mockApi(() => new Response("Busy", { status: 429 }));
    await expect(getPublicTopic("Q884001")).rejects.toThrow("too many requests");
    mockApi(() => ({ error: { code: "maxlag", info: "Lagged" } }));
    await expect(getPublicTopic("Q884001")).rejects.toThrow("maxlag");
    mockApi(() => new Response("Not JSON"));
    await expect(getPublicTopic("Q884001")).rejects.toThrow("unreadable response");
    mockApi(() => ({ entities: [] }));
    await expect(getPublicTopic("Q884001")).rejects.toThrow("invalid topic list");
    mockApi(() => ({ entities: { Q884001: { id: "Q884001", missing: "" } } }));
    await expect(getPublicTopic("Q884001")).rejects.toThrow("no longer available");
    mockApi(() => ({ entities: { Q884001: entity("Q884001") } }));
    expect((await getPublicTopic("Q884001")).id).toBe("Q884001");
  });

  test("cancels before cached reads and during network requests without poisoning a retry", async () => {
    mockApi(() => { throw new Error("An aborted request must not fetch."); });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(getPublicTopic("Q884001", alreadyAborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(searchPublicTopics("", alreadyAborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    mockApi((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = getPublicTopic("Q884002", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    mockApi(() => ({ entities: { Q884002: entity("Q884002") } }));
    expect((await getPublicTopic("Q884002")).id).toBe("Q884002");
  });
});
