import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { CAPTURE_LIMITS, escapeMarkdown } from "@margin-chat/capture-contracts";

export function extractArticle(document: Document) {
  const clone = document.cloneNode(true) as Document;
  clone
    .querySelectorAll(
      "script,style,form,input,textarea,select,button,iframe,object,embed,img,svg,canvas,[hidden],[aria-hidden='true']",
    )
    .forEach((node) => node.remove());
  clone.querySelectorAll("a[href]").forEach((link) => {
    try {
      const url = new URL(link.getAttribute("href")!, document.baseURI);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        link.removeAttribute("href");
      else link.setAttribute("href", url.href);
    } catch {
      link.removeAttribute("href");
    }
  });
  const article = new Readability(clone, { maxElemsToParse: 30_000 }).parse();
  if (!article?.textContent?.trim() || !article.content)
    throw new Error(
      "No readable article found. Highlight a passage or save a bookmark instead.",
    );
  const converter = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  converter.remove(["script", "style", "iframe", "img"]);
  const content = converter.turndown(article.content).trim();
  if (content.length > CAPTURE_LIMITS.content)
    throw new Error(
      "This article is too large. Highlight a shorter passage instead.",
    );
  return {
    title: (article.title || document.title).slice(0, CAPTURE_LIMITS.title),
    content,
  };
}
export function extractSelection(text: string) {
  if (!text.trim())
    throw new Error(
      "Highlight a passage on the page, then reopen Save to Margin.",
    );
  const content = escapeMarkdown(text.trim());
  if (content.length > CAPTURE_LIMITS.content)
    throw new Error("This selection is too large. Select a shorter passage.");
  return content;
}
