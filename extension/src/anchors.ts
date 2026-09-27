/** A quote and its immediate surroundings, in the page's filtered DOM text. */
export type TextAnchor = {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
};

export const ANCHOR_CONTEXT_LENGTH = 48;
export const ANCHOR_MAX_TEXT_LENGTH = 200_000;
export const ANCHOR_MAX_NODES = 30_000;
export const ANCHOR_EXCLUDED_SELECTOR =
  "script,style,noscript,template,form,input,textarea,select,button,iframe,object,embed,svg,canvas,[hidden],[aria-hidden='true' i],[contenteditable]:not([contenteditable='false' i]),[data-margin-overlay]";

type TextSpan = { node: Text; start: number; end: number };
type TextIndex = {
  text: string;
  spans: TextSpan[];
  excluded: Element[];
};

function excludedElement(element: Element, document: Document): boolean {
  if (element.matches(ANCHOR_EXCLUDED_SELECTOR)) return true;
  const style = document.defaultView?.getComputedStyle(element);
  return (
    style?.display === "none" ||
    style?.visibility === "hidden" ||
    style?.visibility === "collapse"
  );
}

/** Keep whitespace and inline text intact; offsets are UTF-16 DOM offsets. */
function indexText(document: Document): TextIndex | null {
  const root = document.body;
  if (!root || document.designMode?.toLowerCase() === "on") return null;
  for (let element: Element | null = root; element; element = element.parentElement)
    if (excludedElement(element, document)) return null;

  const parts: string[] = [];
  const spans: TextSpan[] = [];
  const excluded: Element[] = [];
  let length = 0;
  let visited = 0;
  const limitReached = Symbol("anchor traversal limit");
  // Numeric NodeFilter constants avoid depending on the global page realm.
  const walker = document.createTreeWalker(root, 1 | 4, {
    acceptNode(node) {
      if (++visited > ANCHOR_MAX_NODES) {
        // FILTER_REJECT alone would still walk every remaining sibling.
        throw limitReached;
      }
      if (node.nodeType === 1) {
        if (excludedElement(node as Element, document)) {
          excluded.push(node as Element);
          return 2;
        }
        return 3;
      }
      return 1;
    },
  });
  try {
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node as Text;
      if (!text.data.length) continue;
      const end = length + text.data.length;
      if (end > ANCHOR_MAX_TEXT_LENGTH) return null;
      spans.push({ node: text, start: length, end });
      parts.push(text.data);
      length = end;
    }
  } catch (error) {
    if (error !== limitReached) throw error;
    return null;
  }
  return { text: parts.join(""), spans, excluded };
}

function crossesExcluded(range: Range, index: TextIndex): boolean {
  return index.excluded.some((element) => range.intersectsNode(element));
}

/** Reject selections that include private, editable, hidden, or overlay UI. */
export function captureTextAnchor(
  selection: Selection | null,
  document: Document,
): TextAnchor | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
    return null;
  const range = selection.getRangeAt(0);
  if (
    !document.body?.contains(range.startContainer) ||
    !document.body.contains(range.endContainer)
  )
    return null;
  const index = indexText(document);
  if (!index || crossesExcluded(range, index)) return null;

  let start: number | undefined;
  let end: number | undefined;
  for (const span of index.spans) {
    if (!range.intersectsNode(span.node)) continue;
    const from = range.startContainer === span.node ? range.startOffset : 0;
    const to =
      range.endContainer === span.node ? range.endOffset : span.node.data.length;
    if (from === to) continue;
    start ??= span.start + from;
    end = span.start + to;
  }
  if (start === undefined || end === undefined) return null;
  const exact = index.text.slice(start, end);
  if (!exact.trim()) return null;
  return {
    exact,
    prefix: index.text.slice(Math.max(0, start - ANCHOR_CONTEXT_LENGTH), start),
    suffix: index.text.slice(end, end + ANCHOR_CONTEXT_LENGTH),
    start,
    end,
  };
}

function validAnchor(anchor: TextAnchor): boolean {
  return (
    !!anchor &&
    typeof anchor.exact === "string" &&
    !!anchor.exact.trim() &&
    anchor.exact.length <= ANCHOR_MAX_TEXT_LENGTH &&
    typeof anchor.prefix === "string" &&
    anchor.prefix.length <= ANCHOR_CONTEXT_LENGTH &&
    typeof anchor.suffix === "string" &&
    anchor.suffix.length <= ANCHOR_CONTEXT_LENGTH &&
    Number.isSafeInteger(anchor.start) &&
    Number.isSafeInteger(anchor.end) &&
    anchor.start >= 0 &&
    anchor.end <= ANCHOR_MAX_TEXT_LENGTH &&
    anchor.end === anchor.start + anchor.exact.length
  );
}

/**
 * Restore only one quote with matching surroundings. Offsets are descriptive,
 * not a tie breaker: an ambiguous or edited passage should remain unhighlighted.
 * Added content elsewhere on the page can shift the quote without detaching it.
 */
export function resolveTextAnchor(
  document: Document,
  anchor: TextAnchor,
): Range | null {
  if (!validAnchor(anchor)) return null;
  const index = indexText(document);
  if (!index) return null;
  let match = -1;
  let position = index.text.indexOf(anchor.exact);
  while (position !== -1) {
    const end = position + anchor.exact.length;
    if (
      index.text.slice(Math.max(0, position - anchor.prefix.length), position) ===
        anchor.prefix &&
      index.text.slice(end, end + anchor.suffix.length) === anchor.suffix
    ) {
      if (match !== -1) return null;
      match = position;
    }
    position = index.text.indexOf(anchor.exact, position + 1);
  }
  if (match === -1) return null;
  const end = match + anchor.exact.length;
  const first = index.spans.find((span) => span.start <= match && span.end > match);
  const last = index.spans.find((span) => span.start < end && span.end >= end);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, match - first.start);
  range.setEnd(last.node, end - last.start);
  return crossesExcluded(range, index) ? null : range;
}
