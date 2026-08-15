import DOMPurify from "dompurify";
import {
  Marked,
  type RendererObject,
  type TokenizerAndRendererExtension,
  type Tokens,
} from "marked";
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
import { getObsidianCalloutFamily } from "./obsidianMarkdown";

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

const obsidianInlineExtensions: TokenizerAndRendererExtension[] = [
  {
    name: "obsidianComment",
    level: "inline",
    start(source) {
      return source.indexOf("%%");
    },
    tokenizer(source) {
      const match = /^%%[\s\S]*?%%/.exec(source);
      if (!match) return undefined;
      return { raw: match[0], type: "obsidianComment" };
    },
    renderer() {
      return "";
    },
  },
  {
    name: "obsidianEmbed",
    level: "inline",
    start(source) {
      return source.indexOf("![[");
    },
    tokenizer(source) {
      const match = /^!\[\[([^\]\n]+)\]\]/.exec(source);
      if (!match) return undefined;
      const separator = match[1].indexOf("|");
      return {
        label: separator === -1 ? match[1] : match[1].slice(separator + 1),
        raw: match[0],
        target: separator === -1 ? match[1] : match[1].slice(0, separator),
        type: "obsidianEmbed",
      };
    },
    renderer(token) {
      return `<span class="obsidian-embed" data-note-target="${escapeAttribute(token.target)}"><span aria-hidden="true">↳</span>${escapeHtml(token.label)}</span>`;
    },
  },
  {
    name: "obsidianWikilink",
    level: "inline",
    start(source) {
      return source.indexOf("[[");
    },
    tokenizer(source) {
      const match = /^\[\[([^\]\n]+)\]\]/.exec(source);
      if (!match) return undefined;
      const separator = match[1].indexOf("|");
      return {
        label: separator === -1 ? match[1] : match[1].slice(separator + 1),
        raw: match[0],
        target: separator === -1 ? match[1] : match[1].slice(0, separator),
        type: "obsidianWikilink",
      };
    },
    renderer(token) {
      return `<span class="obsidian-wikilink" data-note-target="${escapeAttribute(token.target)}">${escapeHtml(token.label)}</span>`;
    },
  },
  {
    name: "obsidianHighlight",
    level: "inline",
    start(source) {
      return source.indexOf("==");
    },
    tokenizer(source) {
      const match = /^==(?=\S)([^\n]*?\S)==/.exec(source);
      if (!match) return undefined;
      return {
        raw: match[0],
        tokens: this.lexer.inlineTokens(match[1]),
        type: "obsidianHighlight",
      };
    },
    renderer(token) {
      return `<mark class="obsidian-highlight">${this.parser.parseInline(token.tokens ?? [])}</mark>`;
    },
  },
];

const obsidianCalloutIcons: Record<string, string> = {
  abstract: "≡",
  bug: "◆",
  danger: "!",
  example: "◇",
  failure: "×",
  info: "i",
  note: "✎",
  question: "?",
  quote: "“",
  success: "✓",
  tip: "⚑",
  todo: "☑",
  warning: "!",
};

function getDefaultCalloutTitle(type: string) {
  return type.charAt(0).toUpperCase() + type.slice(1).replaceAll("-", " ");
}

const obsidianRenderer: RendererObject = {
  ...renderer,
  blockquote(token: Tokens.Blockquote) {
    const callout = /^\[!([a-zA-Z0-9_-]+)\]([+-])?(?:[ \t]+([^\n]*))?(?:\n|$)/.exec(
      token.text,
    );

    if (!callout) {
      return `<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`;
    }

    const type = callout[1].toLowerCase();
    const family = getObsidianCalloutFamily(type);
    const title = callout[3]?.trim() || getDefaultCalloutTitle(type);
    const titleTokens = obsidianMarkdown.lexer(title)[0];
    const titleHtml = titleTokens && "tokens" in titleTokens && titleTokens.tokens
      ? this.parser.parseInline(titleTokens.tokens)
      : escapeHtml(title);
    const bodySource = token.text.slice(callout[0].length);
    const bodyHtml = bodySource
      ? this.parser.parse(obsidianMarkdown.lexer(bodySource))
      : "";
    const fold = callout[2]
      ? `<span class="obsidian-callout-fold" aria-hidden="true">${callout[2] === "-" ? "›" : "⌄"}</span>`
      : "";

    return [
      `<aside class="obsidian-callout obsidian-callout-${family}" data-callout="${escapeAttribute(type)}">`,
      '<div class="obsidian-callout-title">',
      `<span class="obsidian-callout-icon" aria-hidden="true">${obsidianCalloutIcons[family] ?? obsidianCalloutIcons.note}</span>`,
      `<strong>${titleHtml}</strong>`,
      fold,
      "</div>",
      bodyHtml ? `<div class="obsidian-callout-content">${bodyHtml}</div>` : "",
      "</aside>\n",
    ].join("");
  },
};

const markdown = new Marked({
  gfm: true,
  renderer,
  silent: true,
});

const obsidianMarkdown = new Marked({
  extensions: obsidianInlineExtensions,
  gfm: true,
  renderer: obsidianRenderer,
  silent: true,
});

function sanitizeMarkdown(rendered: string) {
  return DOMPurify.sanitize(rendered, {
    ADD_ATTR: ["data-callout", "data-language", "data-note-target", "rel", "target"],
  });
}

export function renderMarkdownToHtml(content: string) {
  const rendered = markdown.parse(content) as string;

  return sanitizeMarkdown(rendered);
}

export function renderObsidianMarkdownToHtml(content: string) {
  const rendered = obsidianMarkdown.parse(content) as string;

  return sanitizeMarkdown(rendered);
}
