import { describe, expect, test } from "bun:test";
import { importWebSection } from "../server/chat/agent/webImport.mjs";
import { extractPage, fetchPublicImage } from "../server/urlMap/page.mjs";
import { HttpError } from "../server/lib/errors.mjs";

const lookupImpl = async () => [{ address: "93.184.216.34", family: 4 }];

describe("pictures on imported pages", () => {
  const html = `<html><head><title>Telomeres</title></head><body><article><h1>Telomeres</h1>
    <p>${"Telomeres cap the ends of chromosomes. ".repeat(6)}</p>
    <img src="/caps.png"><img src="data:image/gif;base64,R0lGOD" data-src="https://cdn.example/lazy.jpg" alt="Lazy">
    <p>${"They shorten with each division. ".repeat(6)}</p></article></body></html>`;

  test("an import keeps every picture, each on its own line; reading keeps only described ones", () => {
    const imported = extractPage(html, "https://example.com/telomeres", "text/html", { markdown: true, images: true }).text;
    expect(imported).toContain("\n\n![](https://example.com/caps.png)\n\n");
    expect(imported).toContain("![Lazy](https://cdn.example/lazy.jpg)");
    const read = extractPage(html, "https://example.com/telomeres", "text/html", { markdown: true }).text;
    expect(read).not.toContain("caps.png");
  });

  test("pictures download as bytes; X serves a smaller copy of one that is too large", async () => {
    const asked: string[] = [];
    const downloadImpl = async (url: URL, _address: unknown, _signal: unknown, options: { image?: boolean }) => {
      expect(options.image).toBe(true);
      asked.push(url.href);
      if (url.searchParams.get("name") === "orig") throw new HttpError(413, "This image is too large to save.");
      return { status: 200, contentType: "image/jpeg", buffer: Buffer.from([1, 2]) };
    };
    const image = await fetchPublicImage("https://pbs.twimg.com/media/a.jpg?name=orig", { lookupImpl, downloadImpl });
    expect(image.contentType).toBe("image/jpeg");
    expect(asked).toEqual(["https://pbs.twimg.com/media/a.jpg?name=orig", "https://pbs.twimg.com/media/a.jpg?name=large"]);
    await expect(fetchPublicImage("http://127.0.0.1/a.png", { lookupImpl, downloadImpl })).rejects.toThrow();
  });
});

describe("relevant links the agent picks", () => {
  const pages: Record<string, { url: string; title: string; markdown: string; links: Array<{ url: string; label: string }> }> = {
    "https://blog.example/post": { url: "https://blog.example/post", title: "A post", markdown: "# A post\n\nSee [the paper](https://papers.example/p1).", links: [
      { url: "https://papers.example/p1", label: "the paper" }, { url: "https://blog.example/subscribe", label: "Subscribe" },
    ] },
    "https://papers.example/p1": { url: "https://papers.example/p1", title: "The paper", markdown: "# The paper", links: [] },
  };
  const readImport = async (url: string) => {
    if (!pages[url]) throw new HttpError(422, "missing");
    return pages[url];
  };

  test("an article's other links come back for the agent, and picked ones are saved under it", async () => {
    const first = await importWebSection("https://blog.example/post", { levels: 1, readImport });
    expect(first.documents).toHaveLength(1);
    expect(first.otherLinks.map((link: { url: string }) => link.url)).toEqual(["https://papers.example/p1", "https://blog.example/subscribe"]);
    const picked = await importWebSection("https://blog.example/post", { levels: 0, links: ["https://papers.example/p1", "https://evil.example/x"], readImport });
    expect(picked.documents.map((document: { title: string; parentUrl: string | null }) => [document.title, document.parentUrl])).toEqual([
      ["A post", null], ["The paper", "https://blog.example/post"],
    ]);
    expect(picked.failed).toEqual([{ url: "https://evil.example/x", error: "That address is not a link on the saved page." }]);
  });
});
