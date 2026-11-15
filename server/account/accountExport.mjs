/**
 * Everything the account keeps in Postgres rather than in the vault, as one JSON
 * object: who the account is, its billing history, interface settings, flashcards
 * with every review, and the language words being learned. "Download vault" puts
 * this beside the vault's files, so a download really holds all of a person's data.
 * Each part is read on its own: a part that fails is reported in `missing` instead
 * of failing the whole download.
 */
export const ACCOUNT_EXPORT_PATH = "margin-chat-account.json";
const PAGE = 2000;
const MAX_PAGES = 500;

async function readAllPages(read) {
  const rows = [];
  let cursor = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await read(cursor);
    rows.push(...result.rows);
    if (!result.more || result.cursor === cursor) break;
    cursor = result.cursor;
  }
  return rows;
}

export async function buildAccountExport({ database, user, now = () => new Date() }) {
  const missing = [];
  const part = async (name, read) => {
    if (!database) { missing.push(name); return null; }
    try { return await read(); } catch (error) {
      console.error(`Account export could not read ${name}`, error?.message ?? error);
      missing.push(name);
      return null;
    }
  };
  const userId = user.id;
  const billing = typeof database?.getBillingDashboard === "function" ? await part("billing", () => database.getBillingDashboard(userId)) : null;
  const interfaceSettings = typeof database?.readInterfaceSettings === "function"
    ? await part("interfaceSettings", () => database.readInterfaceSettings({ userId })) : null;
  let flashcards = null;
  if (typeof database?.readFlashcardChanges === "function") {
    flashcards = await part("flashcards", async () => {
      const cards = [];
      const reviews = [];
      let cardSince = 0;
      let reviewSince = 0;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await database.readFlashcardChanges({ userId, cardSince, reviewSince, limit: PAGE });
        cards.push(...result.cards);
        reviews.push(...result.reviews);
        if (!result.more || (result.cardCursor === cardSince && result.reviewCursor === reviewSince)) break;
        cardSince = result.cardCursor;
        reviewSince = result.reviewCursor;
      }
      return { cards, reviews };
    });
  }
  const languageTerms = typeof database?.readLanguageTerms === "function"
    ? await part("languageTerms", () => readAllPages(async (since) => {
      const result = await database.readLanguageTerms({ userId, since, limit: PAGE });
      return { rows: result.terms, cursor: result.cursor, more: result.more };
    })) : null;

  return {
    schemaVersion: 1,
    exportedAt: now().toISOString(),
    account: { id: user.id, name: user.displayName ?? user.name ?? null, email: user.email ?? null },
    billing,
    interfaceSettings,
    flashcards,
    languageTerms,
    ...(missing.length ? { missing } : {}),
  };
}
