import { createRoot } from "react-dom/client";
import ConversationGraphView from "../../client/src/components/ConversationGraphView";
import { createChildConversation, createMainConversation } from "../../client/src/initialState";
import type { Conversation } from "../../client/src/types";
import "../../client/src/styles.css";
import "../../client/src/components/KnowledgeGraphWorkspace.css";

/** Synthetic fixture only: documents with long titles and a few links, to see circles and cut titles. */
const createdAt = "2026-10-21T12:00:00.000Z";
const conversations: Record<string, Conversation> = {};
function add(conversation: Conversation, title: string) {
  conversation.title = title;
  conversation.linkedConversationIds = [];
  conversation.messages = [{ id: `${conversation.id}-m`, role: "user", content: `Notes about ${title.toLowerCase()}.`, createdAt }];
  conversations[conversation.id] = conversation;
  return conversation;
}
function child(parent: Conversation, id: string, title: string) {
  const conversation = add(createChildConversation({ id, parentConversation: parent, createdAt }), title);
  parent.childIds.push(id);
  return conversation;
}
const families: Array<[string, string, string[]]> = [
  ["lon", "Longevity", ["Rapamycin and mTOR dosing studies", "Partial reprogramming with OSK factors in aged mice", "Epigenetic clocks", "Lab-grown organs", "Blood biomarkers to track every quarter"]],
  ["sd", "System design", ["Postgres migration plan", "Vector search index", "Event sourcing", "Caching layers"]],
  ["ng", "Angular", ["Signals", "Module federation"]],
  ["mc", "Margin Chat roadmap", ["MCP server", "Map view ideas"]],
];
for (const [id, title, children] of families) {
  const root = add(createMainConversation({ id, createdAt }), title);
  children.forEach((childTitle, index) => child(root, `${id}-${index}`, childTitle));
}
for (const [id, title] of [["surv", "Surviving now, building the future"], ["seno", "Senolytics"], ["rate", "Rate limiting"]]) add(createMainConversation({ id, createdAt }), title);
const link = (a: string, b: string) => conversations[a].linkedConversationIds!.push(b);
link("surv", "lon"); link("mc", "surv"); link("mc-1", "sd-1"); link("mc-0", "sd-0"); link("ng", "sd-0"); link("lon-2", "lon-4"); link("seno", "lon-1");

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
createRoot(document.getElementById("root")!).render(<main style={{ height: "100dvh", display: "flex", background: "var(--bg)" }}>
  <ConversationGraphView workspaceKey="map-dot-nodes-preview" activeConversationId="lon" conversations={conversations} groups={{}}
    isVisible jev={{ userId: "preview", enabled: false, ready: true }}
    onActivateConversation={() => {}} onAssignGroup={() => {}} onCreateChildConversation={() => "lon"} onOpenConversation={() => {}}
    onToggleGroup={() => {}} onUpdateGraphNodeLayouts={() => {}} renderDockedConversation={(id) => <p style={{ padding: 16 }}>{conversations[id].title}</p>}
    renderExpandedConversation={(id) => <p>{conversations[id].title}</p>} />
</main>);
