import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import { writeState } from "../server/db/repository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";
import * as topics from "../server/db/topicRepository.mjs";
import * as library from "../server/db/libraryRepository.mjs";
import { createTopicEmbeddingService, TOPIC_EMBEDDING_DIMENSIONS } from "../server/documents/topics.mjs";
import { createLibraryService, nameLibraryRegions } from "../server/library/index.mjs";
import { parsePubMedArticle } from "../server/library/pubmed.mjs";

const article = (pmid: number, title: string, abstract: string, topics: string[]) => `<PubmedArticle><MedlineCitation><PMID Version="1">${pmid}</PMID>
<Article><Journal><JournalIssue><PubDate><Year>2021</Year><Month>Mar</Month></PubDate></JournalIssue><Title>Aging Cell</Title></Journal>
<ArticleTitle>${title}</ArticleTitle><Abstract><AbstractText Label="BACKGROUND">${abstract}</AbstractText><AbstractText>More &amp; more.</AbstractText></Abstract>
<AuthorList CompleteYN="Y"><Author ValidYN="Y"><LastName>Baker</LastName><ForeName>Darren</ForeName><Initials>DJ</Initials></Author>
<Author ValidYN="Y"><LastName>Kirkland</LastName><Initials>JL</Initials></Author></AuthorList>
<ELocationID EIdType="doi" ValidYN="Y">10.1000/${pmid}</ELocationID></Article>
<MeshHeadingList>${topics.map((topic) => `<MeshHeading><DescriptorName UI="D1" MajorTopicYN="Y">${topic}</DescriptorName></MeshHeading>`).join("")}
<MeshHeading><DescriptorName UI="D2" MajorTopicYN="N">Humans</DescriptorName></MeshHeading></MeshHeadingList>
<CommentsCorrectionsList><CommentsCorrections><PMID Version="1">999</PMID></CommentsCorrections></CommentsCorrectionsList></MedlineCitation></PubmedArticle>`;

describe("PubMed articles", () => {
  test("keep title, labelled abstract, year, journal, DOI, first authors and major topics", () => {
    expect(parsePubMedArticle(article(42, "Senolytics <i>in vivo</i>", "Old cells &lt;accumulate&gt;.", ["Cellular Senescence", "Senotherapeutics"]))).toEqual({
      id: "pubmed:42", title: "Senolytics in vivo", abstract: "BACKGROUND: Old cells <accumulate>.\n\nMore & more.", year: 2021,
      journal: "Aging Cell", doi: "10.1000/42", authors: "Baker DJ, Kirkland JL", topics: ["Cellular Senescence", "Senotherapeutics"],
    });
  });
});

describe("region names", () => {
  test("pick the topic most particular to each region, not the one every paper shares", () => {
    const works = [
      ...["a1", "a2", "a3"].map((id) => ({ id, topics: ["Aging", "Senolytics"] })),
      ...["b1", "b2", "b3"].map((id) => ({ id, topics: ["Aging", "Autophagy"] })),
    ];
    const regionOf = new Map([["a1", 0], ["a2", 0], ["a3", 0], ["b1", 1], ["b2", 1], ["b3", 1]]);
    expect(nameLibraryRegions(works, regionOf).map((region) => region.label)).toEqual(["Senolytics", "Autophagy"]);
  });
});

const databases: PGlite[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((database) => database.close())); });

describe("library service", () => {
  test("imports a field from PubMed, embeds, lays it out, and pins your nearby documents on it", async () => {
    const pg = new PGlite({ extensions: { vector } });
    databases.push(pg);
    const client = { async query(sql: string, values?: unknown[]) {
      const result = values === undefined && sql.includes(";") ? (await pg.exec(sql)).at(-1)! : await pg.query(sql, values);
      return { ...result, rowCount: result.rows.length || (result as { affectedRows?: number }).affectedRows || 0 };
    } };
    await migrateDatabase(client, { migrations: await loadMigrations() });
    await pg.query("insert into marginchat_users (id,email,password_hash,display_name) values ('u1','u1@example.test','hash','U1')");
    const database: any = Object.fromEntries([...Object.entries(topics), ...Object.entries(library)]
      .filter(([, value]) => typeof value === "function").map(([name, fn]) => [name, (args: any) => (fn as any)(client, args)]));

    // Two subjects: papers about senolytics point one way, papers about autophagy another.
    const direction = (text: string) => Array.from({ length: TOPIC_EMBEDDING_DIMENSIONS }, (_, index) =>
      (/senoly/i.test(text) ? Math.cos(index) : Math.sin(index)) + (text.length % 5) * 0.01 * Math.cos(index * 7));
    const embed = async ({ inputs }: any) => inputs.map(direction);
    const papers = Array.from({ length: 12 }, (_, index) => index < 6
      ? article(100 + index, `Senolytic trial ${index}`, `Senolytics clear old cells, study ${index}.`, ["Senotherapeutics"])
      : article(100 + index, `Autophagy study ${index}`, `Autophagy recycles parts of cells, study ${index}.`, ["Autophagy"]));
    const requests: string[] = [];
    const fetchImpl = async (url: string) => {
      requests.push(url);
      if (url.includes("esearch")) {
        const start = Number(new URL(url).searchParams.get("retstart"));
        const count = Number(new URL(url).searchParams.get("retmax"));
        return Response.json({ esearchresult: { count: "12", idlist: Array.from({ length: 12 }, (_, i) => String(100 + i)).slice(start, start + count) } });
      }
      const ids = new URL(url).searchParams.get("id")!.split(",").map(Number);
      return new Response(`<PubmedArticleSet>${ids.map((id) => papers[id - 100]).join("")}</PubmedArticleSet>`);
    };
    const service = createLibraryService({ database, env: { OPENAI_API_KEY: "test" }, embed, fetchImpl: fetchImpl as any });
    const context = { allowHosted: true, apiKeys: {}, usageMeter: null };

    // One of your documents is about senolytics; one is about baking.
    const value = createEmptyState();
    const senolytic = createStandaloneNoteConversation({ id: "mine", noteId: "mine-body", createdAt: "2026-10-01T10:00:00.000Z" });
    senolytic.title = "Senolytics reading notes"; senolytic.notes![0].content = "Senolytic drugs and what they clear.";
    const bread = createStandaloneNoteConversation({ id: "bread", noteId: "bread-body", createdAt: "2026-10-01T10:00:00.000Z" });
    bread.title = "Bread"; bread.notes![0].content = "Sourdough.";
    value.conversations = { mine: senolytic, bread };
    value.rootId = "mine"; value.activeConversationId = "mine";
    await writeState(client, "u1", normalizeAppState(value));
    const unrelated = (text: string) => Array.from({ length: TOPIC_EMBEDDING_DIMENSIONS }, (_, index) => (index % 2 ? 1 : -1) * (text.length % 3 + 1));
    await createTopicEmbeddingService({ database, env: { OPENAI_API_KEY: "test" }, embed: async ({ inputs }: any) => inputs.map((text: string) => /senoly/i.test(text) ? direction(text) : unrelated(text)) })
      .sync({ userId: "u1", context, since: null });

    const { field } = await service.create({ userId: "u1", query: "senolytics OR autophagy", size: 50 });
    expect(field.target).toBe(50);
    let step = await service.importStep({ userId: "u1", fieldId: field.id, context });
    for (let guard = 0; guard < 5 && !step.done; guard++) step = await service.importStep({ userId: "u1", fieldId: field.id, context });
    expect(step.done).toBe(true);
    expect(step.field.works).toBe(12);
    expect(step.field.embedded).toBe(12);
    expect(step.field.available).toBe(12);

    const map = await service.layout({ userId: "u1", fieldId: field.id });
    expect(map.works).toHaveLength(12);
    expect(map.field.regions.map((region: any) => region.label).sort()).toEqual(["Autophagy", "Senotherapeutics"]);
    const regionOf = (id: string) => map.works.find((work: any) => work.id === id)!.region;
    expect(regionOf("pubmed:100")).toBe(regionOf("pubmed:105"));
    expect(regionOf("pubmed:100")).not.toBe(regionOf("pubmed:106"));
    // Your senolytics notes sit among the senolytics papers; the bread note is not on this field.
    expect(map.own.map((entry: any) => entry.id)).toEqual(["mine"]);
    expect(map.own[0].region).toBe(regionOf("pubmed:100"));
    expect(map.own[0].nearest).toMatch(/^pubmed:10[0-5]$/);

    const { work } = await service.work({ userId: "u1", workId: "pubmed:101" });
    expect(work.title).toBe("Senolytic trial 1");
    expect(work.abstract).toContain("Senolytics clear old cells");
    await expect(service.work({ userId: "u1", workId: "pubmed:999" })).rejects.toThrow("not in your library");

    expect((await service.list({ userId: "u1" })).fields).toHaveLength(1);
    await service.remove({ userId: "u1", fieldId: field.id });
    expect((await service.list({ userId: "u1" })).fields).toHaveLength(0);
    // The papers stay for the next reader who imports them; only the field went.
    expect((await pg.query("select count(*)::int as n from marginchat_library_works")).rows[0]).toEqual({ n: 12 });
  });

  test("refuses a field without a usable search", async () => {
    const service = createLibraryService({ database: {} as any });
    await expect(service.create({ userId: "u1", query: " ", size: 10 })).rejects.toThrow("2 to 300 characters");
  });
});
