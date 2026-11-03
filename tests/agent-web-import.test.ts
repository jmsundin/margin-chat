import { afterEach, describe, expect, test } from "bun:test";
import { gitHubLocation, importWebSection, markdownLinks, readImportPage, sectionLinks } from "../server/chat/agent/webImport.mjs";
import { agentToolDefinitions, createAgentToolExecutor, describeAgentStep } from "../server/chat/agent/tools.mjs";
import { runAgent } from "../server/chat/agent/runner.mjs";
import { buildAgentInstruction } from "../server/chat/systemPrompt.mjs";
import { HttpError } from "../server/lib/errors.mjs";
import { createEmptyState, createMainConversation } from "../client/src/initialState";
import { addImportedWebDocuments, documentWikiTarget, importedSourceUrl } from "../client/src/lib/webImportDocuments";
import { importedImageSources, remoteImages, replaceRemoteImages, saveImportedImages } from "../client/src/lib/webImportImages";
import { createDocumentLinkResolver } from "../client/src/lib/documentRelations";
import { getDocumentKind, getPresentedParentId } from "../client/src/lib/documentBreadcrumbs";
import { getEditableDocument } from "../client/src/lib/editableDocument";
import { readChatReplyStream } from "../client/src/lib/chatStream";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const REPO = "https://github.com/acme/notes";
const repoHtml = `<html><body><a href="/acme/notes/tree/main/01.%20Scaling">01. Scaling</a>
<a href="/acme/notes/blob/main/Readme.md">Readme.md</a><a href="/acme/notes/blob/main/.gitignore">.gitignore</a></body></html>`;
const readme = `# [Notes on scale](https://example.com/book)
These notes cover the book. See <https://other.example/x>.

 * [Chapter 1 - Scaling](./01.%20Scaling/)
 * [Chapter 2 - Estimation](./02.%20Estimation//)
 * [Contributing](CONTRIBUTING.md)
 * [Logo](./logo.png)
`;
const chapterHtml = (folder: string) => `<html><body><a href="/acme/notes/blob/main/${folder}/README.md">README.md</a>
<a href="/acme/notes/blob/main/${folder}/images/a.png">a.png</a></body></html>`;
const files: Record<string, string> = {
  [`${REPO}`]: repoHtml,
  "https://raw.githubusercontent.com/acme/notes/main/Readme.md": readme,
  "https://github.com/acme/notes/tree/main/01.%20Scaling": chapterHtml("01.%20Scaling"),
  "https://raw.githubusercontent.com/acme/notes/main/01.%20Scaling/README.md": "# Scaling\n\nStart with one server.\n\n<div style=\"margin-left:2rem\"> <img src=\"images/a.png\" width=\"400\" /> </div>\n\nMore in [load balancing](./balancing.md) and [caching](./caching.md).\n",
  "https://github.com/acme/notes/tree/main/02.%20Estimation": chapterHtml("02.%20Estimation"),
  "https://raw.githubusercontent.com/acme/notes/main/02.%20Estimation/README.md": "# Estimation\n\nPowers of two.\n",
  "https://raw.githubusercontent.com/acme/notes/main/CONTRIBUTING.md": "# Contributing\n\nOpen a pull request.\n",
  "https://raw.githubusercontent.com/acme/notes/main/01.%20Scaling/balancing.md": "# Load balancing\n\nSpread requests.\n",
  "https://raw.githubusercontent.com/acme/notes/main/01.%20Scaling/caching.md": "# Caching\n\nKeep hot data close.\n",
};
const fetched: string[] = [];
const fetchPage = async (url: string) => {
  fetched.push(url);
  if (!(url in files)) throw new HttpError(422, "The webpage returned 404. Try another public page.");
  return { url, contentType: url.includes("raw.") ? "text/plain" : "text/html", html: files[url] };
};
const readImport = (url: string) => readImportPage(url, { fetchPage });

describe("reading GitHub repositories", () => {
  test("recognizes repositories, folders and files", () => {
    expect(gitHubLocation("https://github.com/acme/notes")).toEqual({ owner: "acme", repo: "notes", kind: "repo", branch: null, path: "" });
    expect(gitHubLocation("https://github.com/acme/notes/tree/main/01.%20Scaling")).toMatchObject({ kind: "tree", branch: "main", path: "01.%20Scaling" });
    expect(gitHubLocation("https://github.com/acme/notes/issues/4")).toBeNull();
    expect(gitHubLocation("https://github.com/orgs/acme")).toBeNull();
    expect(gitHubLocation("https://example.com/acme/notes")).toBeNull();
  });

  test("reads a repository's README from the raw file, with its links and images made absolute", async () => {
    const page = await readImport(REPO);
    expect(page.title).toBe("Notes on scale");
    expect(page.markdown).toContain("[Chapter 1 - Scaling](https://github.com/acme/notes/tree/main/01.%20Scaling)");
    expect(page.markdown).toContain("[Chapter 2 - Estimation](https://github.com/acme/notes/tree/main/02.%20Estimation)");
    expect(page.markdown).toContain("[Contributing](https://github.com/acme/notes/blob/main/CONTRIBUTING.md)");
    expect(sectionLinks(page).map((link) => link.label)).toEqual(["Chapter 1 - Scaling", "Chapter 2 - Estimation", "Contributing"]);
    const chapter = await readImport("https://github.com/acme/notes/tree/main/01.%20Scaling");
    expect(chapter.markdown).toContain("![](https://raw.githubusercontent.com/acme/notes/main/01.%20Scaling/images/a.png)");
    expect(chapter.markdown).not.toContain("<div");
  });

  test("finds Markdown links, but not images", () => {
    expect(markdownLinks("[a](https://x.org/a) ![b](https://x.org/b.png) <a href=\"https://x.org/c\">C</a>"))
      .toEqual([{ url: "https://x.org/a", label: "a" }, { url: "https://x.org/c", label: "C" }]);
  });

  test("only pages in the same site section count as its children", () => {
    const page = { url: "https://docs.example.com/book/", title: "Book", markdown: "", links: [
      { url: "https://docs.example.com/book/ch1", label: "Chapter 1" }, { url: "https://docs.example.com/book/ch1#part", label: "again" },
      { url: "https://docs.example.com/blog/post", label: "Blog" }, { url: "https://elsewhere.org/book/ch2", label: "Elsewhere" },
      { url: "https://docs.example.com/book/cover.png", label: "Cover" }] };
    expect(sectionLinks(page)).toEqual([{ url: "https://docs.example.com/book/ch1", label: "Chapter 1" }]);
    expect(sectionLinks({ ...page, url: "https://docs.example.com/book/index.html" })).toEqual([{ url: "https://docs.example.com/book/ch1", label: "Chapter 1" }]);
    // An article's links to other articles are not its chapters.
    expect(sectionLinks({ ...page, url: "https://en.wikipedia.org/wiki/Tree", links: [{ url: "https://en.wikipedia.org/wiki/Leaf", label: "Leaf" }] })).toEqual([]);
  });
});

describe("importing a section", () => {
  test("level 1 saves the README and every chapter it links to, and counts what one level deeper would add", async () => {
    const result = await importWebSection(REPO, { levels: 1, readImport });
    expect(result.documents.map((document) => [document.level, document.title, document.parentUrl])).toEqual([
      [0, "Notes on scale", null],
      [1, "Chapter 1 - Scaling", REPO], [1, "Chapter 2 - Estimation", REPO], [1, "Contributing", REPO],
    ]);
    expect(result.documents[1].markdown.startsWith("Source: <https://github.com/acme/notes/tree/main/01.%20Scaling>\n\n# Scaling")).toBe(true);
    expect(result.deeper).toEqual({ pages: 2, fromDocuments: 1 });
  });

  test("level 2 follows the chapters' own links; level 0 saves only the page", async () => {
    const deeper = await importWebSection(REPO, { levels: 2, readImport });
    expect(deeper.documents.slice(4).map((document) => [document.title, document.parentUrl]))
      .toEqual([["load balancing", "https://github.com/acme/notes/tree/main/01.%20Scaling"], ["caching", "https://github.com/acme/notes/tree/main/01.%20Scaling"]]);
    expect(deeper.deeper.pages).toBe(0);
    const only = await importWebSection(REPO, { levels: 0, readImport });
    expect(only.documents).toHaveLength(1);
    expect(only.deeper.pages).toBe(3);
  });

  test("a page that can't be read is reported, and the import stops at its page limit", async () => {
    const result = await importWebSection(REPO, { levels: 1, maxPages: 2, readImport: (url: string) => url.includes("01.") ? Promise.reject(new HttpError(422, "Gone")) : readImport(url) });
    expect(result.documents.map((document) => document.title)).toEqual(["Notes on scale"]);
    expect(result.failed).toEqual([{ url: "https://github.com/acme/notes/tree/main/01.%20Scaling", error: "Gone" }]);
    expect(result.skipped).toBe(2);
  });
});

const request = (content: string) => ({
  ai: { mode: "balanced", contextScope: "conversation", selectedConversationIds: [] },
  conversation: { id: "chat", title: "Chat", messages: [], ancestorContext: [] },
  messages: [{ role: "user", content }],
  workspaceContext: [],
});

describe("import_webpage", () => {
  test("is offered only to callers that create documents, with instructions to ask before going deeper", () => {
    const names = (documents: boolean) => agentToolDefinitions(request(`Save ${REPO}`), null, { documents }).map((tool: any) => tool.name);
    expect(names(false)).not.toContain("import_webpage");
    expect(names(true)).toContain("import_webpage");
    expect(buildAgentInstruction(request(`Save ${REPO}`), { documents: true })).toContain("Never go more than one level of links below the pasted page without the user's yes");
    expect(buildAgentInstruction(request(`Save ${REPO}`))).not.toContain("import_webpage");
  });

  test("sends the pages to the caller and tells the model only what was saved", async () => {
    const sent: any[] = [];
    const run = createAgentToolExecutor({ chatRequest: request(`Make documents from ${REPO}`), onDocuments: async (documents: any) => { sent.push(...documents); },
      importSection: (url: string, options: any) => importWebSection(url, { ...options, readImport }) });
    const output: any = await run("import_webpage", { url: REPO, levels: 1 });
    expect(sent.map((document) => document.title)).toEqual(["Notes on scale", "Chapter 1 - Scaling", "Chapter 2 - Estimation", "Contributing"]);
    expect(output).toMatchObject({ ok: true, title: "Notes on scale", saved: 4, levels: 1, deeper: { pages: 2, from_documents: 1, next_levels: 2 } });
    expect(JSON.stringify(output)).not.toContain("Start with one server");
    expect(describeAgentStep("import_webpage", { url: REPO }, output))
      .toEqual({ kind: "tool", tool: "import_webpage", label: "Saved “Notes on scale” and 3 linked pages as documents", detail: "github.com", ok: true });
    const refused: any = await run("import_webpage", { url: "https://github.com/someone/else", levels: 1 });
    expect(refused).toMatchObject({ ok: false });
  });

  test("an agent run streams the saved pages before it answers", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Response.json(bodies.length === 1
        ? { output: [{ type: "function_call", name: "import_webpage", call_id: "call_1", arguments: JSON.stringify({ url: REPO, levels: 1 }) }] }
        : { output_text: `Saved 4 documents. Two pages link further. Want me to go one level deeper into ${REPO}?`, output: [] });
    }) as typeof fetch;
    const events: string[] = [];
    const result = await runAgent({ provider: "openai", apiKey: "sk", chatRequest: request(`Import ${REPO}`), model: "gpt",
      systemInstruction: "Help.", maxOutputTokens: 500, maxInputCharacters: 48_000, usageMeter: null,
      importSection: (url: string, options: any) => importWebSection(url, { ...options, readImport }),
      onDocuments: async (documents: any[]) => { events.push(`documents:${documents.length}`); },
      onStep: async ({ step }: any) => { events.push(`step:${step.tool}`); }, onDelta: async () => { events.push("answer"); } });
    expect(events).toEqual(["documents:4", "step:import_webpage", "answer"]);
    expect(bodies[0].tools.map((tool: any) => tool.name)).toContain("import_webpage");
    expect(result.reply).toContain("one level deeper");
  });
});

describe("imported pages in the workspace", () => {
  const date = "2026-10-15T00:00:00.000Z";
  let counter = 0;
  const createId = (prefix: string) => `${prefix}-${++counter}`;
  const workspace = () => {
    const main = createMainConversation({ id: "main", createdAt: date });
    main.document = getEditableDocument(main);
    return { ...createEmptyState(), rootId: main.id, activeConversationId: main.id, conversations: { [main.id]: main } };
  };

  test("the page is a side document and each linked page a closed child anchored to its link", async () => {
    const { documents } = await importWebSection(REPO, { levels: 1, readImport });
    const { state, createdIds } = addImportedWebDocuments(workspace(), "main", documents, { createId, now: date });
    expect(createdIds).toHaveLength(4);
    const [rootId, chapterId] = createdIds;
    const root = state.conversations[rootId];
    const chapter = state.conversations[chapterId];
    expect(root.parentId).toBe("main");
    expect(getDocumentKind(root)).toBe("side");
    expect(importedSourceUrl(root)).toBe(REPO);
    expect(chapter.parentId).toBe(rootId);
    expect(getDocumentKind(chapter)).toBe("branch");
    expect(getPresentedParentId(state.conversations, chapterId)).toBe(rootId);
    expect(chapter.branchAnchor?.quote).toBe("Chapter 1 - Scaling");
    // The page's link now opens the saved chapter, by its file name, in Margin Chat and Obsidian.
    const rootText = getEditableDocument(root).blocks.map((block) => block.content).join("\n");
    expect(rootText).toContain(`[[${documentWikiTarget(chapter)}|Chapter 1 - Scaling]]`);
    expect(rootText).not.toContain("01.%20Scaling");
    expect(createDocumentLinkResolver(state.conversations)(documentWikiTarget(chapter))).toBe(chapterId);
    expect(getEditableDocument(chapter).blocks.map((block) => block.content).join("\n")).toContain("Start with one server.");
  });

  test("going deeper adds only the new pages, under the chapters saved before", async () => {
    const first = addImportedWebDocuments(workspace(), "main", (await importWebSection(REPO, { levels: 1, readImport })).documents, { createId, now: date });
    const chapterId = first.createdIds[1];
    const second = addImportedWebDocuments(first.state, "main", (await importWebSection(REPO, { levels: 2, readImport })).documents, { createId, now: date });
    expect(second.createdIds).toHaveLength(2);
    expect(second.createdIds.map((id) => second.state.conversations[id].parentId)).toEqual([chapterId, chapterId]);
  });
});

describe("an imported X thread in the workspace", () => {
  const date = "2026-11-03T00:00:00.000Z";
  let counter = 0;
  const createId = (prefix: string) => `${prefix}-${++counter}`;
  const workspace = () => {
    const main = createMainConversation({ id: "main", createdAt: date });
    main.document = getEditableDocument(main);
    return { ...createEmptyState(), rootId: main.id, activeConversationId: main.id, conversations: { [main.id]: main } };
  };
  const thread = {
    url: "https://x.com/hesamation/status/1", parentUrl: null, title: "Hesam: a visual explainer",
    markdown: "Source: <https://x.com/hesamation/status/1>\n\nA visual explainer:\n\n![](https://pbs.twimg.com/media/a.jpg?name=orig)\n\n> Quoting [@DeepSeekHarness](https://x.com/DeepSeekHarness/status/2):\n>\n> Article: **Super-agent**",
  };
  const article = {
    url: "https://x.com/DeepSeekHarness/status/2", parentUrl: "https://x.com/hesamation/status/1", title: "Super-agent",
    markdown: "Source: <https://x.com/DeepSeekHarness/status/2>\n\n## Super-agent\n\n![The two levels](https://pbs.twimg.com/media/b.jpg)\n\n*The two levels*\n\n![badge](https://img.shields.io/badge/x.svg)",
  };

  test("the quoted post becomes a child document the thread links to with a wiki link", () => {
    const { state, createdIds } = addImportedWebDocuments(workspace(), "main", [thread, article], { createId, now: date });
    const [threadId, articleId] = createdIds;
    const saved = state.conversations[articleId];
    expect(saved.parentId).toBe(threadId);
    const text = getEditableDocument(state.conversations[threadId]).blocks.map((block) => block.content).join("\n\n");
    expect(text).toContain(`> Quoting [[${documentWikiTarget(saved)}|@DeepSeekHarness]]:`);
    expect(saved.branchAnchor?.quote).toBe("@DeepSeekHarness");
    // A second import of the thread under another link reuses the saved copy.
    const again = addImportedWebDocuments(state, "main", [{ ...thread, url: "https://twitter.com/hesamation/status/1/" }, { ...article, url: "https://x.com/i/status/2" }], { createId, now: date });
    expect(again.createdIds).toEqual([]);
  });

  test("pictures are saved into the vault and the documents show the saved copies", async () => {
    const { state, createdIds } = addImportedWebDocuments(workspace(), "main", [thread, article], { createId, now: date });
    expect(remoteImages(article.markdown).map((image) => image.url)).toEqual(["https://pbs.twimg.com/media/b.jpg"]);
    const savedFiles: File[] = [];
    let current = state;
    const result = await saveImportedImages({
      documents: importedImageSources(state, createdIds),
      update: (change) => { current = change(current); },
      media: { save: async (file: File) => { savedFiles.push(file); return `![[${file.name}]]`; } },
      fetchImage: async (url: string) => {
        if (url.includes("a.jpg")) throw new Error("offline");
        return new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
      },
    });
    expect(result).toEqual({ saved: 1, failed: 1 });
    expect(savedFiles.map((file) => [file.name, file.type])).toEqual([["Super-agent 1.jpg", "image/jpeg"]]);
    const text = (id: string) => getEditableDocument(current.conversations[id]).blocks.map((block) => block.content).join("\n\n");
    expect(text(createdIds[1])).toContain("![[Super-agent 1.jpg|The two levels]]");
    expect(text(createdIds[1])).toContain("![badge](https://img.shields.io/badge/x.svg)");
    // A picture that couldn't be downloaded keeps its web link.
    expect(text(createdIds[0])).toContain("![](https://pbs.twimg.com/media/a.jpg?name=orig)");
    expect(replaceRemoteImages("![](https://a.example/x.png)", new Map([["https://a.example/x.png", "![[x.png]]"]]))).toBe("![[x.png]]");
  });
});

test("the browser receives saved pages from the chat stream", async () => {
  const lines = [
    { type: "metadata", metadata: { model: "gpt", requestedServiceId: "openai", resolvedServiceId: "openai" } },
    { type: "documents", documents: [{ url: REPO, parentUrl: null, title: "Notes", markdown: "Source: <x>" }, { url: "javascript:alert(1)", title: "Bad", markdown: "" }] },
    { type: "delta", delta: "Saved." },
    { type: "done" },
  ].map((line) => `${JSON.stringify(line)}\n`).join("");
  const events: any[] = [];
  await readChatReplyStream(new Response(lines).body!, undefined, undefined, (event) => events.push(event));
  expect(events).toEqual([{ type: "documents", documents: [{ url: REPO, parentUrl: null, title: "Notes", markdown: "Source: <x>" }] }]);
});
