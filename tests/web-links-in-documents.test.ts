import { describe, expect, test } from "bun:test";
import { openableHref, shouldOpenLink, type LinkClick } from "../client/src/lib/documentLinkOpening";
import { buildConversationTitle, excerpt } from "../client/src/lib/tree";

const tweet = "https://x.com/sermakarevich/status/2112198653469241234";
const click = (overrides: Partial<LinkClick> = {}): LinkClick => ({
  button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, pointerType: "mouse", readOnly: false, selecting: false, ...overrides,
});

describe("a title made from text never cuts a web address", () => {
  test("a link on its own stays whole, however long", () => {
    expect(excerpt(tweet, 52)).toBe(tweet);
    expect(excerpt(` ${tweet}\n`, 34)).toBe(tweet);
    expect(buildConversationTitle("", tweet)).toBe(tweet);
  });

  test("a link that would be cut is left out, or kept whole when the text starts with it", () => {
    expect(excerpt(`Read this thread about agents ${tweet} today`, 52)).toBe("Read this thread about agents...");
    expect(excerpt(`${tweet} what does this tweet say about agent harnesses?`, 52)).toBe(`${tweet} ...`);
    expect(excerpt("Go to www.example.com/a/really/long/path/that/keeps/going/on", 40)).toBe("Go to...");
  });

  test("text without a link, or with a link that fits, is shortened as before", () => {
    expect(excerpt("The quick brown fox jumps over the lazy dog again and again", 20)).toBe("The quick brown fox...");
    expect(excerpt(`See https://x.com/a and then some more words after it`, 30)).toBe("See https://x.com/a and then...");
    expect(excerpt("short", 52)).toBe("short");
  });
});

describe("links in a document open in a new tab", () => {
  test("web and mail addresses open; anything else stays text", () => {
    expect(openableHref(tweet)).toBe(tweet);
    expect(openableHref("mailto:jon@example.com")).toBe("mailto:jon@example.com");
    expect(openableHref("www.example.com/page")).toBe("https://www.example.com/page");
    expect(openableHref("javascript:alert(1)")).toBeNull();
    expect(openableHref("notes/plan.md")).toBeNull();
    expect(openableHref("")).toBeNull();
  });

  test("a tap opens a link; a plain mouse click while editing places the caret instead", () => {
    expect(shouldOpenLink(click({ pointerType: "touch" }))).toBe(true);
    expect(shouldOpenLink(click({ pointerType: "pen" }))).toBe(true);
    expect(shouldOpenLink(click())).toBe(false);
    expect(shouldOpenLink(click({ metaKey: true }))).toBe(true);
    expect(shouldOpenLink(click({ ctrlKey: true }))).toBe(true);
  });

  test("in Reading mode a plain click opens; a drag that selects text or another button never does", () => {
    expect(shouldOpenLink(click({ readOnly: true }))).toBe(true);
    expect(shouldOpenLink(click({ readOnly: true, selecting: true }))).toBe(false);
    expect(shouldOpenLink(click({ pointerType: "touch", selecting: true }))).toBe(false);
    expect(shouldOpenLink(click({ button: 1, metaKey: true }))).toBe(false);
    expect(shouldOpenLink(click({ readOnly: true, shiftKey: true }))).toBe(false);
  });
});
