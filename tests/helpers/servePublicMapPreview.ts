import { basename } from "node:path";

const build = await Bun.build({ entrypoints: [new URL("./publicMapPreview.tsx", import.meta.url).pathname], target: "browser", sourcemap: "inline", define: { "process.env.NODE_ENV": '"development"' } });
if (!build.success) { console.error(build.logs); process.exit(1); }
const assets = new Map(build.outputs.map((output) => [`/${basename(output.path)}`, output]));
const html = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Public map preview</title>${[...assets.keys()].filter((path) => path.endsWith(".css")).map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body style="margin:0"><div id="root"></div>${[...assets.keys()].filter((path) => path.endsWith(".js")).map((path) => `<script type="module" src="${path}"></script>`).join("")}</body></html>`;
let savedMap: unknown = null;
const answers: any[] = [{ id: "seed-answer", topicId: "Q7150", topicLabel: "Ecology", question: "How is ecology different from environmentalism?", mine: false, createdAt: "2026-10-08T12:00:00.000Z",
  answer: "Ecology is a science that studies how organisms interact with each other and their surroundings. Environmentalism is a social movement that advocates protecting the environment, and it often draws on ecological findings.",
  related: [{ id: "Q41179", label: "environmentalism", description: "broad philosophy, ideology and social movement", relation: "contrasted with" }] }];
const server = Bun.serve({ hostname: "127.0.0.1", port: 5182, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/api/graph/topic" && request.method === "POST") {
    // Synthetic drafts only: this fixture never calls a paid AI provider.
    await new Promise((resolve) => setTimeout(resolve, 700));
    return new Response(JSON.stringify({ type: "done", expansion: { nodes: [
      { id: "structure", parentId: null, title: "Structure and relationships", content: "Describe the parts of the system and how they affect one another." },
      { id: "feedback", parentId: null, title: "Feedback loops", content: "Explore how a change can feed back into the process that caused it." },
      { id: "reinforcing", parentId: "feedback", title: "Reinforcing feedback", content: "A reinforcing loop amplifies an initial change. Look for examples and limits." },
    ] } }) + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
  }
  // Synthetic shared answers and an in-memory saved map; no paid AI provider is called.
  if (path === "/api/public-map/state") {
    if (request.method === "PUT") { savedMap = (await request.json()).state; return Response.json({ revision: 1, updatedAt: new Date().toISOString() }); }
    return Response.json({ state: savedMap, revision: savedMap ? 1 : 0, updatedAt: null });
  }
  if (path === "/api/public-map/answers") {
    const topics = new URL(request.url).searchParams.getAll("topic");
    return Response.json({ answers: answers.filter((answer) => !topics.length || topics.includes(answer.topicId)) });
  }
  if (path === "/api/public-map/ask" && request.method === "POST") {
    const body = await request.json();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const answer = { id: crypto.randomUUID(), topicId: body.topic.id, topicLabel: body.topic.label, question: body.question, mine: true, createdAt: new Date().toISOString(),
      answer: `A synthetic answer about ${body.topic.label}. In the app, a paying member's question is answered by AI and shared with everyone.\n\nRelated topics below are joined to the map.`,
      related: [{ id: "Q37813", label: "ecosystem", description: "community of living organisms together with the nonliving components", relation: "studies" }, { id: "Q7239", label: "organism", description: "individual living entity", relation: "is about" }] };
    answers.unshift(answer);
    return new Response(`${JSON.stringify({ type: "progress", message: "Thinking about your question…" })}\n${JSON.stringify({ type: "done", answer })}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
  }
  if (path === "/api/graph/ask" && request.method === "POST") {
    const body = await request.json();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const answer = { question: body.question, answer: `A synthetic private answer about ${body.topic.label}. In the app, AI answers using your note as context, and only you see it.`,
      related: [{ id: "Q48255", label: "Ernst Haeckel", description: "German zoologist", relation: "named the field" }] };
    return new Response(`${JSON.stringify({ type: "progress", message: "Thinking about your question…" })}\n${JSON.stringify({ type: "done", answer })}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
  }
  if (path === "/api/web-search" && request.method === "POST") {
    // Synthetic results; the app uses Brave Search and charges the member's credit.
    const { query } = await request.json();
    return Response.json({ query, chargedMicros: 10_000, results: [
      { title: `${query} — an introduction`, url: "https://example.org/intro", description: `A synthetic web result about ${query}.`, siteName: "example.org", age: "3 days ago" },
      { title: `Recent research on ${query}`, url: "https://example.com/research", description: "Another synthetic result standing in for Brave Search.", siteName: "example.com" },
    ] });
  }
  if (path === "/") return new Response(html, { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
  const asset = assets.get(path); return asset ? new Response(asset) : new Response("Not found", { status: 404 });
} });
console.log(`Public map preview: ${server.url}`);
