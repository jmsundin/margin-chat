import { createRoot } from "react-dom/client";
import ConversationGraphView from "../../client/src/components/ConversationGraphView";
import { createChildConversation, createMainConversation } from "../../client/src/initialState";
import type { Conversation } from "../../client/src/types";
import "../../client/src/styles.css";
import "../../client/src/components/KnowledgeGraphWorkspace.css";

/** Synthetic fixture only: a few hundred dated, tagged documents for trying the map's filters. */
const conversations: Record<string, Conversation> = {};
let seed = 11;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const DAY = 86_400_000, now = Date.parse("2026-10-15T12:00:00Z");
const topics: Array<[string, string[]]> = [
  ["Angular", ["frontend"]], ["Postgres", ["db"]], ["Launch", ["launch", "work"]], ["Reading", ["books"]], ["Health", ["health"]], ["Travel", ["travel"]],
];
function add(conversation: Conversation, title: string, daysAgo: number, tags: string[], words: number) {
  const at = new Date(now - daysAgo * DAY).toISOString();
  conversation.title = title;
  conversation.createdAt = at;
  conversation.updatedAt = new Date(now - Math.max(0, daysAgo - random() * 60) * DAY).toISOString();
  conversation.tags = tags;
  conversation.linkedConversationIds = [];
  conversation.messages = [{ id: `${conversation.id}-m`, role: "user", content: Array.from({ length: words }, () => "word").join(" "), createdAt: at }];
  conversations[conversation.id] = conversation;
  return conversation;
}
topics.forEach(([topic, tags], index) => {
  const age = 40 + index * 70;
  const hub = add(createMainConversation({ id: `t${index}` }), `${topic} notes`, age, tags, 1200);
  for (let item = 0; item < 26; item++) {
    const daysAgo = Math.round(age * random() + random() * 300);
    const doc = add(createMainConversation({ id: `t${index}-${item}` }), `${topic} ${item + 1}`, daysAgo, tags, Math.round(random() * 1500));
    hub.linkedConversationIds!.push(doc.id);
    if (item % 5 === 0) {
      const child = add(createChildConversation({ id: `t${index}-${item}-c`, parentConversation: doc }), `${topic} ${item + 1} branch`, daysAgo - 2, tags, 80);
      doc.childIds.push(child.id);
    }
  }
});
for (let item = 0; item < 30; item++) add(createMainConversation({ id: `loose-${item}` }), `Loose idea ${item + 1}`, Math.round(random() * 500), [], Math.round(random() * 300));

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
createRoot(document.getElementById("root")!).render(<main style={{ height: "100dvh", display: "flex", background: "var(--bg)" }}>
  <ConversationGraphView workspaceKey="map-lens-preview" activeConversationId="t0" conversations={conversations} groups={{}}
    isVisible jev={{ userId: "preview", enabled: false, ready: true }}
    onActivateConversation={() => {}} onAssignGroup={() => {}} onCreateChildConversation={() => "t0"} onOpenConversation={() => {}}
    onToggleGroup={() => {}} onUpdateGraphNodeLayouts={() => {}} renderDockedConversation={(id) => <p style={{ padding: 16 }}>{conversations[id].title}</p>}
    renderExpandedConversation={(id) => <p>{conversations[id].title}</p>} />
</main>);
