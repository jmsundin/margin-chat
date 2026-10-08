import { createRoot } from "react-dom/client";
import ConversationGraphView from "../../client/src/components/ConversationGraphView";
import { createMainConversation } from "../../client/src/initialState";
import type { Conversation } from "../../client/src/types";
import "../../client/src/styles.css";
import "../../client/src/components/KnowledgeGraphWorkspace.css";

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

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).endsWith("/api/chat/title")) {
    const prompt = JSON.parse(String(init?.body)).prompt as string;
    const match = topics.find(([hubTitle]) => prompt.includes(hubTitle));
    await new Promise((resolve) => setTimeout(resolve, 400));
    return Response.json({ title: match?.[1] ?? "Mixed topics" });
  }
  return new Response("Not found", { status: 404 });
}) as typeof fetch;

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
createRoot(document.getElementById("root")!).render(<main style={{ height: "100dvh", display: "flex", background: "var(--bg)" }}>
  <ConversationGraphView workspaceKey="gravity-clusters-preview" activeConversationId="hub-0" conversations={conversations} groups={{}}
    jev={{ userId: "preview", enabled: params.get("jev") !== "off", ready: true }}
    onActivateConversation={() => {}} onAssignGroup={() => {}} onCreateChildConversation={() => "hub-0"} onOpenConversation={() => {}}
    onToggleGroup={() => {}} onUpdateGraphNodeLayouts={() => {}} renderDockedConversation={(id) => <p style={{ padding: 16 }}>{conversations[id].title}</p>}
    renderExpandedConversation={(id) => <p>{conversations[id].title}</p>} />
</main>);
