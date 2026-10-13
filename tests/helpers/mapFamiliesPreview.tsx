import { createRoot } from "react-dom/client";
import ConversationGraphView from "../../client/src/components/ConversationGraphView";
import { createChildConversation, createMainConversation } from "../../client/src/initialState";
import type { Conversation } from "../../client/src/types";
import "../../client/src/styles.css";
import "../../client/src/components/KnowledgeGraphWorkspace.css";

/** Synthetic fixture only: a few documents with children and grandchildren, plus lone notes. */
const createdAt = "2026-10-13T12:00:00.000Z";
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
const families: Array<[string, Array<[string, string[]]>]> = [
  ["Angular", [["Angular components", ["ViewChild", "Content projection"]], ["Module federation", ["Shared deps"]], ["Signals", []]]],
  ["Postgres migration plan", [["Index changes", ["pgvector index"]], ["Rollback steps", []]]],
  ["Reading list", [["Thinking, Fast and Slow", []], ["The Pragmatic Programmer", []]]],
];
families.forEach(([title, children], family) => {
  const root = add(createMainConversation({ id: `f${family}`, createdAt }), title);
  children.forEach(([childTitle, grandchildren], index) => {
    const middle = child(root, `f${family}-${index}`, childTitle);
    grandchildren.forEach((grandTitle, grand) => child(middle, `f${family}-${index}-${grand}`, grandTitle));
  });
});
for (const title of ["Loose idea", "Weekly review", "Trip packing list"]) add(createMainConversation({ id: title.replace(/\W/g, "-"), createdAt }), title);
conversations.f0.linkedConversationIds!.push("f1");
conversations["f2-0"].linkedConversationIds!.push("Weekly-review");

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
createRoot(document.getElementById("root")!).render(<main style={{ height: "100dvh", display: "flex", background: "var(--bg)" }}>
  <ConversationGraphView workspaceKey="map-families-preview" activeConversationId="f0" conversations={conversations} groups={{}}
    isVisible jev={{ userId: "preview", enabled: false, ready: true }}
    onActivateConversation={() => {}} onAssignGroup={() => {}} onCreateChildConversation={() => "f0"} onOpenConversation={() => {}}
    onToggleGroup={() => {}} onUpdateGraphNodeLayouts={() => {}} renderDockedConversation={(id) => <p style={{ padding: 16 }}>{conversations[id].title}</p>}
    renderExpandedConversation={(id) => <p>{conversations[id].title}</p>} />
</main>);
