import { createRoot } from "react-dom/client";
import ConversationGraphView from "../../client/src/components/ConversationGraphView";
import { createMainConversation } from "../../client/src/initialState";
import type { Conversation, ConversationGroup } from "../../client/src/types";
import "../../client/src/styles.css";
import "../../client/src/components/KnowledgeGraphWorkspace.css";

/**
 * Synthetic fixture only: one big box of unlinked documents with long titles on mixed subjects,
 * like a vault's Unfiled topic, to see how circles and titles read on a phone.
 */
const createdAt = "2026-10-21T12:00:00.000Z";
const titles = [
  "ReAct Reading Guide.pdf", "HyperAgents: self-improving agent loops", "Hinton2015_Distilling_the_Knowledge_in_a_Neural_Network.pdf",
  "ACID Principles for Cloud Data Integrity", "Van Westendorp price sensitivity", "Bounded Rationality", "Offline LLMs for MacBook Air M4",
  "journal", "Six-Month Agentic AI Engineering Roadmap", "Margin Chat Multi-Agent Architecture", "software engineering lessons",
  "jmsundin/MyNotes", "How Claude Code works", "Software Engineering Is Becoming Factory Work", "Architectures for Reliable Agents",
  "Untitled document", "Rapamycin and mTOR dosing", "Epigenetic clocks", "Senolytics trial notes", "Partial reprogramming with OSK factors",
  "Postgres migration plan", "Vector search index", "Event sourcing", "Caching layers", "Pricing page copy", "Stripe webhooks",
  "Sleep and HRV log", "Zone 2 training", "VO2 max protocol", "Attention Is All You Need.pdf", "Transformer scaling laws",
  "Agent memory design", "Weekly review", "Reading list 2026", "Lab-grown organs",
];
const conversations: Record<string, Conversation> = {};
titles.forEach((title, index) => {
  const conversation = createMainConversation({ id: `d${index}`, createdAt });
  conversation.title = title;
  conversation.linkedConversationIds = [];
  conversation.messages = [{ id: `d${index}-m`, role: "user", content: `Notes about ${title.toLowerCase()}.`, createdAt }];
  conversations[conversation.id] = conversation;
});
// One small group; everything else lands in the dashed No group box, like a vault's Unfiled topic.
const groups: Record<string, ConversationGroup> = {
  g1: { id: "g1", name: "Longevity", color: "#4fb39a", collapsed: false, conversationIds: ["d16", "d17", "d18", "d19", "d34"] },
};
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
// ?meaning=1: AI assistance on, boxes are Topics, and made-up meaning vectors stand in for the server's:
// each document gets a field, a subject within it and a part of its own. Longevity and backend documents
// score about 0.6 with their subject, so Topics finds them; the rest score about 0.33 with their subject
// and 0.2 with their field, too loose for a topic, so they land in Unfiled, as most of a real vault does.
const meaning = params.get("meaning") === "1";
const subjects: Record<number, [number, number]> = {
  0: [0, 0], 1: [0, 1], 2: [1, 2], 3: [2, 3], 4: [3, 4], 5: [4, 5], 6: [2, 3], 7: [5, 6], 8: [0, 1], 9: [0, 1], 10: [1, 7],
  11: [5, 6], 12: [0, 1], 13: [1, 7], 14: [0, 1], 15: [5, 8], 16: [6, 9], 17: [6, 9], 18: [6, 9], 19: [6, 10], 20: [2, 11],
  21: [2, 11], 22: [2, 11], 23: [2, 11], 24: [3, 4], 25: [3, 12], 26: [7, 13], 27: [7, 13], 28: [7, 13], 29: [0, 0], 30: [0, 0],
  31: [0, 1], 32: [5, 6], 33: [5, 8], 34: [6, 10],
};
function vectorFor(index: number) {
  const [field, subject] = subjects[index];
  const values = new Array(64).fill(0);
  const tight = subject === 9 || subject === 11;
  values[field] = tight ? 0.55 : 0.447; values[10 + subject] = tight ? 0.55 : 0.36; values[30 + index] = tight ? 0.63 : 0.82;
  return btoa(String.fromCharCode(...values.map((value) => Math.round(value * 127) & 255)));
}
if (meaning) {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => String(input).includes("/api/vault/topics")
    ? Promise.resolve(new Response(JSON.stringify({ embeddings: titles.map((_, index) => ({ id: `d${index}`, embedding: vectorFor(index) })), cursor: "done", pending: false }),
      { headers: { "Content-Type": "application/json" } }))
    : realFetch(input, init);
} else localStorage.setItem("margin-map-canvas-grouping:map-topic-box-preview", JSON.stringify("groups"));
createRoot(document.getElementById("root")!).render(<main style={{ height: "100dvh", display: "flex", background: "var(--bg)" }}>
  <ConversationGraphView workspaceKey={meaning ? "map-topic-box-meaning" : "map-topic-box-preview"} activeConversationId="d15" conversations={conversations}
    groups={meaning ? {} : groups} isVisible jev={{ userId: "preview", enabled: meaning, ready: true }}
    onActivateConversation={() => {}} onAssignGroup={() => {}} onCreateChildConversation={() => "d0"} onOpenConversation={() => {}}
    onToggleGroup={() => {}} onUpdateGraphNodeLayouts={() => {}} renderDockedConversation={(id) => <p style={{ padding: 16 }}>{conversations[id].title}</p>}
    renderExpandedConversation={(id) => <p>{conversations[id].title}</p>} />
</main>);
