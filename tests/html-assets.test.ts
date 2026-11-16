import { describe, expect, test } from "bun:test";
import { htmlAssetContentType, htmlAssetPath, htmlPageHasAssets, inlineHtmlAssets } from "../client/src/lib/htmlAssets";
import { htmlFrameDocument, readHtmlFrameMessage } from "../client/src/lib/htmlDocuments";

describe("files beside an HTML page", () => {
  test("a page in a folder reaches the files in that folder and nothing else", () => {
    const page = "Games/Glider/Glider.html";
    expect(htmlAssetPath(page, "vendor/sql-asm.js")).toBe("Games/Glider/vendor/sql-asm.js");
    expect(htmlAssetPath(page, "./img/./ship.png")).toBe("Games/Glider/img/ship.png");
    expect(htmlAssetPath(page, "../Journal/secret.png")).toBeNull();
    expect(htmlAssetPath(page, "vendor/../../x.js")).toBeNull();
    expect(htmlAssetPath(page, ".margin-chat/page-data/x.json")).toBeNull();
    expect(htmlAssetPath(page, "Glider.html")).toBeNull();
    // Notes and PDFs are never handed to a page, even in its own folder.
    expect(htmlAssetPath(page, "Notes.md")).toBeNull();
    expect(htmlAssetPath(page, "Paper.PDF")).toBeNull();
  });

  test("a page at the top of the vault gets no files", () => {
    expect(htmlPageHasAssets("Page.html")).toBe(false);
    expect(htmlAssetPath("Page.html", "Photos/me.png")).toBeNull();
  });

  test("names the kind of each file so engines accept it", () => {
    expect(htmlAssetContentType("vendor/compiler.wasm")).toBe("application/wasm");
    expect(htmlAssetContentType("vendor/sql-asm.JS")).toBe("text/javascript");
    expect(htmlAssetContentType("data.bin")).toBe("application/octet-stream");
  });

  test("puts the scripts and stylesheets the markup names inside the page, in place", async () => {
    const files: Record<string, string> = {
      "app.js": "document.write('</script><b>');", "css/site.css": "p{color:red}", "lib/a b.js": "var a;" };
    const asked: string[] = [];
    const html = `<link rel="stylesheet" href="css/site.css" media="screen"><link rel="icon" href="icon.png">
<script src="app.js" defer></script><script src='lib/a%20b.js?v=2'></script><script src="https://cdn.example/x.js"></script>
<script type="module" src="mod.js"></script><script src="missing.js"></script><script>inline()</script><body><p>text</p></body>`;
    const out = await inlineHtmlAssets(html, async (path) => { asked.push(path); return files[path] ?? null; });
    expect(asked.sort()).toEqual(["app.js", "css/site.css", "lib/a b.js", "missing.js"]);
    expect(out).toContain(`<style data-href="css/site.css" media="screen">p{color:red}</style>`);
    // A deferred script runs after the page is read, so it goes to the end.
    expect(out).toContain(`<p>text</p><script data-src="app.js">document.write('<\\/script><b>');</script></body>`);
    expect(out).toContain(`<script data-src="lib/a%20b.js?v=2">var a;</script>`);
    // Left as written: the web, modules, a file that isn't there, and anything that isn't a stylesheet.
    expect(out).toContain(`<script src="https://cdn.example/x.js"></script>`);
    expect(out).toContain(`<script type="module" src="mod.js"></script>`);
    expect(out).toContain(`<script src="missing.js"></script>`);
    expect(out).toContain(`<link rel="icon" href="icon.png">`);
    expect(out).toContain(`<script>inline()</script>`);
  });

  test("the frame asks for files only when the page may have them", () => {
    expect(htmlFrameDocument("<p>x</p>", {})).toContain(`})({},false,"light","inline");</script>`);
    expect(htmlFrameDocument("<p>x</p>", {}, true)).toContain(`})({},true,"light","inline");</script>`);
    expect(htmlFrameDocument("<p>x</p>", {}, { assets: true, theme: "dark" })).toContain(`})({},true,"dark","inline");</script>`);
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "asset-request", id: "a1", path: "vendor/x.js" }))
      .toEqual({ marginHtml: 1, type: "asset-request", id: "a1", path: "vendor/x.js" });
    expect(readHtmlFrameMessage({ marginHtml: 1, type: "asset-request", id: 4, path: "x" })).toBeNull();
  });
});
