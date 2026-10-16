import { useEffect } from "react";
import type { Conversation, WorkspaceSessions } from "../types";
import { requestClusterLabel } from "./api";
import { getDocumentPreview } from "./documentSources";
import { getSessionRootDocuments } from "./workspaceSessions";

const STORAGE_PREFIX = "margin-chat:session-names:v1:";
const MAX_CACHED_NAMES = 300;
const MAX_DOCUMENTS_IN_PROMPT = 24;
const MAX_PROMPT_LENGTH = 6_000;
const DEBOUNCE_MS = 1_200;
// One attempt per membership per page load, so a failing provider is not asked on every change.
const attempted = new Set<string>();

type NameCache = Record<string, string>;

function readCache(userId: string): NameCache {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_PREFIX + userId) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
  } catch { return {}; }
}

function writeCache(userId: string, nameKey: string, name: string) {
  const entries = Object.entries({ ...readCache(userId), [nameKey]: name }).slice(-MAX_CACHED_NAMES);
  try { localStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify(Object.fromEntries(entries))); } catch { /* Best effort. */ }
}

/** Titles and short excerpts of the session's document families, within the title endpoint's prompt limit. */
export function buildSessionNamePrompt(documentIds: string[], conversations: Record<string, Conversation>) {
  const lines: string[] = [];
  let length = 0;
  for (const root of getSessionRootDocuments({ documentIds }, conversations).slice(0, MAX_DOCUMENTS_IN_PROMPT)) {
    const preview = getDocumentPreview(root, 140);
    const line = `- ${root.title.trim() || "Untitled"}${preview && preview !== "No content yet" ? `: ${preview}` : ""}`;
    if (length + line.length + 1 > MAX_PROMPT_LENGTH) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.length > 1 ? `Documents someone is working on together in one session:\n${lines.join("\n")}` : "";
}

/**
 * Names sessions that hold more than one document family from what those
 * documents are about. A single family keeps its title, which already says it.
 * With AI assistance (Jev) off nothing is sent and the titles stay.
 */
export function useSessionAutoNames({ userId, enabled, sessions, conversations, onName }: {
  userId: string;
  enabled: boolean;
  sessions: WorkspaceSessions | undefined;
  conversations: Record<string, Conversation>;
  onName: (sessionId: string, nameKey: string, name: string) => void;
}) {
  const wanted = Object.values(sessions?.items ?? {})
    .filter((session) => session.nameSource === "auto" && session.nameKey && session.nameKey.includes("|"));
  const wantedKey = wanted.map((session) => `${session.id}=${session.nameKey}`).join(",");

  useEffect(() => {
    if (!userId || !wanted.length) return;
    const cache = readCache(userId);
    // Names already written for this membership apply at once, even with Jev off later.
    for (const session of wanted) if (cache[session.nameKey!]) onName(session.id, session.nameKey!, cache[session.nameKey!]);
    if (!enabled) return;
    const missing = wanted.filter((session) => !cache[session.nameKey!] && !attempted.has(`${userId}:${session.nameKey}`));
    if (!missing.length) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      for (const session of missing) {
        if (controller.signal.aborted) return;
        const content = buildSessionNamePrompt(session.documentIds, conversations);
        if (!content) continue;
        attempted.add(`${userId}:${session.nameKey}`);
        try {
          const name = await requestClusterLabel({ content, expectedUserId: userId, signal: controller.signal });
          if (controller.signal.aborted) return;
          writeCache(userId, session.nameKey!, name);
          onName(session.id, session.nameKey!, name);
        } catch {
          if (controller.signal.aborted) attempted.delete(`${userId}:${session.nameKey}`);
        }
      }
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
    // Membership changes start requests; `conversations` and `onName` are read when a pass starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, enabled, wantedKey]);
}
