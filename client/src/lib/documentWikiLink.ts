import { InputRule, mergeAttributes, Node, PasteRule } from "@tiptap/core";

/** Same syntax the Obsidian renderer reads: [[target]], [[target|label]] and ![[embed]]. */
const WIKILINK_SOURCE = String.raw`!?\[\[([^\]\n]+)\]\]`;
const WIKILINK_AT_START = new RegExp(`^${WIKILINK_SOURCE}`);
// Older document saves escaped every bracket, writing [[Title]] as \[\[Title\]\].
const ESCAPED_WIKILINK_AT_START = /^(!?)\\\[\\\[((?:[^\\\]\n]|\\[^\]\n])+)\\\]\\\]/;
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g;

export function readWikiLink(raw: string) {
  const embed = raw.startsWith("!");
  const inner = raw.slice(embed ? 3 : 2, -2);
  const separator = inner.indexOf("|");
  const target = separator === -1 ? inner : inner.slice(0, separator);
  const label = separator === -1 ? inner : inner.slice(separator + 1);
  return { embed, target, label: label || target };
}

/** Reads a link at the cursor, repairing the escaped form so it is saved as a link again. */
export function readWikiLinkAtStart(source: string): string | null {
  const plain = WIKILINK_AT_START.exec(source);
  if (plain) return plain[0];
  const escaped = ESCAPED_WIKILINK_AT_START.exec(source);
  return escaped ? `${escaped[1]}[[${escaped[2].replace(MARKDOWN_ESCAPE, "$1")}]]` : null;
}

function rawLength(source: string) {
  return (WIKILINK_AT_START.exec(source) ?? ESCAPED_WIKILINK_AT_START.exec(source))?.[0].length ?? 0;
}

/**
 * Keeps wiki links and embeds as their exact source inside the rich editor. Without
 * this node they were plain text, and saving escaped them as "\[\[Title\]\]".
 */
export const DocumentWikiLink = Node.create({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { raw: { default: "", parseHTML: (element) => element.getAttribute("data-wikilink") ?? "", renderHTML: () => ({}) } };
  },
  parseHTML() {
    return [{ tag: "span[data-wikilink]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const { embed, target, label } = readWikiLink(node.attrs.raw);
    const attributes = mergeAttributes(HTMLAttributes, {
      class: embed ? "obsidian-embed" : "obsidian-wikilink",
      "data-wikilink": node.attrs.raw,
      "data-note-target": target,
    });
    return embed ? ["span", attributes, ["span", { "aria-hidden": "true" }, "↳"], label] : ["span", attributes, label];
  },
  renderText({ node }) {
    return node.attrs.raw;
  },
  markdownTokenizer: {
    name: "wikiLink",
    level: "inline",
    start: (source: string) => source.search(/!?\\?\[\\?\[/),
    tokenize(source: string) {
      const raw = readWikiLinkAtStart(source);
      return raw ? { type: "wikiLink", raw: source.slice(0, rawLength(source)), source: raw } : undefined;
    },
  },
  parseMarkdown(token) {
    return { type: "wikiLink", attrs: { raw: token.source ?? token.raw } };
  },
  renderMarkdown(node) {
    return node.attrs?.raw ?? "";
  },
  addInputRules() {
    const type = this.type;
    return [new InputRule({
      find: new RegExp(`${WIKILINK_SOURCE}$`),
      handler({ state, range, match }) { state.tr.replaceWith(range.from, range.to, type.create({ raw: match[0] })); },
    })];
  },
  addPasteRules() {
    const type = this.type;
    return [new PasteRule({
      find: new RegExp(WIKILINK_SOURCE, "g"),
      handler({ state, range, match }) { state.tr.replaceWith(range.from, range.to, type.create({ raw: match[0] })); },
    })];
  },
});
