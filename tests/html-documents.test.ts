import { describe, expect, test } from "bun:test";
import { HTML_FRAME_SANDBOX, MAX_HTML_STORAGE_CHARS, htmlFrameDocument, htmlTextForAI, htmlThemeMessage, readHtmlFrameMessage } from "../client/src/lib/htmlDocuments";
import { htmlPageTheme, readHtmlPagePrefs } from "../client/src/lib/htmlPagePrefs";
import { isVaultFileDocumentPath, vaultFileContentType, vaultFileKind } from "../client/src/lib/vaultFileDocuments";
import { planVaultUpload } from "../client/src/lib/vaultUpload";
import { validateVaultFileContext, vaultFileInstruction } from "../server/chat/fileContext.mjs";

const text = (value: string) => new TextEncoder().encode(value);

describe("HTML pages open as documents", () => {
  test("an .html or .htm file is a page document, synced as text/html", () => {
    expect(vaultFileKind("Sites/Demo.html")).toBe("html");
    expect(vaultFileKind("old.HTM")).toBe("html");
    expect(isVaultFileDocumentPath("Sites/Demo.html")).toBe(true);
    expect(isVaultFileDocumentPath(".margin-chat/cache.html")).toBe(false);
    expect(vaultFileContentType("Demo.html")).toBe("text/html");
    const plan = planVaultUpload([{ name: "Demo.html", bytes: text("<p>Hi</p>"), lastModified: 0 }], [], Date.UTC(2026, 9, 30));
    expect(plan.files["Demo.html"]).toMatchObject({ encoding: "base64", contentType: "text/html" });
    expect(plan.skipped).toEqual([]);
  });

  test("the page's scripts run without same-origin access, top navigation or alerts", () => {
    const flags = HTML_FRAME_SANDBOX.split(" ");
    expect(flags).toContain("allow-scripts");
    expect(flags).not.toContain("allow-same-origin");
    expect(flags.some((flag) => flag.startsWith("allow-top-navigation"))).toBe(false);
    expect(flags).not.toContain("allow-modals");
  });

  test("the bridge goes first in the head, and never before the doctype", () => {
    const withHead = htmlFrameDocument("<!DOCTYPE html><html lang=\"en\"><head><title>T</title></head><body>x</body></html>");
    expect(withHead.startsWith("<!DOCTYPE html><html lang=\"en\"><head><script>(")).toBe(true);
    expect(withHead).toContain(`</script><meta name="viewport" content="width=device-width,initial-scale=1"><title>T</title>`);
    expect(htmlFrameDocument("<!doctype html><p>Bare</p>").startsWith("<!doctype html><script>(")).toBe(true);
    expect(htmlFrameDocument("<p>Fragment</p>").startsWith("<script>(")).toBe(true);
    // A <header> element isn't the head.
    expect(htmlFrameDocument("<html><header>Top</header></html>").startsWith("<html><script>(")).toBe(true);
  });

  test("a viewport line is added only to a page that has none", () => {
    const own = `<html><head><meta name="viewport" content="width=600"></head><body>x</body></html>`;
    expect(htmlFrameDocument(own).match(/name="viewport"/gu)).toHaveLength(1);
    expect(htmlFrameDocument(own)).toContain(`content="width=600"`);
    expect(htmlFrameDocument(`<meta name=viewport content="width=1">`).match(/viewport/gu)).toHaveLength(1);
    expect(htmlFrameDocument("<p>x</p>").match(/name="viewport"/gu)).toHaveLength(1);
  });

  test("the page starts in the theme it is given, and a change is a message, not a reload", () => {
    expect(htmlFrameDocument("<p>x</p>")).toContain(`,"light");</script>`);
    expect(htmlFrameDocument("<p>x</p>", {}, { theme: "dark" })).toContain(`,"dark");</script>`);
    // Anything but the two themes falls back to light rather than reaching the page as script text.
    expect(htmlFrameDocument("<p>x</p>", {}, { theme: `");alert(1);("` as never })).toContain(`,"light");</script>`);
    expect(htmlThemeMessage("dark")).toEqual({ marginHtml: 1, type: "theme", theme: "dark" });
  });

  test("a page's look is remembered per page, and unknown values fall back", () => {
    expect(readHtmlPagePrefs(null)).toEqual({ layout: "fill", theme: "auto" });
    expect(readHtmlPagePrefs({ layout: "inline", theme: "dark" })).toEqual({ layout: "inline", theme: "dark" });
    expect(readHtmlPagePrefs({ layout: "wide", theme: "sepia" })).toEqual({ layout: "fill", theme: "auto" });
    expect(htmlPageTheme("auto", "dark")).toBe("dark");
    expect(htmlPageTheme("light", "dark")).toBe("light");
  });

  test("only well-formed bridge messages are read", () => {
    expect(readHtmlFrameMessage({ type: "size", height: 300 })).toBeNull();
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "size", height: 300 })).toEqual({ marginHtml: 1, type: "size", height: 300 });
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "size", height: "tall" })).toBeNull();
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "selection", quote: " ", start: 0, end: 1, context: "", rect: { left: 0, top: 0, width: 1, height: 1 } })).toBeNull();
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "selection", quote: "Hi", start: 4, end: 2, context: "", rect: { left: 0, top: 0, width: 1, height: 1 } })).toBeNull();
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "selection", quote: "Hi", start: 2, end: 4, context: "Oh Hi", rect: { left: 0, top: 0, width: 1, height: 1 } }))
      .toMatchObject({ type: "selection", quote: "Hi", start: 2, end: 4 });
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "marks", marks: [{ id: "a", left: 1, top: 2, width: 3, height: 4 }, { id: 5 }] }))
      .toEqual({ marginHtml: 1, type: "marks", marks: [{ id: "a", left: 1, top: 2, width: 3, height: 4 }] });
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "navigate", url: "https://example.com" })).toBeNull();
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "storage", data: { visits: "2" } })).toEqual({ marginHtml: 1, type: "storage", data: { visits: "2" } });
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "storage", data: { visits: 2 } })).toBeNull();
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "storage", data: { big: "x".repeat(MAX_HTML_STORAGE_CHARS + 1) } })).toBeNull();
  });

  test("a page's saved localStorage goes back in as data that can't end the bridge script", () => {
    const page = htmlFrameDocument("<html><head></head><body></body></html>", { note: "</script><script>alert(1)</script>" });
    expect(page.match(/<\/script>/gu)?.length).toBe(1);
    expect(page).toContain("\\u003c/script>");
    // Stand-ins for storage and cookies, which the sandbox would otherwise make throw.
    expect(page).toContain("localStorage");
    expect(page).toContain("sessionStorage");
  });

  test("AI reads the page's words, not its scripts or styles", () => {
    const page = "<html><head><title>Kiln</title><style>p{color:red}</style></head><body><h1>Firing</h1><p>Ramp to cone 04 &amp; hold.</p><script>alert(1)</script></body></html>";
    const words = htmlTextForAI(page);
    expect(words).toContain("Firing");
    expect(words).toContain("Ramp to cone 04 & hold.");
    expect(words).not.toContain("color:red");
    expect(words).not.toContain("alert");
  });

  test("the server accepts a page and tells the model what it is", () => {
    expect(validateVaultFileContext({ name: "Kiln.html", kind: "html", text: "Firing" })).toEqual({ name: "Kiln.html", kind: "html", text: "Firing" });
    const short = vaultFileInstruction({ name: "Kiln.html", kind: "html", text: "Ramp to cone 04." })!;
    expect(short.instruction).toContain('The user is reading the HTML page "Kiln.html"');
    expect(short.instruction).toContain("Ramp to cone 04.");
    expect(short.truncated).toBe(false);
    const long = vaultFileInstruction({ name: "Big.html", kind: "html", text: "word ".repeat(400_000) }, { mode: "fast" })!;
    expect(long.truncated).toBe(true);
    expect(long.warnings[0]).toContain("Big.html");
    expect(vaultFileInstruction({ name: "Canvas.html", kind: "html", text: "" })!.warnings[0]).toContain("no readable text");
  });
});
