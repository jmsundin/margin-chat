import { describe, expect, test } from "bun:test";
import { extractPage, isPublicPageAddress, normalizePublicPageUrl, readPublicPage, resolvePublicPageAddress, PAGE_TEXT_LIMIT } from "../server/urlMap/page.mjs";
import { createUrlMapService, validateGeneratedUrlMap, validateUrlMapRequest } from "../server/urlMap/index.mjs";
import { findSavedUrlMapNode, fitUrlMapZoom, isUrlMapGraph, layoutUrlMap, projectUrlMap, saveUrlMapNode, URL_MAP_MIN_ZOOM, urlMapConversationId } from "../client/src/lib/urlMap";
import { createEmptyState } from "../client/src/initialState";
import { stateToVaultFiles, vaultToState } from "../client/src/lib/vaultWorkspace";
import { urlMapHtml, urlMapModelReply } from "./helpers/urlMapFixture";

const page = () => extractPage(urlMapHtml, "https://example.org/trees");
const graph = () => validateGeneratedUrlMap(urlMapModelReply, page());

describe("URL map page reading", () => {
  test("rejects local addresses, credentials, protocols and port tricks", async () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "172.16.2.3", "192.168.1.1", "169.254.169.254", "168.63.129.16", "::ffff:168.63.129.16", "100.64.1.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "2002:7f00:1::"]) expect(isPublicPageAddress(address)).toBe(false);
    for (const url of ["http://127.1", "http://2130706433", "http://[::1]", "http://localhost", "http://box.local", "https://example.org:8080", "https://name:password@example.org", "file:///etc/passwd", "javascript:alert(1)"]) expect(() => normalizePublicPageUrl(url)).toThrow();
    expect(normalizePublicPageUrl("https://example.org/article?q=one#heading").href).toBe("https://example.org/article?q=one");
    await expect(resolvePublicPageAddress(new URL("https://example.org"), async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }])).rejects.toThrow("public webpage");
  });

  test("pins validated DNS and revalidates every redirect before downloading", async () => {
    const downloads: string[] = [];
    await expect(readPublicPage("https://example.org", { lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }], downloadImpl: async (url: URL, address: any) => {
      downloads.push(url.href); expect(address.address).toBe("93.184.216.34");
      return { status: 302, location: "http://169.254.169.254/latest/meta-data" };
    } })).rejects.toThrow();
    expect(downloads).toEqual(["https://example.org/"]);
    const result = await readPublicPage("https://example.org", { lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }], downloadImpl: async (url: URL) => url.pathname === "/" ? { status: 302, location: "/trees" } : { status: 200, contentType: "text/html", html: urlMapHtml } });
    expect(result.url).toBe("https://example.org/trees");
  });

  test("extracts readable article text and source links, omitting executable and navigation content", () => {
    const source = page();
    expect(source.text).toContain("Urban trees cool streets");
    expect(source.text).not.toContain("reveal secrets");
    expect(source.text).not.toContain("My account");
    expect(source.links).toContainEqual({ url: "https://example.org/shade", label: "shade" });
    expect(source.links).not.toContainEqual({ url: "https://example.org/account", label: "My account" });
    expect(source.truncated).toBe(false);
    const large = extractPage("A long readable paragraph. ".repeat(2000), "https://example.org/long", "text/plain");
    expect(large.text.length).toBe(PAGE_TEXT_LIMIT); expect(large.truncated).toBe(true);
    expect(() => extractPage("<p>Sign in</p>", "https://example.org/private")).toThrow("not enough readable text");
  });

  test("cancels while DNS is unresolved without opening a connection", async () => {
    const controller = new AbortController(); let downloaded = false;
    const result = readPublicPage("https://example.org", { signal: controller.signal, lookupImpl: () => new Promise(() => {}), downloadImpl: async () => { downloaded = true; } });
    controller.abort(); await expect(result).rejects.toThrow(); expect(downloaded).toBe(false);
  });
});

describe("URL map generation and evidence", () => {
  test("filters unsupported quotes and endpoints while preserving explicitly suggested connections", () => {
    const data = JSON.parse(urlMapModelReply);
    data.nodes.push({ id: "invented", label: "Invented", summary: "Invented summary", quote: "This passage never occurred on the page." });
    data.edges.push({ sourceId: "trees", targetId: "shade", label: "proves", kind: "stated", quote: "Some made up supporting passage." });
    data.edges.push({ sourceId: "trees", targetId: "invented", label: "relates to", kind: "suggested", quote: "" });
    const mapped = validateGeneratedUrlMap(JSON.stringify(data), page());
    expect(mapped.nodes).toHaveLength(4); expect(mapped.edges).toHaveLength(4);
    expect(mapped.edges.find((edge: any) => edge.kind === "suggested")?.evidence).toBeNull();
    for (const node of mapped.nodes) expect(page().text.slice(node.evidence.start, node.evidence.end)).toBe(node.evidence.quote);
    expect(mapped.warnings).toHaveLength(1); expect(isUrlMapGraph(mapped)).toBe(true);
    expect(() => validateGeneratedUrlMap("not json", page())).toThrow("incomplete map");
  });

  test("uses the paid execution flow with no private workspace context and honors provider restrictions", async () => {
    const calls: any[] = [], stages: string[] = [];
    const service = createUrlMapService({ readPage: async () => page(), executeChatReply: async (args: any) => { calls.push(args); return { reply: urlMapModelReply }; } });
    const result = await service({ payload: { url: "https://example.org/trees", focus: "cooling", ai: { contextScope: "workspace", selectedConversationIds: ["private"], allowedProviders: ["gemini"] } }, user: { id: "owner" }, signal: new AbortController().signal, onProgress: (stage: string) => stages.push(stage) });
    expect(result.nodes).toHaveLength(4); expect(stages).toHaveLength(3);
    expect(calls[0].operation).toBe("url-map");
    expect(calls[0].payload.ai).toEqual({ mode: "balanced", contextScope: "conversation", selectedConversationIds: [], allowedProviders: ["gemini"] });
    expect(calls[0].payload.conversation.ancestorContext).toEqual([]);
    expect(calls[0].payload.workspaceContext).toBeUndefined();
    expect(calls[0].payload.messages[0].content).toContain("untrusted source material");
    expect(() => validateUrlMapRequest({ url: "https://example.org", focus: "a".repeat(501) })).toThrow();
  });

  test("stopping a read prevents inference and releases the per-user operation slot", async () => {
    let executeCount = 0;
    const controller = new AbortController();
    const service = createUrlMapService({ readPage: async (_url: string, { signal }: any) => { await new Promise<void>((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); return page(); }, executeChatReply: async () => { executeCount++; return { reply: urlMapModelReply }; } });
    const running = service({ payload: { url: "https://example.org/trees" }, user: { id: "owner" }, signal: controller.signal });
    await expect(service({ payload: { url: "https://example.org/trees" }, user: { id: "owner" } })).rejects.toThrow("already being built");
    controller.abort(); await expect(running).rejects.toThrow(); expect(executeCount).toBe(0);
  });
});

describe("saving and exploring URL maps", () => {
  test("overview cards retain readable, non-overlapping footprints at every zoom", () => {
    const layout = layoutUrlMap(graph());
    for (const zoom of [0.5, 0.65, 0.8, 1, 1.6]) {
      const scene = projectUrlMap(layout, zoom);
      for (const node of scene.nodes) {
        expect(node.width).toBeGreaterThanOrEqual(140);
        expect(node.height).toBeGreaterThanOrEqual(44);
        expect(node.x + node.width).toBeLessThan(scene.width);
        expect(node.y + node.height).toBeLessThan(scene.height);
        for (const other of scene.nodes) if (node.id !== other.id) {
          expect(node.x + node.width <= other.x || other.x + other.width <= node.x || node.y + node.height <= other.y || other.y + other.height <= node.y).toBe(true);
        }
      }
    }
    const fitted = fitUrlMapZoom(layout, 900, 500), fittedScene = projectUrlMap(layout, fitted);
    expect(fittedScene.width).toBeLessThanOrEqual(880);
    expect(fittedScene.height).toBeLessThanOrEqual(480);
    expect(fitUrlMapZoom(layout, 240, 180)).toBe(URL_MAP_MIN_ZOOM);
  });

  test("saves only the selected topic, stays in place, preserves edits, and survives vault roundtrip", () => {
    const initial = createEmptyState(), mapped = graph(), node = mapped.nodes[0];
    const saved = saveUrlMapNode(initial, mapped, node.id), id = urlMapConversationId(node);
    expect(Object.keys(saved.conversations)).toHaveLength(2);
    expect(saved.activeConversationId).toBe(initial.activeConversationId);
    expect(saved.conversations[id].notes![0].content).toContain(mapped.source.url);
    expect(saved.conversations[id].notes![0].content).toContain("AI-suggested connection");
    saved.conversations[id].title = "My renamed topic";
    saved.conversations[id].notes![0].content += "\nMy private thought.";
    const restored = vaultToState(stateToVaultFiles(saved, {}), createEmptyState());
    expect(saveUrlMapNode(restored, mapped, node.id)).toBe(restored);
    expect(findSavedUrlMapNode(restored.conversations, node)?.title).toBe("My renamed topic");
    expect(restored.conversations[id].notes![0].content).toContain("My private thought.");
  });

  test("topic IDs survive regeneration but do not merge equally named topics from other pages", () => {
    expect(graph().nodes.map((node: any) => node.id)).toEqual(graph().nodes.map((node: any) => node.id));
    const other = validateGeneratedUrlMap(urlMapModelReply, { ...page(), url: "https://another.example/trees" });
    expect(other.nodes[0].id).not.toBe(graph().nodes[0].id);
    const scene = layoutUrlMap(graph());
    for (const node of scene.nodes) for (const other of scene.nodes) if (node.id !== other.id) expect(Math.abs(node.x - other.x) >= 250 || Math.abs(node.y - other.y) >= 166).toBe(true);
  });
});
