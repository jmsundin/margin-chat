/** Canonical Wikidata item identity. Labels and article titles are not identities. */
export function normalizePublicTopicId(input) {
  if (typeof input !== "string") return null;
  const id = input.trim().toUpperCase();
  return /^Q[1-9][0-9]{0,19}$/.test(id) ? id : null;
}

function normalizeWikipediaUrl(input) {
  if (typeof input !== "string" || input.length > 4096) return undefined;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || !/^[a-z][a-z0-9-]*\.wikipedia\.org$/.test(url.hostname)
      || url.username || url.password || url.port || !url.pathname.startsWith("/wiki/")) return undefined;
    return url.href;
  } catch { return undefined; }
}

/** Invalid optional provenance never prevents recovery of the user's own content. */
export function normalizePublicTopicSource(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const id = normalizePublicTopicId(input.id);
  if (!id || typeof input.label !== "string" || !input.label.trim()
    || typeof input.retrievedAt !== "string" || !Number.isFinite(Date.parse(input.retrievedAt))) return undefined;
  const aliases = [...new Set((Array.isArray(input.aliases) ? input.aliases : [])
    .map(normalizePublicTopicId).filter((alias) => alias && alias !== id))].slice(0, 100);
  const wikipediaUrl = normalizeWikipediaUrl(input.wikipediaUrl);
  return {
    id,
    aliases,
    label: input.label.trim().slice(0, 500),
    description: typeof input.description === "string" ? input.description.trim().slice(0, 4000) : "",
    wikidataUrl: `https://www.wikidata.org/wiki/${id}`,
    ...(wikipediaUrl ? { wikipediaUrl } : {}),
    retrievedAt: new Date(input.retrievedAt).toISOString(),
    ...(Number.isSafeInteger(input.revision) && input.revision > 0 ? { revision: input.revision } : {}),
  };
}

/** Personal links do not change conversation ancestry. */
export function normalizeLinkedConversationIds(input, conversationId, conversations) {
  if (!Array.isArray(input)) return undefined;
  return [...new Set(input.filter((id) => typeof id === "string" && id.length > 0
    && id !== conversationId && (!conversations || Object.hasOwn(conversations, id))))];
}
