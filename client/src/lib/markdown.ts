import DOMPurify from "dompurify";
import { Marked, type RendererObject, type Tokens } from "marked";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdownLanguage from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}

function extractLanguageId(language: string | undefined) {
  return language?.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
}

function isMermaidLanguage(language: string | undefined) {
  const normalized = extractLanguageId(language);

  return normalized === "mermaid" || normalized === "mmd";
}

function normalizeLanguage(language: string | undefined) {
  const normalized = extractLanguageId(language);

  if (!normalized || !hljs.getLanguage(normalized)) {
    return null;
  }

  return normalized;
}

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdownLanguage);
hljs.registerLanguage("python", python);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["js", "jsx"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["md"], { languageName: "markdown" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["yml"], { languageName: "yaml" });

const renderer: RendererObject = {
  code(token: Tokens.Code) {
    if (isMermaidLanguage(token.lang)) {
      return [
        '<div class="message-mermaid-block" data-language="mermaid">',
        '<pre class="message-code-block is-mermaid-source" data-language="mermaid">',
        `<code class="language-mermaid">${escapeHtml(token.text)}</code>`,
        "</pre>",
        '<div class="message-mermaid-diagram"></div>',
        "</div>",
      ].join("");
    }

    const language = normalizeLanguage(token.lang);
    const highlighted = language
      ? hljs.highlight(token.text, { language }).value
      : escapeHtml(token.text);
    const languageClass = language ? ` language-${language}` : "";
    const languageAttribute = language
      ? ` data-language="${escapeAttribute(language)}"`
      : "";

    return [
      `<pre class="message-code-block"${languageAttribute}>`,
      `<code class="hljs${languageClass}">${highlighted}</code>`,
      "</pre>",
    ].join("");
  },
  html(token: Tokens.HTML | Tokens.Tag) {
    return escapeHtml(token.text);
  },
  image(token: Tokens.Image) {
    const altText = escapeHtml(token.text || "Image");
    const href = escapeAttribute(token.href);
    const title = token.title
      ? ` title="${escapeAttribute(token.title)}"`
      : "";

    return `<a href="${href}" target="_blank" rel="noreferrer noopener"${title}>${altText}</a>`;
  },
  link(token: Tokens.Link) {
    const label = this.parser.parseInline(token.tokens);
    const href = escapeAttribute(token.href);
    const title = token.title
      ? ` title="${escapeAttribute(token.title)}"`
      : "";

    return `<a href="${href}" target="_blank" rel="noreferrer noopener"${title}>${label}</a>`;
  },
};

const markdown = new Marked({
  gfm: true,
  renderer,
  silent: true,
});

export function renderMarkdownToHtml(content: string) {
  const rendered = markdown.parse(content) as string;

  return DOMPurify.sanitize(rendered, {
    ADD_ATTR: ["data-language", "rel", "target"],
  });
}
