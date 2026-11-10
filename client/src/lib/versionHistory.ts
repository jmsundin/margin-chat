import { createEmptyState } from "../initialState";
import { getEditableDocumentText } from "./editableDocument";
import type { VaultFile } from "./vaultTypes";
import { vaultToState } from "./vaultWorkspace";

/**
 * Earlier versions of a document, read from the recovery records the vault already keeps in
 * `.margin-chat/history/<id>/`: one for every time two devices changed the same words, one for
 * every restore (holding the text the restore replaced), and automatic versions kept while editing
 * (vaultSnapshots.ts). Nothing here changes the vault.
 */
export type VersionRole = "kept" | "device" | "before-restore" | "snapshot";

export interface DocumentVersion {
  /** `<record id>:<role file>`, stable across reloads and devices. */
  key: string;
  recordId: string;
  role: VersionRole;
  /** When the record was made. */
  at: string;
  file: VaultFile;
}

export interface VersionRecord {
  id: string;
  at: string;
  reason: "clash" | "restore" | "snapshot";
  path: string;
  versions: DocumentVersion[];
}

const identityOf = (content: string) => /^margin-chat-id:[ \t]*"?([^"\r\n]+?)"?[ \t]*\r?$/m.exec(content)?.[1];

function readFile(files: Record<string, VaultFile>, prefix: string, reference: unknown): VaultFile | null {
  if (typeof reference !== "string" || !reference.startsWith(prefix)) return null;
  const file = files[reference];
  return file && !file.encoding ? file : null;
}

/** Every saved version of one document, newest first. `path` is where the document lives now. */
export function listDocumentVersions(files: Record<string, VaultFile>, documentId: string, path: string | undefined): VersionRecord[] {
  const records: VersionRecord[] = [];
  for (const [descriptorPath, descriptorFile] of Object.entries(files)) {
    const match = /^(\.margin-chat\/history\/([^/]+)\/)conflict\.json$/.exec(descriptorPath);
    if (!match || descriptorFile.encoding) continue;
    let descriptor: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(descriptorFile.content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      descriptor = parsed as Record<string, unknown>;
    } catch { continue; }
    const reason = descriptor.reason === "restore" || descriptor.reason === "snapshot" ? descriptor.reason
      : descriptor.conflicted === true ? "clash" : null;
    if (!reason || typeof descriptor.path !== "string" || typeof descriptor.createdAt !== "string" || !/\.md$/iu.test(descriptor.path)) continue;
    const [prefix, id] = [match[1], match[2]];
    const local = readFile(files, `${prefix}local/`, descriptor.copy);
    const remote = readFile(files, `${prefix}remote/`, descriptor.remoteCopy);
    const result = readFile(files, `${prefix}result/`, descriptor.resultCopy);
    // The record belongs to this document when it was at this path or carries its identity (it may have been renamed since).
    const sample = local ?? remote ?? result;
    if (descriptor.path !== path && (!sample || identityOf(sample.content) !== documentId)) continue;
    const versions: DocumentVersion[] = [];
    const add = (role: VersionRole, name: string, file: VaultFile | null) => {
      if (!file || versions.some((version) => version.file.content === file.content)) return;
      versions.push({ key: `${id}:${name}`, recordId: id, role, at: descriptor.createdAt as string, file });
    };
    if (reason === "restore") add("before-restore", "local", local);
    else if (reason === "snapshot") add("snapshot", "local", local);
    else {
      add("kept", "result", result);
      add("device", "local", local);
      add("device", "remote", remote);
    }
    if (versions.length) records.push({ id, at: descriptor.createdAt, reason, path: descriptor.path, versions });
  }
  return records.sort((a, b) => b.at.localeCompare(a.at));
}

/** The readable text of a saved version, as the editor would show it. */
export function versionText(path: string, file: VaultFile): string {
  try {
    const state = vaultToState({ [path]: file }, createEmptyState());
    const conversation = Object.values(state.conversations).find((item) => identityOf(file.content) ? item.id === identityOf(file.content) : true);
    return (conversation ? getEditableDocumentText(conversation) : file.content).replace(/\n{3,}/gu, "\n\n").trim();
  } catch {
    return file.content;
  }
}

export type DiffPart = { kind: "same" | "added" | "removed"; text: string };

/**
 * Word-level differences from `from` to `to`, for highlighting what a version would change.
 * Very long texts fall back to showing the whole version as one block.
 */
export function diffWords(from: string, to: string, maxCells = 4_000_000): DiffPart[] {
  const split = (value: string) => value.match(/\s+|[^\s]+/gu) ?? [];
  const a = split(from), b = split(to);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text; else parts.push({ kind, text });
  };
  push("same", a.slice(0, start).join(""));
  if ((midA.length + 1) * (midB.length + 1) > maxCells) {
    push("removed", midA.join(""));
    push("added", midB.join(""));
  } else {
    const width = midB.length + 1;
    const table = new Uint32Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i -= 1) for (let j = midB.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = midA[i] === midB[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
    let i = 0, j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) { push("same", midA[i]); i += 1; j += 1; }
      else if (j < midB.length && (i === midA.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) { push("added", midB[j]); j += 1; }
      else { push("removed", midA[i]); i += 1; }
    }
  }
  push("same", a.slice(endA).join(""));
  return coalesce(parts);
}

/**
 * Reads changes as whole phrases: changes separated only by spaces become one struck-through phrase
 * followed by one new phrase, instead of alternating word by word.
 */
function coalesce(parts: DiffPart[]): DiffPart[] {
  const result: DiffPart[] = [];
  let removed = "", added = "";
  const flush = () => {
    if (removed) result.push({ kind: "removed", text: removed });
    if (added) result.push({ kind: "added", text: added });
    removed = ""; added = "";
  };
  parts.forEach((part, index) => {
    if (part.kind === "same") {
      const changed = removed || added;
      const nextChanges = parts[index + 1] && parts[index + 1].kind !== "same";
      // A space between two changes belongs to both sides, so each side still reads as it was written.
      if (changed && nextChanges && /^[^\S\n]+$/u.test(part.text)) { removed += part.text; added += part.text; return; }
      flush(); result.push({ ...part }); return;
    }
    if (part.kind === "removed") removed += part.text;
    else added += part.text;
  });
  flush();
  return result.filter((part) => part.text);
}
