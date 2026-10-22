const DAY_MS = 24 * 60 * 60 * 1000;
/** Someone who has used Margin Chat this long, and never brought in old chats, gets one reminder. */
export const CHAT_IMPORT_REMIND_AFTER_MS = 3 * DAY_MS;

const recordKey = (userId: string) => `margin-chat:chat-import-reminder:${userId}`;

/** What this browser knows about bringing chats in from other apps. */
export interface ChatImportRecord {
  /** When this browser first opened the workspace for this account. */
  firstSeenAt?: number;
  /** Chats were imported, or the reminder was shown; either way it never shows again. */
  done?: boolean;
}

export function loadChatImportRecord(userId: string): ChatImportRecord {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(recordKey(userId)) ?? "{}");
    if (!stored || typeof stored !== "object") return {};
    const { firstSeenAt, done } = stored as Record<string, unknown>;
    return {
      ...(typeof firstSeenAt === "number" && Number.isFinite(firstSeenAt) ? { firstSeenAt } : {}),
      ...(done === true ? { done } : {}),
    };
  } catch {
    return {};
  }
}

export function saveChatImportRecord(userId: string, record: ChatImportRecord) {
  try { localStorage.setItem(recordKey(userId), JSON.stringify(record)); }
  catch { /* Without storage the reminder stays hidden, since it can't remember being shown. */ }
}

/** Records the first visit, and says whether the one-time reminder is due now. */
export function chatImportReminderDue(userId: string, now = Date.now()): boolean {
  const record = loadChatImportRecord(userId);
  if (record.done) return false;
  if (record.firstSeenAt === undefined) {
    saveChatImportRecord(userId, { firstSeenAt: now });
    return false;
  }
  return now - record.firstSeenAt >= CHAT_IMPORT_REMIND_AFTER_MS;
}

export function finishChatImportReminder(userId: string) {
  saveChatImportRecord(userId, { ...loadChatImportRecord(userId), done: true });
}
