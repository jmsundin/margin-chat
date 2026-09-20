import { useState } from "react";
import { createRoot } from "react-dom/client";
import AIResponseDetails from "../../client/src/components/AIResponseDetails";
import { applySemanticRouting, createSemanticRouteCandidates, planRoutes, routingReasonForAttempt } from "../../server/chat/routing.mjs";
import { routingReceipt } from "./aiRoutingDisclosureFixture";
import "../../client/src/styles.css";

// The route planner is pure: these synthetic inputs produce the same explanation
// text as production without loading configuration or making provider requests.
const request = { serviceId: "backend-services", modelId: "smart-routing", ai: { mode: "balanced" }, messages: [{ role: "user", content: "Compare the code alternatives and explain their tradeoffs." }] };
const routes = planRoutes(request, ["openai-api", "huggingface-api", "gemini-api"], {});
const candidates = createSemanticRouteCandidates(request, routes, {});
const jev = applySemanticRouting(request, routes, {}, { task: "coding", routeKey: "openai-api:gpt-6-astra" }, candidates)[0];
const taskRequest = { ...request, messages: [{ role: "user", content: "Explain this idea." }] };
const taskRoutes = planRoutes(taskRequest, ["huggingface-api"], {});
const taskMatch = applySemanticRouting(taskRequest, taskRoutes, {}, { task: "general" }, createSemanticRouteCandidates(taskRequest, taskRoutes, {}))[0];
const fallbackRoute = routes.find((route: { serviceId: string }) => route.serviceId === "gemini-api")!;
const failedAttempts = [{ provider: "openai-api", model: "gpt-6-astra", reason: "Provider temporarily unavailable" }];
const manual = planRoutes({ ...request, serviceId: "openai-api", modelId: "gpt-5.6-luna" }, ["openai-api"], {})[0];
const defaultReceipt = routingReceipt({ reason: jev.reason, profileVersion: jev.profileVersion });

const examples = [
  { title: "Jev selected the model", receipt: defaultReceipt },
  { title: "Jev matched the task", receipt: routingReceipt({
    model: "deepseek-ai/DeepSeek-V4.1-Flash", provider: "huggingface-api",
    routing: { method: "jev-task", selectedModel: "deepseek-ai/DeepSeek-V4.1-Flash" },
    task: taskMatch.task, reason: taskMatch.reason, profileVersion: taskMatch.profileVersion,
  }) },
  { title: "Standard routing with a fallback", receipt: routingReceipt({
    model: "gemini-3.8-flash", provider: "gemini-api", routing: { method: "rules", selectedModel: "gemini-3.8-flash" },
    reason: routingReasonForAttempt(fallbackRoute, failedAttempts), profileVersion: fallbackRoute.profileVersion,
    fallbacks: failedAttempts,
  }) },
  { title: "Selected by the user", receipt: routingReceipt({
    model: "gpt-5.6-luna", routing: { method: "manual", selectedModel: "gpt-5.6-luna" },
    reason: manual.reason, profileVersion: manual.profileVersion,
  }) },
  { title: "Live response", isStreaming: true, receipt: { ...defaultReceipt, status: "streaming" as const, completedAt: undefined } },
  { title: "Reopened partial response", receipt: { ...defaultReceipt, status: "streaming" as const, completedAt: undefined } },
  { title: "Provider-resolved model identifier", receipt: { ...defaultReceipt, model: "gpt-6-astra-2026-09-01" } },
  { title: "Older receipt with an unknown model", receipt: routingReceipt({ model: "experimental-model-name-that-is-not-in-the-current-picker-2026-09-19", routing: undefined }) },
];

function RoutingPreview() {
  const [dark, setDark] = useState(true);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  return <main style={{ height: "100dvh", overflow: "auto", background: "var(--bg)", color: "var(--ink)" }}>
    <header style={{ padding: "20px 24px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid var(--line)" }}>
      <strong>Model selection preview</strong>
      <span style={{ fontSize: 12, color: "var(--muted)" }}>Synthetic receipts · no account or provider requests</span>
      <button type="button" onClick={() => setDark((value) => !value)}>{dark ? "Light" : "Dark"} theme</button>
    </header>
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 16px", display: "grid", gap: 20 }}>
      {examples.map((example) => <article key={example.title} style={{ padding: 20, border: "1px solid var(--line)", borderRadius: 16, background: "var(--panel)", minWidth: 0 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 16px", color: "var(--muted)" }}>{example.title}</h2>
        <p style={{ margin: "0 0 16px", lineHeight: 1.7 }}>The design keeps the recommendation and its evidence together so the decision is easy to revisit.</p>
        <AIResponseDetails execution={example.receipt} isStreaming={example.isStreaming} />
      </article>)}
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<RoutingPreview />);
