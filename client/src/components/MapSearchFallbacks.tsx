/** Wikipedia's own full-text search, for when no article title matches. */
export function wikipediaSearchUrl(query: string) {
  return `https://en.wikipedia.org/w/index.php?${new URLSearchParams({ search: query.trim().slice(0, 200), fulltext: "1", ns0: "1" })}`;
}

/** A search term reads as a question when it asks one; otherwise AI is asked what it is. */
export function fallbackQuestion(query: string) {
  const text = query.trim().replace(/\s+/g, " ").slice(0, 400);
  return /\?$/.test(text) || /^(who|what|when|where|why|how|which|is|are|does|do|can|should)\b/i.test(text) ? text : `What is ${text}?`;
}
