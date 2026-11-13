import { createRoot } from "react-dom/client";
import ConversationGraphView from "../../client/src/components/ConversationGraphView";
import { createMainConversation } from "../../client/src/initialState";
import type { Conversation } from "../../client/src/types";
import { SAMPLE_VAULT, type SampleGroup } from "./mapZoomLevelsVault";
import "../../client/src/styles.css";
import "../../client/src/components/KnowledgeGraphWorkspace.css";

/**
 * Synthetic fixture only: about 170 sample notes whose made-up meaning vectors fall into themes,
 * topics and blocks, to see the Map's zoom levels. ?copies=N repeats the vault N times over with
 * numbered titles, for a map big enough that themes show at Fit. ?ai=0 turns AI names off.
 */
const createdAt = "2026-10-21T12:00:00.000Z";
const params = new URLSearchParams(location.search);
const copies = Math.max(1, Math.min(8, Number(params.get("copies")) || 1));
const ai = params.get("ai") !== "0";
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";

interface Doc { id: string; title: string; theme: number; topic: number; block: number }
const docs: Doc[] = [];
const themeNames: string[] = [], themeSummaries: string[] = [], topicNames: string[] = [], topicSummaries: string[] = [], blockNames: string[] = [];
const topicTheme: number[] = [];
for (let copy = 0; copy < copies; copy++) {
  const suffix = copy ? ` ${copy + 1}` : "";
  for (const theme of SAMPLE_VAULT.groups ?? []) {
    const themeAt = themeNames.push(theme.name + suffix) - 1;
    themeSummaries.push(theme.summary ?? "");
    for (const topic of theme.groups ?? []) {
      const topicAt = topicNames.push(topic.name + suffix) - 1;
      topicSummaries.push(topic.summary ?? "");
      topicTheme.push(themeAt);
      const blocks: SampleGroup[] = topic.groups ?? [{ name: topic.name, docs: topic.docs }];
      for (const block of blocks) {
        const blockAt = blockNames.push(block.name) - 1;
        for (const title of block.docs ?? []) docs.push({ id: `d${docs.length}`, title: title + suffix, theme: themeAt, topic: topicAt, block: blockAt });
      }
    }
  }
}
const conversations: Record<string, Conversation> = {};
for (const doc of docs) {
  const conversation = createMainConversation({ id: doc.id, createdAt });
  conversation.title = doc.title;
  conversation.linkedConversationIds = [];
  conversation.messages = [{ id: `${doc.id}-m`, role: "user", createdAt,
    content: `${doc.title}: working notes for ${topicNames[doc.topic].toLowerCase()}. What the evidence says so far, open questions, and what to read next.` }];
  conversations[conversation.id] = conversation;
}

// Each document's vector mixes its theme, topic and block with a part of its own: documents in one
// block score about 0.62, in one topic 0.42, in one theme 0.2.
const DIMENSIONS = 512;
function vectorFor(doc: Doc, index: number) {
  const values = new Array(DIMENSIONS).fill(0);
  values[doc.theme % 40] += Math.sqrt(0.2);
  values[40 + doc.topic % 120] += Math.sqrt(0.22);
  values[160 + doc.block % 160] += Math.sqrt(0.2);
  values[320 + index % 192] += Math.sqrt(0.38);
  return btoa(String.fromCharCode(...values.map((value) => Math.round(value * 127) & 255)));
}
const titleIndex = new Map(docs.map((doc) => [doc.title, doc]));
const firstTitle = (line: string) => line.replace(/^[^:]*:\s*/u, "").split(";").map((part) => part.trim()).map((part) => titleIndex.get(part)).find(Boolean);
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = String(input);
  if (url.includes("/api/vault/topics")) return json({ embeddings: docs.map((doc, index) => ({ id: doc.id, embedding: vectorFor(doc, index) })), cursor: "done", pending: false });
  if (url.includes("/api/chat/title")) {
    if (!ai) return Promise.resolve(new Response(JSON.stringify({ error: "AI is off in this fixture." }), { status: 503, headers: { "Content-Type": "application/json" } }));
    const { kind, prompt } = JSON.parse(String(init?.body ?? "{}")) as { kind?: string; prompt?: string };
    const lines = String(prompt ?? "").split("\n");
    // Clusters are named after the topic their first known title belongs to.
    if (kind === "categories") return json({ categories: lines.flatMap((line, at) => { const doc = firstTitle(line); return doc ? [{ cluster: at + 1, name: topicNames[doc.topic] }] : []; }) });
    if (kind === "map-levels") return json({ levels: lines.flatMap((line) => {
      const code = /^([TPB]\d+)/u.exec(line)?.[1];
      if (!code) return [];
      if (code.startsWith("T")) {
        const topic = line.replace(/^.*Topics:\s*/u, "").split(";").map((part) => topicNames.indexOf(part.trim())).find((at) => at >= 0);
        return topic === undefined ? [] : [{ code, name: themeNames[topicTheme[topic]], summary: themeSummaries[topicTheme[topic]] }];
      }
      if (code.startsWith("P")) {
        const topic = topicNames.findIndex((name) => line.includes(`): ${name}:`));
        return topic >= 0 && topicSummaries[topic] ? [{ code, summary: topicSummaries[topic] }] : [];
      }
      const doc = firstTitle(line.replace(/^B\d+ \([^)]*\) in /u, ""));
      return doc ? [{ code, name: blockNames[doc.block] }] : [];
    }) });
    return json({ title: "Topic" });
  }
  return realFetch(input, init);
};
createRoot(document.getElementById("root")!).render(<main style={{ height: "100dvh", display: "flex", background: "var(--bg)" }}>
  <ConversationGraphView workspaceKey={`map-zoom-levels-${copies}-${ai ? "ai" : "plain"}`} activeConversationId="d0" conversations={conversations}
    groups={{}} isVisible jev={{ userId: `zoom-preview-${copies}-${ai ? "ai" : "plain"}`, enabled: true, ready: true }}
    onActivateConversation={() => {}} onAssignGroup={() => {}} onCreateChildConversation={() => "d0"} onOpenConversation={() => {}}
    onToggleGroup={() => {}} onUpdateGraphNodeLayouts={() => {}} renderDockedConversation={(id) => <p style={{ padding: 16 }}>{conversations[id].title}</p>}
    renderExpandedConversation={(id) => <p>{conversations[id].title}</p>} />
</main>);
