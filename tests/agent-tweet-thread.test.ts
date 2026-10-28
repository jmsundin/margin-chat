import { describe, expect, test } from "bun:test";
import { readTweetThread, tweetLocation } from "../server/chat/agent/tweetThread.mjs";
import { importWebSection, readImportPage } from "../server/chat/agent/webImport.mjs";
import { HttpError } from "../server/lib/errors.mjs";

const author = { screen_name: "ada", name: "Ada Lovelace" };
const post = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id, text, url: `https://x.com/ada/status/${id}`, author, created_timestamp: 1_800_000_000, raw_text: { text, facets: [] }, media: {}, ...extra,
});
const thread = {
  code: 200,
  status: post("11", "Engines and numbers, a thread 🧵"),
  thread: [
    post("10", "Engines and numbers, a thread 🧵\n\n1/ The engine weaves patterns. https://t.co/abc https://t.co/pic", {
      raw_text: { text: "Engines and numbers, a thread 🧵\n\n1/ The engine weaves patterns. https://t.co/abc https://t.co/pic", facets: [
        { type: "url", original: "https://t.co/abc", replacement: "https://example.com/notes" },
        { type: "media", original: "https://t.co/pic", replacement: "https://x.com/ada/status/10/photo/1" },
      ] },
      media: { all: [{ type: "photo", url: "https://pbs.twimg.com/media/a.png", altText: "A loom" }] },
    }),
    post("11", "2/ It might compose music.", { quote: { url: "https://x.com/babbage/status/5", text: "The engine works.", author: { screen_name: "babbage" } } }),
    post("12", "3/ That is all."),
  ],
};
const api = (body: unknown) => async (url: string, options?: { json?: boolean }) => {
  expect(url).toBe("https://api.fxtwitter.com/2/thread/11");
  expect(options?.json).toBe(true);
  return { url, contentType: "application/json", html: JSON.stringify(body) };
};

describe("X (Twitter) threads", () => {
  test("recognizes post addresses on X, Twitter and their mirrors", () => {
    expect(tweetLocation("https://x.com/ada/status/11?s=46&t=abc")).toEqual({ handle: "ada", id: "11" });
    expect(tweetLocation("https://mobile.twitter.com/ada/status/11/photo/1")).toEqual({ handle: "ada", id: "11" });
    expect(tweetLocation("https://fxtwitter.com/ada/status/11")).toEqual({ handle: "ada", id: "11" });
    expect(tweetLocation("https://x.com/i/web/status/11")).toEqual({ handle: null, id: "11" });
    expect(tweetLocation("https://x.com/ada")).toBeNull();
    expect(tweetLocation("https://example.com/ada/status/11")).toBeNull();
  });

  test("reads the whole thread in order, with links, images and quotes", async () => {
    const page = await readTweetThread({ handle: "ada", id: "11" }, (url: string) => api(thread)(url, { json: true }));
    expect(page.url).toBe("https://x.com/ada/status/11");
    expect(page.title).toBe("Ada Lovelace (@ada): Engines and numbers, a thread 🧵");
    expect(page.links).toEqual([]);
    expect(page.markdown).toStartWith("Thread by **Ada Lovelace (@ada)** on X, 3 posts.");
    const first = page.markdown.indexOf("1/ The engine");
    expect(first).toBeLessThan(page.markdown.indexOf("2/ It might"));
    expect(page.markdown.indexOf("2/ It might")).toBeLessThan(page.markdown.indexOf("3/ That is all."));
    expect(page.markdown).toContain("weaves patterns. https://example.com/notes");
    expect(page.markdown).not.toContain("t.co");
    expect(page.markdown).toContain("![A loom](https://pbs.twimg.com/media/a.png)");
    expect(page.markdown).toContain("> Quoting [@babbage](https://x.com/babbage/status/5):\n>\n> The engine works.");
    expect(page.markdown).toContain("*[3/3](https://x.com/ada/status/12) · 2027-01-15*");
  });

  test("a lone post reads as one post", async () => {
    const page = await readTweetThread({ handle: "ada", id: "11" }, (url: string) => api({ code: 200, status: post("11", "Just one."), thread: [] })(url, { json: true }));
    expect(page.markdown).toStartWith("Post by **Ada Lovelace (@ada)** on X.");
    expect(page.markdown).toContain("*[Post](https://x.com/ada/status/11)");
  });

  test("an import saves the thread as one document", async () => {
    const result = await importWebSection("https://x.com/ada/status/11?s=20", { readImport: (url: string) => readImportPage(url, { fetchPage: api(thread) }) });
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].markdown).toStartWith("Source: <https://x.com/ada/status/11>");
    expect(result.documents[0].markdown).toContain("3/ That is all.");
    expect(result.deeper.pages).toBe(0);
  });

  test("falls back to the post's own page when the thread can't be read", async () => {
    const page = await readImportPage("https://x.com/ada/status/11", {
      fetchPage: async () => { throw new HttpError(422, "The webpage returned 404. Try another public page."); },
      readPage: async (url: string) => ({ url, title: "Ada on X", text: "Engines and numbers", links: [] }),
    });
    expect(page).toMatchObject({ title: "Ada on X", markdown: "Engines and numbers" });
  });
});
