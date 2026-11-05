/**
 * Line authorship as the app shows it (spec §9): who wrote each line of one
 * document, compact enough to fetch whenever the document settles. Lines are
 * identified by a short hash of their text so the browser can match them to
 * what it shows, including edits it hasn't saved yet. This is the member's own
 * view of their own vault, so documents hidden from AI are included; nothing
 * here is sent to a public map or a connected app.
 */

// Origins looked up per request; lines from older revisions show no age.
const ORIGIN_LOOKUPS = 60;
// How far back to look for the last revision someone other than the backfill made.
const LAST_EDIT_LOOKUPS = 12;
export const LINE_HASH_LENGTH = 16;

const authorLabel = (author) => author?.label || (author?.type === "human" ? "You" : author?.type === "unknown" ? "Unknown" : author?.type === "ai" ? "AI" : "Unknown");
const authorKey = (author) => `${author?.type ?? "unknown"}\u0000${author?.id ?? ""}\u0000${authorLabel(author)}`;

export async function documentAuthorshipView({ provenance, userId, documentId }) {
  if (!provenance) return { documentId, tracked: false };
  const { head } = await provenance.readHead(userId, documentId);
  const sidecar = head ? await provenance.readSidecar(userId, documentId, head.revisionKey) : null;
  if (!sidecar) return { documentId, tracked: false };

  const authors = [];
  const authorIndex = new Map();
  const author = (value) => {
    const key = authorKey(value);
    if (!authorIndex.has(key)) {
      authorIndex.set(key, authors.length);
      authors.push({ type: value?.type ?? "unknown", label: authorLabel(value) });
    }
    return authorIndex.get(key);
  };

  const originKeys = [...new Set(sidecar.blocks.flatMap((block) => block.lines.map((line) => line.originRevisionId)))];
  const originSidecars = new Map([[sidecar.revisionKey, sidecar]]);
  await Promise.all(originKeys.filter((key) => !originSidecars.has(key) && !String(key).startsWith("inferred:")).slice(0, ORIGIN_LOOKUPS)
    .map(async (key) => {
      const found = await provenance.readSidecar(userId, documentId, key).catch(() => null);
      if (found) originSidecars.set(key, found);
    }));
  const origins = [];
  const originIndex = new Map();
  const origin = (key) => {
    const found = originSidecars.get(key);
    if (!found) return -1;
    if (!originIndex.has(key)) {
      originIndex.set(key, origins.length);
      origins.push({ at: found.createdAt ?? null, source: found.source ?? null });
    }
    return originIndex.get(key);
  };

  // The latest revision made by a person, a model or an app, not by the backfill.
  let lastEditedBy = null;
  let lastEditedAt = null;
  let cursor = sidecar;
  for (let step = 0; cursor && step < LAST_EDIT_LOOKUPS; step += 1) {
    if (cursor.actor && cursor.actor.type !== "system") {
      lastEditedBy = { type: cursor.actor.type, label: authorLabel(cursor.actor) };
      lastEditedAt = cursor.createdAt ?? null;
      break;
    }
    cursor = cursor.parentRevisionKey ? await provenance.readSidecar(userId, documentId, cursor.parentRevisionKey).catch(() => null) : null;
  }

  return {
    documentId, tracked: true, revisionId: sidecar.revisionId, path: sidecar.path,
    lastEditedBy, lastEditedAt, authors, origins,
    // Each line: [short hash of its text, author index, origin index or -1].
    blocks: sidecar.blocks.map((block) => ({
      id: block.blockId,
      lines: block.lines.map((line) => [String(line.sha256).slice(0, LINE_HASH_LENGTH), author(line.author), origin(line.originRevisionId)]),
    })),
  };
}
