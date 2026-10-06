/**
 * A deliberately small Markdown renderer for answers shown in the extension card.
 * It builds DOM nodes only (never HTML strings), so model output cannot inject markup.
 */
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/gu;

function inline(doc: Document, parent: Node, text: string) {
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) parent.appendChild(doc.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = doc.createElement("code"); code.textContent = token.slice(1, -1); parent.appendChild(code);
    } else if (token.startsWith("**")) {
      const strong = doc.createElement("strong"); strong.textContent = token.slice(2, -2); parent.appendChild(strong);
    } else {
      const split = token.indexOf("](");
      const link = doc.createElement("a");
      link.textContent = token.slice(1, split);
      link.href = token.slice(split + 2, -1);
      link.target = "_blank"; link.rel = "noopener noreferrer";
      parent.appendChild(link);
    }
    last = match.index + token.length;
  }
  if (last < text.length) parent.appendChild(doc.createTextNode(text.slice(last)));
}

export function renderMarkdownLite(container: HTMLElement, markdown: string) {
  const doc = container.ownerDocument;
  const nodes: Node[] = [];
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++; // closing fence, or the end of a still-streaming block
      const pre = doc.createElement("pre"); const code = doc.createElement("code");
      code.textContent = body.join("\n"); pre.appendChild(code); nodes.push(pre);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/u.exec(line);
    if (heading) {
      const p = doc.createElement("p"); p.className = "heading";
      inline(doc, p, heading[1]); nodes.push(p); i++; continue;
    }
    const list = /^\s*(?:[-*]|\d+[.)])\s+/u.exec(line);
    if (list) {
      const ordered = /\d/u.test(list[0]);
      const el = doc.createElement(ordered ? "ol" : "ul");
      while (i < lines.length && /^\s*(?:[-*]|\d+[.)])\s+/u.test(lines[i])) {
        const li = doc.createElement("li");
        inline(doc, li, lines[i].replace(/^\s*(?:[-*]|\d+[.)])\s+/u, "")); el.appendChild(li); i++;
      }
      nodes.push(el); continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !/^#{1,6}\s/u.test(lines[i]) && !/^\s*(?:[-*]|\d+[.)])\s+/u.test(lines[i])) paragraph.push(lines[i++]);
    const p = doc.createElement("p");
    paragraph.forEach((text, index) => { if (index) p.appendChild(doc.createElement("br")); inline(doc, p, text); });
    nodes.push(p);
  }
  container.replaceChildren(...nodes);
}
