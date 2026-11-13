/**
 * Markdown files for a FastAPI roadmap with sub-roadmaps two levels deep, for trying the
 * roadmap layouts in the browser fixture (scripts/test-vault-preview.mjs):
 *   bun tests/helpers/roadmapLayoutsSeed.ts http://127.0.0.1:5200
 * posts each file with { action: "remote" }.
 */
import { createEmptyState, createStandaloneNoteConversation } from "../../client/src/initialState";
import { createMarkdownWorkspace } from "../../client/src/lib/workspaceMarkdown";
import { makeRoadmapDocument } from "../../client/src/lib/roadmap";
import type { AppState, Roadmap, RoadmapStatus } from "../../client/src/types";

const at = "2026-11-13T05:00:00.000Z";
type Step = [title: string, status?: RoadmapStatus, needs?: string[]];
type Plan = { title: string; stages: [string, Step[]][] };
const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const plans: Plan[] = [
  { title: "FastAPI", stages: [
    ["Start here", [["Python Basics", "done"], ["Web Concepts", "learning"]]],
    ["FastAPI Core", [["Path Operations", undefined, ["Web Concepts"]], ["Request Validation"], ["Dependency Injection"], ["Response Models"]]],
    ["Database Integration", [["SQL Databases", undefined, ["Dependency Injection"]], ["NoSQL Databases"], ["Database Migrations"], ["ORM Advanced"]]],
    ["Security", [["OAuth2 and JWT", undefined, ["Dependency Injection"]], ["CORS"], ["Rate limiting"]]],
    ["Advanced Features", [["Background Tasks", undefined, ["Path Operations"]], ["Websockets"], ["Events and Lifespan"]]],
    ["Testing and Deployment", [["Testing Basics", undefined, ["Response Models", "SQL Databases"]], ["Docker"], ["Deploying", undefined, ["OAuth2 and JWT"]]]],
  ] },
  { title: "Web Concepts", stages: [
    ["Protocol", [["HTTP protocol basics", "learning"], ["Request methods"], ["Response status codes"]]],
    ["Data", [["Headers and parameters", undefined, ["Request methods"]], ["JSON data format"]]],
    ["Design", [["Client server architecture", undefined, ["Response status codes", "JSON data format"]], ["REST principles"]]],
  ] },
  { title: "HTTP protocol basics", stages: [
    ["Messages", [["Request line", "done"], ["Headers"], ["Body"]]],
    ["Connections", [["TCP and TLS", undefined, ["Request line"]], ["Keep-alive"]]],
  ] },
  { title: "SQL Databases", stages: [
    ["Basics", [["Tables and keys"], ["Queries and joins"]]],
    ["With FastAPI", [["SQLAlchemy sessions", undefined, ["Queries and joins"]], ["Async drivers"]]],
  ] },
];

export function roadmapLayoutsState(): AppState {
  const state = createEmptyState();
  const note = (title: string) => {
    const id = slug(title);
    if (!state.conversations[id]) {
      const conversation = createStandaloneNoteConversation({ createdAt: at, id, noteId: `${id}-note` });
      conversation.title = title;
      state.conversations[id] = conversation;
    }
    return id;
  };
  for (const plan of plans) {
    const id = note(plan.title);
    const nodeId = (title: string) => `n-${slug(title)}`;
    const roadmap: Roadmap = { version: 1, stages: plan.stages.map(([title]) => ({ id: `s-${slug(title)}`, title })), nodes: [] };
    for (const [stage, steps] of plan.stages) steps.forEach(([title, status, needs], index) => {
      roadmap.nodes.push({ id: nodeId(title), target: { docId: note(title) }, stage: `s-${slug(stage)}`, order: index,
        ...(status ? { status } : {}),
        dependsOn: [...(needs ?? []).map(nodeId), ...(index > 0 ? [nodeId(steps[index - 1][0])] : [])] });
    });
    state.conversations[id] = { ...makeRoadmapDocument(state.conversations[id], at), roadmap };
  }
  return state;
}

if (import.meta.main) {
  const base = process.argv[2] ?? "http://127.0.0.1:5200";
  const { files } = createMarkdownWorkspace(roadmapLayoutsState(), at);
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".md")) continue;
    const response = await fetch(`${base}/api/fixture`, { method: "POST", headers: { "content-type": "application/json", "x-margin-test-fixture": "1" },
      body: JSON.stringify({ action: "remote", path, content }) });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  }
  console.log(`seeded ${Object.keys(files).filter((path) => path.endsWith(".md")).length} documents`);
}
