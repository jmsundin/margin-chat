import { describe, expect, test } from "bun:test";
import { HTML_FRAME_SANDBOX, htmlFrameDocument, htmlTextForAI, readHtmlFrameMessage } from "../client/src/lib/htmlDocuments";
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
    expect(withHead).toContain("</script><title>T</title>");
    expect(htmlFrameDocument("<!doctype html><p>Bare</p>").startsWith("<!doctype html><script>(")).toBe(true);
    expect(htmlFrameDocument("<p>Fragment</p>").startsWith("<script>(")).toBe(true);
    // A <header> element isn't the head.
    expect(htmlFrameDocument("<html><header>Top</header></html>").startsWith("<html><script>(")).toBe(true);
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
