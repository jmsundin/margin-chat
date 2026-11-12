import { normalizeAppState } from "../db/validation.mjs";

/**
 * The Postgres projection is a derived index of the Markdown vault. It must
 * never stall a whole account because one document breaks a rule the index
 * checks (a margin note whose source block is gone, an id that two files share,
 * a branch whose source was deleted). Before 2026-11 a single such document
 * made every later projection fail, so search and read_document kept serving
 * a weeks-old copy while the Markdown itself was saved fine.
 *
 * This repairs the parsed state just enough to pass normalizeAppState: the
 * smallest fix for each known rule, and dropping a document from the index
 * (never from the vault) only when nothing smaller works. Each repair is
 * returned as `{ id, reason }` with ids only, never titles or text, so it can
 * be logged.
 */
const MAX_REPAIRS = 500;

const quoted = (message) => [...message.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);

function refreshRoots(state) {
  const roots = Object.values(state.conversations).filter((conversation) => conversation.parentId === null);
  if (!roots.length) return false;
  const rootIds = new Set(roots.map(({ id }) => id));
  if (!rootIds.has(state.rootId)) state.rootId = roots[0].id;
  // The active item only satisfies the root check; the index has no navigation.
  state.activeConversationId = state.rootId;
  state.pinnedThreadIds = (state.pinnedThreadIds ?? []).filter((id) => rootIds.has(id));
  return true;
}

function detach(conversation) {
  conversation.parentId = null;
  conversation.branchAnchor = null;
}

function drop(state, id) {
  delete state.conversations[id];
  for (const conversation of Object.values(state.conversations)) {
    if (conversation.parentId === id) detach(conversation);
    if (conversation.branchAnchor?.sourceConversationId === id) conversation.branchAnchor = null;
    if (Array.isArray(conversation.childIds)) conversation.childIds = conversation.childIds.filter((child) => child !== id);
    if (Array.isArray(conversation.linkedConversationIds)) {
      conversation.linkedConversationIds = conversation.linkedConversationIds.filter((linked) => linked !== id);
    }
  }
  for (const group of Object.values(state.groups ?? {})) {
    if (Array.isArray(group?.conversationIds)) group.conversationIds = group.conversationIds.filter((member) => member !== id);
  }
  if (state.graphLayouts) delete state.graphLayouts[id];
}

/** The later of the conversations holding an item with this id: the copy. */
function laterHolder(state, field, itemId) {
  const holders = Object.values(state.conversations).filter((conversation) =>
    (conversation[field] ?? []).some((item) => item?.id === itemId));
  return holders.at(-1);
}

/** Parent chains that loop never reach a root, and the index can't insert them. */
function breakCycles(state, repairs) {
  const conversations = state.conversations;
  for (const start of Object.values(conversations)) {
    const seen = new Set();
    let current = start;
    while (current?.parentId) {
      if (seen.has(current.id)) {
        detach(current);
        repairs.push({ id: current.id, reason: "parent cycle" });
        break;
      }
      seen.add(current.id);
      current = conversations[current.parentId];
    }
  }
}

/** One repair for one validation error, or null when the error is not understood. */
function repairOnce(state, message) {
  const [first] = quoted(message);
  const conversations = state.conversations;

  if (/^Group "/u.test(message) || /can belong to only one group/u.test(message) || /^groups /u.test(message)) {
    state.groups = {};
    return { id: "groups", reason: "groups reset" };
  }
  if (/^Pinned thread "/u.test(message) || /^pinnedThreadIds/u.test(message)) {
    state.pinnedThreadIds = [];
    return { id: "pinned", reason: "pins reset" };
  }
  if (/^graphLayouts/u.test(message)) {
    if (first && state.graphLayouts?.[first]) delete state.graphLayouts[first];
    else state.graphLayouts = {};
    return { id: first ?? "graphLayouts", reason: "map layout reset" };
  }
  if (/^(?:rootId|activeConversationId)/u.test(message)) {
    if (!refreshRoots(state)) return null;
    return { id: "root", reason: "root reset" };
  }
  if (/references a missing parent/u.test(message) && conversations[first]) {
    detach(conversations[first]);
    return { id: first, reason: "missing parent" };
  }
  if (/^Root conversation ".+" cannot have a branch anchor/u.test(message) && conversations[first]) {
    conversations[first].branchAnchor = null;
    return { id: first, reason: "root with branch anchor" };
  }
  if (/^Anchor "/u.test(message)) {
    const holder = Object.values(conversations).find((conversation) => conversation.branchAnchor?.id === first);
    if (!holder) return null;
    holder.branchAnchor = null;
    return { id: holder.id, reason: "branch source missing" };
  }
  if (/^Duplicate note id "/u.test(message)) {
    const holder = laterHolder(state, "notes", first);
    if (!holder) return null;
    const index = holder.notes.findLastIndex((note) => note?.id === first);
    holder.notes.splice(index, 1);
    return { id: holder.id, reason: "duplicate margin note id" };
  }
  if (/^Note "/u.test(message)) {
    // A margin note the index can't hold (its source block is gone, or it is malformed): only that note is left out.
    const holder = laterHolder(state, "notes", first);
    if (!holder) return null;
    holder.notes = holder.notes.filter((note) => note?.id !== first);
    return { id: holder.id, reason: /must reference a message/u.test(message) ? "margin note source missing" : "margin note unreadable" };
  }
  if (/^Duplicate message id "/u.test(message)) {
    const holder = laterHolder(state, "messages", first);
    if (!holder) return null;
    drop(state, holder.id);
    refreshRoots(state);
    return { id: holder.id, reason: "duplicate message id" };
  }
  // Anything else that names a document: leave that one document out of the index.
  const named = quoted(message).find((id) => conversations[id]);
  if (named) {
    drop(state, named);
    refreshRoots(state);
    return { id: named, reason: message.replace(/"[^"]*"/gu, "\"…\"").slice(0, 160) };
  }
  return null;
}

/**
 * `state` as parsed from the vault (it is changed in place). Returns the state
 * the index can hold and the repairs; throws when it can't be repaired.
 */
export function prepareProjectionState(state) {
  const repairs = [];
  if (!state) return { state, repairs };
  breakCycles(state, repairs);
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt += 1) {
    try {
      normalizeAppState(state);
      return { state, repairs };
    } catch (error) {
      if (error?.statusCode !== 400 || attempt === MAX_REPAIRS) throw error;
      const repair = repairOnce(state, String(error.message ?? ""));
      if (!repair) throw error;
      repairs.push(repair);
      // Never let repairs empty the index: that would read as a deliberately empty vault.
      if (!Object.keys(state.conversations).length) throw error;
    }
  }
  return { state, repairs };
}
