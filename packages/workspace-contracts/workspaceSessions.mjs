import { normalizeDocumentDock } from "./documentDock.mjs";

const MAX_SESSIONS = 200;
const MAX_SESSION_DOCUMENTS = 2000;
const MAX_NAME_LENGTH = 120;

/** Sessions are optional view state: anything unreadable is dropped rather than failing the workspace. */
export function normalizeWorkspaceSessions(input, conversations) {
  if (!isRecord(input) || !isRecord(input.items)) return undefined;
  const items = {};
  for (const [key, session] of Object.entries(input.items).slice(0, MAX_SESSIONS)) {
    if (!isRecord(session) || session.id !== key || !key || key.length > 200) continue;
    const name = typeof session.name === "string" ? session.name.trim().slice(0, MAX_NAME_LENGTH) : "";
    const documentIds = [...new Set(Array.isArray(session.documentIds) ? session.documentIds : [])]
      .filter((id) => typeof id === "string" && Object.hasOwn(conversations, id))
      .slice(-MAX_SESSION_DOCUMENTS);
    const createdAt = validDate(session.createdAt) ?? new Date(0).toISOString();
    const documentDock = normalizeDocumentDock(session.documentDock, conversations);
    items[key] = {
      id: key,
      name: name || "Untitled session",
      nameSource: session.nameSource === "user" ? "user" : "auto",
      ...(typeof session.nameKey === "string" && session.nameKey.length <= 4000 ? { nameKey: session.nameKey } : {}),
      color: typeof session.color === "string" && /^#[0-9a-f]{6}$/i.test(session.color) ? session.color : "#0d7a6f",
      documentIds,
      ...(typeof session.activeDocumentId === "string" && Object.hasOwn(conversations, session.activeDocumentId)
        ? { activeDocumentId: session.activeDocumentId } : {}),
      ...(documentDock ? { documentDock } : {}),
      createdAt,
      lastOpenedAt: validDate(session.lastOpenedAt) ?? createdAt,
    };
  }
  const tabIds = [...new Set(Array.isArray(input.tabIds) ? input.tabIds : [])]
    .filter((id) => typeof id === "string" && Object.hasOwn(items, id));
  const activeId = typeof input.activeId === "string" && Object.hasOwn(items, input.activeId) ? input.activeId : null;
  return { items, tabIds, activeId };
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
