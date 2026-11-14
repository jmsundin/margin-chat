import { createRoot } from "react-dom/client";
import ConversationGraphView from "../../client/src/components/ConversationGraphView";
import { createMainConversation } from "../../client/src/initialState";
import type { Conversation, DocumentRelation } from "../../client/src/types";
import "../../client/src/styles.css";
import "../../client/src/components/KnowledgeGraphWorkspace.css";

/** Synthetic fixture only: a crowded "Around" view, like a roadmap drafted from a link, with many "depends on" relations. */
const createdAt = "2026-11-13T12:00:00.000Z";
const conversations: Record<string, Conversation> = {};
const titles: Record<string, string> = {
  worker: "Inside a Worker Node: kubelet, Runtime, and Networking", cluster: "Cluster Architecture", desired: "Desired State and Reconciliation, End to End",
  fund: "Fundamentals of Devops", help: "I need help understanding Kubernetes", api: "API Server and etcd: The Source of Truth",
  labels: "Labels and Selectors: Grouping", kubectl: "kubectl and kubeconfig: Talking to a Cluster", imperative: "Imperative vs. Declarative: Two Styles",
  worked: "Worked Example: Tracing a Deployment", staged: "Staged Kubernetes Learning Path", linux: "Linux, YAML & Networking Basics",
  breakdown: "Breakdown the main concepts", kernel: "How the Operating System Kernel Works", pods: "Pods and Containers", services: "Services and DNS",
  ingress: "Ingress and Load Balancing", volumes: "Volumes and Storage", helm: "Helm Charts", ops: "Operators and CRDs",
};
for (const [id, title] of Object.entries(titles)) {
  const conversation = createMainConversation({ id, createdAt });
  conversation.title = title;
  conversation.linkedConversationIds = [];
  conversation.messages = [{ id: `${id}-m`, role: "user", content: `Notes about ${title.toLowerCase()}.`, createdAt }];
  conversations[id] = conversation;
}
const relate = (from: string, type: DocumentRelation["type"], to: string) => {
  conversations[from].relations = [...(conversations[from].relations ?? []), { type, targetConversationId: to, origin: "user", createdAt } as DocumentRelation];
};
const needs: Array<[string, string]> = [
  ["worked", "fund"], ["worked", "labels"], ["worked", "desired"], ["fund", "worker"], ["fund", "cluster"], ["help", "worker"], ["help", "cluster"],
  ["linux", "cluster"], ["cluster", "labels"], ["cluster", "breakdown"], ["api", "fund"], ["api", "kubectl"], ["desired", "fund"], ["desired", "kubectl"],
  ["labels", "imperative"], ["kubectl", "imperative"], ["imperative", "kubectl"], ["breakdown", "api"], ["staged", "desired"], ["pods", "worker"],
  ["services", "pods"], ["ingress", "services"], ["volumes", "pods"], ["helm", "kubectl"], ["ops", "api"], ["labels", "breakdown"],
];
for (const [from, to] of needs) relate(from, "depends-on", to);
relate("worker", "supports", "cluster");
relate("worker", "part-of", "staged");
conversations.worker.linkedConversationIds = ["desired", "api", "linux"];
conversations.kernel.linkedConversationIds = ["staged"];

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
const selected = params.get("select");
createRoot(document.getElementById("root")!).render(<main style={{ height: "100dvh", display: "flex", background: "var(--bg)" }}>
  <ConversationGraphView workspaceKey="map-calm-lines-preview" activeConversationId={selected ?? "worker"} conversations={conversations} groups={{}}
    isVisible jev={{ userId: "preview", enabled: false, ready: true }}
    focusRequest={{ conversationId: "worker", requestId: 1, neighborhoodDepth: 2 }}
    onActivateConversation={() => {}} onAssignGroup={() => {}} onCreateChildConversation={() => "worker"} onOpenConversation={() => {}}
    onToggleGroup={() => {}} onUpdateGraphNodeLayouts={() => {}} renderDockedConversation={(id) => <p style={{ padding: 16 }}>{conversations[id].title}</p>}
    renderExpandedConversation={(id) => <p>{conversations[id].title}</p>} />
</main>);
