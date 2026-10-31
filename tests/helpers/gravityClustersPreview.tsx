import { useState } from "react";
import { createRoot } from "react-dom/client";
import ConversationGraphView from "../../client/src/components/ConversationGraphView";
import { createMainConversation } from "../../client/src/initialState";
import type { Conversation } from "../../client/src/types";
import "../../client/src/styles.css";
import "../../client/src/components/KnowledgeGraphWorkspace.css";
import { buildSyntheticVault } from "./syntheticVault";
import { layoutLandscape } from "../../server/documents/landscape.mjs";

/** Synthetic fixture only: linked notes around a few hubs, with a fake Luna. */
const createdAt = "2026-10-08T12:00:00.000Z";
const topics: Array<[string, string, number]> = [
  ["Postgres migration plan", "Database migration", 24],
  ["Vault sync design", "Vault sync", 18],
  ["Mobile gestures", "Mobile interaction", 14],
  ["Billing with Stripe", "Billing and credit", 12],
  ["Graph view ideas", "Graph visualization", 10],
  ["Reading list", "Reading notes", 6],
];
const conversations: Record<string, Conversation> = {};
function note(id: string, title: string) {
  const conversation = createMainConversation({ id, createdAt });
  conversation.title = title;
  conversation.linkedConversationIds = [];
  conversation.messages = [{ id: `${id}-m`, role: "user", content: `Notes about ${title.toLowerCase()}.`, createdAt }];
  conversations[id] = conversation;
  return conversation;
}
topics.forEach(([hubTitle, , size], topic) => {
  const hub = note(`hub-${topic}`, hubTitle);
  for (let index = 0; index < size; index++) {
    const leaf = note(`t${topic}-${index}`, `${hubTitle.split(" ")[0]} note ${index + 1}`);
    hub.linkedConversationIds!.push(leaf.id);
    if (index % 4 === 1) leaf.linkedConversationIds!.push(`t${topic}-${index - 1}`);
  }
});
conversations["hub-0"].linkedConversationIds!.push("hub-1");
conversations["t1-3"].linkedConversationIds!.push("hub-3");
conversations["hub-2"].linkedConversationIds!.push("hub-4");
for (let index = 0; index < 7; index++) note(`loose-${index}`, `Loose idea ${index + 1}`);

// `?count=10000` swaps the hand-made fixture for a synthetic vault of that size,
// for checking how the map behaves and performs with many documents.
const params = new URLSearchParams(location.search);
const syntheticCount = Number(params.get("count") ?? 0);
if (syntheticCount > 0) {
  for (const id of Object.keys(conversations)) delete conversations[id];
  const vault = buildSyntheticVault(syntheticCount);
  for (const id of vault.ids) {
    const conversation = note(id, `Note ${id.slice(4)}`);
    conversation.createdAt = new Date(vault.createdAt.get(id)!).toISOString();
  }
  for (const { sourceId, targetId } of vault.connections) conversations[sourceId].linkedConversationIds!.push(targetId);
}
const firstId = Object.keys(conversations)[0];

// Stand-in meaning neighbours: linked documents are close, documents two links away less so,
// unlinked ones near the documents created beside them.
function previewNeighbours() {
  const ids = Object.keys(conversations);
  const linked = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const id of ids) for (const target of conversations[id].linkedConversationIds ?? []) {
    if (!linked.has(target)) continue;
    linked.get(id)!.add(target); linked.get(target)!.add(id);
  }
  const lists = new Map<string, Array<{ id: string; similarity: number }>>();
  ids.forEach((id, index) => {
    const near = new Map<string, number>();
    for (const one of linked.get(id)!) near.set(one, 0.8);
    for (const one of linked.get(id)!) for (const two of linked.get(one)!) if (two !== id && !near.has(two)) near.set(two, 0.5);
    if (!near.size) for (const step of [-2, -1, 1, 2]) { const other = ids[index + step]; if (other) near.set(other, 0.4); }
    lists.set(id, [...near].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([other, similarity]) => ({ id: other, similarity })));
  });
  return lists;
}
let previewLandscape: Array<{ id: string; x: number; y: number; region: number }> | null = null;

// Stand-in library: one field of papers in four subjects; your Postgres notes sit among the database papers.
const paperSubjects = ["Database indexing", "Query planning", "Replication", "Storage engines"];
const previewPapers = Array.from({ length: 240 }, (_, index) => ({ id: `pubmed:${1000 + index}`, subject: index % 4,
  title: `${paperSubjects[index % 4]} study ${Math.floor(index / 4) + 1}`, year: 2010 + (index % 15) }));
let previewField: any = null;
let previewFieldMap: any = null;
function previewLibrary(path: string, init?: RequestInit) {
  const field = () => previewField && { ...previewField, works: previewField.fetched, embedded: previewField.fetched };
  if (path === "/api/library/fields" && (init?.method ?? "GET") === "GET") return Response.json({ fields: previewField ? [field()] : [] });
  if (path === "/api/library/fields") {
    const body = JSON.parse(String(init?.body));
    previewField = { id: "field-preview", query: body.query, source: "pubmed", target: body.size, available: previewPapers.length, fetched: 0, regions: [], laidOutAt: null };
    return Response.json({ field: field() });
  }
  if (path.endsWith("/import")) {
    previewField.fetched = Math.min(previewPapers.length, previewField.fetched + 120);
    return Response.json({ field: field(), done: previewField.fetched >= previewPapers.length });
  }
  if (path.endsWith("/layout") || path.endsWith("/map")) {
    if (!previewFieldMap) {
      const lists = new Map(previewPapers.map((paper, index) => [paper.id, previewPapers.filter((other, j) => other.subject === paper.subject && j !== index)
        .slice(0, 12).map((other) => ({ id: other.id, similarity: 0.8 }))]));
      const { positions } = layoutLandscape({ neighbours: lists });
      const works = previewPapers.map((paper) => ({ id: paper.id, title: paper.title, year: paper.year, ...positions.get(paper.id)! }));
      const regionOfSubject = new Map(previewPapers.map((paper) => [paper.subject, positions.get(paper.id)!.region]));
      previewField.regions = paperSubjects.map((label, subject) => ({ index: regionOfSubject.get(subject), label, size: 60 }));
      previewField.laidOutAt = "2026-10-31T00:00:00.000Z";
      const dbPapers = works.filter((work, index) => previewPapers[index].subject === 0);
      const own = Object.keys(conversations).filter((id) => conversations[id].title.startsWith("Postgres")).map((id, index) => {
        const near = dbPapers[index % dbPapers.length];
        return { id, x: near.x + 120, y: near.y + 60, region: near.region, nearest: near.id };
      });
      previewFieldMap = { works, own };
    }
    return Response.json({ field: field(), ...previewFieldMap });
  }
  if (path.startsWith("/api/library/works/")) {
    const id = decodeURIComponent(path.split("/").pop()!);
    const paper = previewPapers.find((item) => item.id === id)!;
    return Response.json({ work: { id, title: paper.title, abstract: `What this ${paper.title.toLowerCase()} found.\n\nMore detail.`, year: paper.year,
      journal: "Preview Journal", doi: `10.1000/${id.slice(7)}`, authors: "Codd EF, et al.", topics: [paperSubjects[paper.subject]] } });
  }
  return new Response("Not found", { status: 404 });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).endsWith("/api/vault/topics")) {
    return Response.json({ model: "preview", dimensions: 512, embeddings: [], cursor: "2026-10-31T00:00:00.000Z", pending: 0, placements: [],
      neighbours: [...previewNeighbours()].map(([id, neighbours]) => ({ id, neighbours })) });
  }
  const path = new URL(String(input), location.href).pathname;
  if (path.startsWith("/api/library/")) return previewLibrary(path, init);
  if (String(input).endsWith("/api/vault/landscape")) {
    if (!previewLandscape) {
      const { positions } = layoutLandscape({ neighbours: previewNeighbours() });
      previewLandscape = [...positions].map(([id, at]) => ({ id, ...at }));
    }
    const regions = new Set(previewLandscape.map((entry) => entry.region)).size;
    return Response.json({ positions: previewLandscape, regions, computedAt: "2026-10-31T00:00:00.000Z", stale: false, unplaced: 0 });
  }
  if (String(input).endsWith("/api/chat/title")) {
    const prompt = JSON.parse(String(init?.body)).prompt as string;
    const match = topics.find(([hubTitle]) => prompt.includes(hubTitle));
    await new Promise((resolve) => setTimeout(resolve, 400));
    return Response.json({ title: match?.[1] ?? "Mixed topics" });
  }
  return new Response("Not found", { status: 404 });
}) as typeof fetch;

document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
// Zooming through a card shows a stand-in for Document View, like the app does.
function Preview() {
  const [openId, setOpenId] = useState<string | null>(null);
  return <main style={{ height: "100dvh", display: "flex", background: "var(--bg)" }}>
    <div style={{ display: openId ? "none" : "flex", flex: 1, minWidth: 0 }}>
      <ConversationGraphView workspaceKey="gravity-clusters-preview" activeConversationId={firstId} conversations={conversations} groups={{}}
        isVisible={!openId} jev={{ userId: "preview", enabled: params.get("jev") !== "off", ready: true }}
        onActivateConversation={() => {}} onAssignGroup={() => {}} onCreateChildConversation={() => firstId} onOpenConversation={() => {}}
        onZoomIntoConversation={setOpenId} onCreateDocument={({ title }) => { console.log("kept", title); return "kept"; }}
        onToggleGroup={() => {}} onUpdateGraphNodeLayouts={() => {}} renderDockedConversation={(id) => <p style={{ padding: 16 }}>{conversations[id].title}</p>}
        renderExpandedConversation={(id) => <p>{conversations[id].title}</p>} />
    </div>
    {openId ? <section data-preview-document={openId} style={{ flex: 1, padding: 24, color: "var(--ink)" }}>
      <h1>{conversations[openId].title}</h1>
      <button type="button" onClick={() => setOpenId(null)}>Back to map</button>
    </section> : null}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Preview />);
