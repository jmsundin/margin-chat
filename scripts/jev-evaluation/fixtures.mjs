import { createHash } from "node:crypto";
import { createSemanticService } from "../../server/semantic/index.mjs";
import { createSemanticRouteCandidates, planRoutes } from "../../server/chat/routing.mjs";

export const PINNED_MODEL = "jev-1.13.0";
export const EVALUATION_VERSION = "margin-jev-synthetic-2026-09-26.1";
// Review changed builders/fixtures and bump the evaluation version before updating this pin.
// Catalog refresh: GPT-6 Sol/Luna and Grok 4.7 update the captured route candidates.
export const PINNED_SUITE_FINGERPRINT = "c57759af81c002faaf197c4ebd3c11cc71ed83923957c0d5418e6677555b77d4";
export const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function assertPinnedSuiteFingerprint(actual) {
  if (actual !== PINNED_SUITE_FINGERPRINT) throw new Error("Application questions changed from the pinned evaluation suite. Review the fixtures, bump EVALUATION_VERSION, and update PINNED_SUITE_FINGERPRINT before --live. No requests were sent.");
}

const examples = [
  { task: "writing", prompt: "Rewrite our launch announcement as a warm, concise email. Keep it under 120 words and preserve the September 30 launch date.", context: "Launch announcement draft: On September 30 we are opening our collaborative notebook to all customers. The email should sound welcoming and avoid jargon." },
  { task: "coding", prompt: "Fix this JavaScript bug and show the corrected function: async function load() { return fetch('/items').json(); }", context: "The load function must await the fetch Response before calling response.json(). Check response.ok and throw for failed HTTP requests." },
  { task: "research", prompt: "Research whether heat pumps reduce household emissions compared with gas boilers. Compare independent sources and cite evidence, including grid intensity assumptions.", context: "Heat-pump research notes: compare seasonal coefficient of performance, regional electricity carbon intensity, upstream methane leakage, and peer-reviewed lifecycle studies." },
  { task: "reasoning", prompt: "Prove by mathematical induction that the sum of the first n odd positive integers is n squared. Show the base case and inductive step.", context: "Prior proof plan: S(n) = 1+3+...+(2n-1). The next odd term is 2n+1, so S(n+1)=n squared+2n+1=(n+1) squared." },
  { task: "summary", prompt: "Summarize the project decisions into three short bullets without adding recommendations.", context: "Project decisions: launch September 30; start with existing customers; keep support coverage during the launch. The team approved all three decisions." },
  { task: "general", prompt: "Hello! Nice to meet you.", context: "A note about a separate database migration that has nothing to do with a greeting.", noRelevantContext: true },
  { id: "research-current", task: "research", prompt: "Research the current New York subway fare as of today and cite the transit agency's latest fare notice.", context: "A separate recipe for banana bread that has no information about transit fares.", noRelevantContext: true, needsCurrentInformation: true },
];

function captureAnswer(question) {
  if (question.type === "noul") return { type: "noul", noul: 0 };
  const keys = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  return { type: question.type, confidence: 1, probabilities: Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0])),
    ...(question.type === "choice" ? { choice: keys[0] } : { score: 0, legend: Object.fromEntries(question.criteria.map((value, index) => [String(index), value])) }) };
}

async function captureRequests(run) {
  const requests = [];
  const semantic = createSemanticService({
    env: { TYPESAFE_AI_JEV_API_KEY: "synthetic-capture-only", TYPESAFE_MODEL: PINNED_MODEL },
    onUsage() {}, onMetric() {},
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      return Response.json({ model: PINNED_MODEL, answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, captureAnswer(question)])),
        usage: { input_tokens: 0, output_tokens: 0 } });
    },
  });
  await run(semantic);
  if (!requests.length) throw new Error("Synthetic scenario did not produce any application questions.");
  return requests;
}

function describeQuestion(request, id, expectation = {}) {
  const definition = request.questions[id];
  return { ...(definition.type !== "noul" ? { minimumConfidence: definition.type === "choice" ? 0.55 : 0.35 } : {}), ...expectation };
}

/** Capture real application builders with a mock boundary; never read user data or make network calls. */
export async function buildScenarios() {
  const scenarios = [];
  for (const example of examples) {
    const request = {
      serviceId: "backend-services", modelId: "smart-routing",
      ai: { jevEnabled: true, mode: "balanced", contextScope: "workspace", selectedConversationIds: [] },
      conversation: { id: "current", title: "Example request", ancestorContext: [] },
      messages: [{ role: "user", content: example.prompt }],
      workspaceContext: [
        { id: "unrelated", title: "Weekend grocery list", content: "Buy milk, bread, bananas, and dish soap." },
        { id: "relevant", title: "Prior work on this request", content: example.context },
      ],
    };
    const routes = planRoutes(request, ["openai-api", "gemini-api", "huggingface-api", "xai-api"], {});
    const candidates = createSemanticRouteCandidates(request, routes, {});
    const requests = await captureRequests((semantic) => semantic.analyzeChat({ chatRequest: request, routes: candidates, userId: "synthetic-evaluation" }));
    const expectations = {};
    requests.forEach((body, batch) => {
      for (const id of Object.keys(body.questions)) {
        let expected;
        if (id === "task") expected = { domain: "intent", choices: [example.task] };
        else if (id === "route") expected = { domain: "routing", choices: ["keep_default", ...candidates.filter((candidate) => candidate.tasks.includes(example.task)).map((candidate) => candidate.key)] };
        else if (id === "complexity") expected = { domain: "complexity", minimumScore: ["research", "reasoning"].includes(example.task) ? 1 : 0, maximumScore: example.task === "general" ? 1 : 3 };
        else if (id === "needsCurrentInformation") expected = { domain: "freshness", ...(example.needsCurrentInformation ? { minimumNoul: 0.65 } : { maximumNoul: 0.35 }) };
        else if (id.startsWith("context_")) {
          const candidate = body.state.candidates[Number(id.slice("context_".length))];
          expected = { domain: "context", ...(candidate.id === "relevant" && !example.noRelevantContext ? { minimumScore: 2 } : { maximumScore: 1 }) };
        }
        if (!expected) throw new Error(`Unmapped synthetic chat question: ${id}`);
        expectations[`${batch}:${id}`] = describeQuestion(body, id, expected);
      }
    });
    scenarios.push({ id: `chat-${example.id ?? example.task}`, requests, expectations });
  }
  const items = [
    { id: "bug", kind: "chat", title: "Fix async data loading", content: examples[1].prompt },
    { id: "solution", kind: "note", title: "Fetch response fix", content: examples[1].context },
    { id: "email", kind: "note", title: "Launch email draft", content: examples[0].context },
    { id: "evidence", kind: "chat", title: "Heat pump evidence review", content: examples[2].prompt },
    { id: "groceries", kind: "note", title: "Groceries", content: "Buy milk, bread, and bananas for the family this weekend." },
  ];
  const categories = { bug: "coding", solution: "coding", email: "writing", evidence: "research", groceries: "personal" };
  const groups = [
    { id: "loader-repair", name: "Async data loader repair", memberTitles: ["Fetch response handling", "Data loader tests"] },
    { id: "heat-pumps", name: "Heat pump evidence", memberTitles: ["Seasonal efficiency studies", "Electricity carbon intensity"] },
  ];
  for (const grouped of [false, true]) {
    const requests = await captureRequests((semantic) => semantic.analyzeWorkspace({ userId: "synthetic-evaluation",
      payload: { enabled: true, items, current: items[0], ...(grouped ? { groups } : {}) } }));
    const expectations = {};
    requests.forEach((body, batch) => {
      for (const id of Object.keys(body.questions)) {
        const index = Number(id.split("_").at(-1));
        const item = body.state.items[index];
        const original = items.find((entry) => entry.id === item.id || entry.title === item.title);
        if (!original) throw new Error("Unmapped synthetic workspace item.");
        let expected;
        if (id.startsWith("category_")) expected = { domain: "category", choices: [categories[original.id]] };
        else if (id.startsWith("related_")) expected = { domain: "related", ...(original.id === "solution" ? { minimumScore: 2 } : { maximumScore: 1 }) };
        else if (id.startsWith("group_")) {
          const groupName = ["bug", "solution"].includes(original.id) ? groups[0].name : original.id === "evidence" ? groups[1].name : null;
          const groupIndex = body.state.groups.findIndex((group) => group.name === groupName);
          expected = { domain: "group", choices: [groupIndex >= 0 ? `g${groupIndex}` : "none"], minimumConfidence: 0.75 };
        }
        if (!expected) throw new Error(`Unmapped synthetic workspace question: ${id}`);
        expectations[`${batch}:${id}`] = describeQuestion(body, id, expected);
      }
    });
    scenarios.push({ id: grouped ? "workspace-groups-and-no-match" : "workspace-categories-related", requests, expectations });
  }
  // Freeze a snapshot once per run: every strategy receives these exact states and questions.
  return scenarios.map((scenario) => ({ ...scenario, promptFingerprint: fingerprint(scenario.requests) }));
}
