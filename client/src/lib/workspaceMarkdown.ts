import type {
  AppState,
  Conversation,
  ConversationNote,
  ConversationDocument,
  Message,
} from "../types";
import {
  createAppStateFromWorkspaceMetadata,
  createWorkspaceDocumentMetadata,
  WORKSPACE_DOCUMENT_SCHEMA_VERSION,
  type WorkspaceDocumentMetadata,
} from "./workspaceModel";
import { DEFAULT_BACKEND_SERVICE_ID, getDefaultModelIdForService } from "./services";

export const MARKDOWN_WORKSPACE_FORMAT_VERSION = 3;

export interface MarkdownWorkspaceFileRecord {
  id: string;
  path: string;
  type: "conversation" | "note";
  aliases?: string[];
}

export interface MarkdownWorkspaceManifest {
  files: MarkdownWorkspaceFileRecord[];
  formatVersion: number;
  savedAt: string;
  workspace: WorkspaceDocumentMetadata;
}

export interface MarkdownWorkspace {
  files: Record<string, string>;
  manifest: MarkdownWorkspaceManifest;
}

type ConversationFileMetadata = {
  conversation: Omit<
    Conversation,
    "childIds" | "messages" | "notes" | "parentId"
  >;
  entityType: "conversation";
  primaryNote: {
    index: number;
    note: Omit<ConversationNote, "content">;
  } | null;
  schemaVersion: 1;
};

type NoteFileMetadata = {
  entityType: "note";
  index: number;
  note: Omit<ConversationNote, "content">;
  schemaVersion: 1;
};

type EntityMetadata = ConversationFileMetadata | NoteFileMetadata;

type ParsedConversationFile = {
  childTargets: string[];
  conversation: Conversation;
  noteTargets: string[];
  parentTarget: string | null;
  primaryNoteIndex: number | null;
};

type ParsedNoteFile = {
  index: number;
  note: ConversationNote;
  parentTarget: string | null;
};

export function createMarkdownWorkspace(
  state: AppState,
  savedAt = new Date().toISOString(),
  previousWorkspace?: MarkdownWorkspace,
): MarkdownWorkspace {
  const result = renderMarkdownWorkspace(state, savedAt, previousWorkspace?.manifest);
  if (!previousWorkspace) return result;
  for (const [path, source] of Object.entries(previousWorkspace.files)) {
    if (isAuxiliaryMarkdownPath(path)) result.files[path] = source;
  }
  const previousState = parseMarkdownWorkspace(previousWorkspace.manifest, previousWorkspace.files);
  if (!previousState) throw new Error("Existing Markdown could not be parsed. Its files were preserved.");
  const representedIds = new Set(Object.values(previousState.conversations).flatMap((conversation) => [conversation.id, ...(conversation.notes ?? []).map((note) => note.id)]));
  // A temporarily missing parent must not cause its standalone annotation file to disappear.
  for (const record of previousWorkspace.manifest.files) {
    if (!representedIds.has(record.id) && previousWorkspace.files[record.path] !== undefined) {
      result.files[record.path] = previousWorkspace.files[record.path];
      result.manifest.files.push(record);
    }
  }
  result.manifest.files.sort((left, right) => left.path.localeCompare(right.path));
  const previousRendered = renderMarkdownWorkspace(previousState, savedAt, previousWorkspace.manifest);
  for (const record of result.manifest.files) {
    const raw = previousWorkspace.files[record.path];
    const canonical = previousRendered.files[record.path];
    if (raw === undefined || canonical === undefined) continue;
    if (result.files[record.path] === canonical) {
      result.files[record.path] = raw;
    } else {
      result.files[record.path] = preserveMarkdownEdits(raw, canonical, result.files[record.path], record);
    }
  }
  return result;
}

function renderMarkdownWorkspace(
  state: AppState,
  savedAt: string,
  previousManifest?: MarkdownWorkspaceManifest,
): MarkdownWorkspace {
  const previousRecords = new Map(previousManifest?.files.map((record) => [record.id, record]));
  const conversationPathById = new Map<string, string>();
  const annotationPathById = new Map<string, string>();

  for (const conversation of Object.values(state.conversations)) {
    conversationPathById.set(
      conversation.id,
      previousRecords.get(conversation.id)?.path ?? getConversationMarkdownPath(conversation),
    );

    const primaryNote = getPrimaryStandaloneNote(conversation);
    for (const note of conversation.notes ?? []) {
      if (note !== primaryNote) {
        annotationPathById.set(note.id, previousRecords.get(note.id)?.path ?? getAnnotationMarkdownPath(note.id));
      }
    }
  }

  const files: Record<string, string> = {};
  const fileRecords: MarkdownWorkspaceFileRecord[] = [];

  for (const conversation of Object.values(state.conversations)) {
    const path = conversationPathById.get(conversation.id)!;
    const primaryNote = getPrimaryStandaloneNote(conversation);
    const primaryNoteIndex = primaryNote
      ? (conversation.notes ?? []).indexOf(primaryNote)
      : -1;
    const {
      childIds: _childIds,
      messages: _messages,
      notes: _notes,
      parentId: _parentId,
      ...conversationMetadata
    } = conversation;
    const metadata: ConversationFileMetadata = {
      conversation: {
        ...conversationMetadata,
        kind: conversation.kind === "note" ? "note" : "chat",
      },
      entityType: "conversation",
      primaryNote: primaryNote
        ? {
            index: primaryNoteIndex,
            note: omitNoteContent(primaryNote),
          }
        : null,
      schemaVersion: 1,
    };
    const relationships = renderConversationRelationships({
      annotationPathById,
      conversation,
      conversationPathById,
      conversations: state.conversations,
      primaryNote,
    });
    const title = sanitizeHeading(conversation.title);
    const contextMessages = renderMessages(conversation.messages);
    const attachments = renderAttachments(conversation.documents ?? [], path);
    const body =
      conversation.kind === "note"
        ? [
            renderFrontmatter(conversation, "note"),
            serializeMetadata(metadata),
            `# ${title}`,
            relationships,
            attachments,
            contextMessages ? `## Context messages\n\n${contextMessages}` : "",
            "## Note",
            primaryNote?.content ?? "",
          ]
            .filter((section) => section !== "")
            .join("\n\n")
        : [
            renderFrontmatter(conversation, "chat"),
            serializeMetadata(metadata),
            `# ${title}`,
            relationships,
            attachments,
            "## Messages",
            contextMessages,
          ]
            .filter((section) => section !== "")
            .join("\n\n");

    files[path] = body;
    fileRecords.push({ ...previousRecords.get(conversation.id), id: conversation.id, path, type: "conversation" });

    for (const [index, note] of (conversation.notes ?? []).entries()) {
      if (note === primaryNote) continue;

      const notePath = annotationPathById.get(note.id)!;
      const noteMetadata: NoteFileMetadata = {
        entityType: "note",
        index,
        note: omitNoteContent(note),
        schemaVersion: 1,
      };
      const parentPath = conversationPathById.get(conversation.id)!;
      const noteTitle = buildAnnotationTitle(note, conversation.title);

      files[notePath] = [
        renderNoteFrontmatter(note, noteTitle),
        serializeMetadata(noteMetadata),
        `# ${sanitizeHeading(noteTitle)}`,
        "## Relationships",
        `- Parent: ${renderWikiLink(parentPath, conversation.title)}`,
        "## Note",
        note.content,
      ].join("\n\n");
      fileRecords.push({ ...previousRecords.get(note.id), id: note.id, path: notePath, type: "note" });
    }
  }

  return {
    files,
    manifest: {
      ...previousManifest,
      files: fileRecords.sort((left, right) => left.path.localeCompare(right.path)),
      formatVersion: MARKDOWN_WORKSPACE_FORMAT_VERSION,
      savedAt,
      workspace: {
        ...previousManifest?.workspace,
        ...createWorkspaceDocumentMetadata(state),
        preferences: { ...previousManifest?.workspace.preferences, ...createWorkspaceDocumentMetadata(state).preferences },
        view: { ...previousManifest?.workspace.view, ...createWorkspaceDocumentMetadata(state).view },
      },
    },
  };
}

export function parseMarkdownWorkspaceManifest(
  input: unknown,
): MarkdownWorkspaceManifest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const candidate = input as Partial<MarkdownWorkspaceManifest>;
  if (
    candidate.formatVersion !== MARKDOWN_WORKSPACE_FORMAT_VERSION ||
    typeof candidate.savedAt !== "string" ||
    Number.isNaN(Date.parse(candidate.savedAt)) ||
    !candidate.workspace ||
    typeof candidate.workspace !== "object" ||
    candidate.workspace.schemaVersion !== WORKSPACE_DOCUMENT_SCHEMA_VERSION ||
    !Array.isArray(candidate.files)
  ) {
    return null;
  }

  const files = candidate.files.filter(isMarkdownWorkspaceFileRecord);
  if (files.length !== candidate.files.length) return null;

  return {
    ...candidate,
    files,
    formatVersion: MARKDOWN_WORKSPACE_FORMAT_VERSION,
    savedAt: candidate.savedAt,
    workspace: candidate.workspace as WorkspaceDocumentMetadata,
  };
}

/** Rebuild the file registry from actual Markdown, never from absent-file assumptions. */
export function discoverMarkdownWorkspace(
  files: Record<string, string>,
  fallbackManifest?: MarkdownWorkspaceManifest,
  previousFiles: Record<string, string> = {},
): MarkdownWorkspace {
  const previousByPath = new Map(fallbackManifest?.files.map((record) => [record.path, record]));
  const records: MarkdownWorkspaceFileRecord[] = [];
  const ids = new Set<string>();
  for (const [path, source] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isSafeMarkdownPath(path) || isAuxiliaryMarkdownPath(path)) continue;
    let metadata: EntityMetadata | null;
    try {
      metadata = parseMetadata(source);
    } catch {
      throw new Error(`Invalid Markdown metadata in ${path}. The file was preserved.`);
    }
    if (!metadata && /<!--\s*margin-chat-metadata\b/.test(source)) {
      throw new Error(`Invalid Markdown metadata in ${path}. The file was preserved.`);
    }
    const exactRenames = [...previousByPath.values()].filter((record) =>
      files[record.path] === undefined && previousFiles[record.path] === source,
    );
    const previous = previousByPath.get(path) ?? (exactRenames.length === 1 ? exactRenames[0] : undefined);
    const id = metadata?.entityType === "conversation" ? metadata.conversation.id
      : metadata?.entityType === "note" ? metadata.note.id
      : parseFrontmatterString(source, "margin-chat-id") || previous?.id || `markdown-${safeFileId(path)}`;
    if (typeof id !== "string" || !id || ids.has(id)) {
      throw new Error(`Duplicate or invalid Markdown identity in ${path}. Both files were preserved.`);
    }
    ids.add(id);
    const matchingPrevious = previous ?? fallbackManifest?.files.find((record) => record.id === id);
    const aliases = [...new Set([
      ...(matchingPrevious?.aliases ?? []),
      ...(matchingPrevious && matchingPrevious.path !== path ? [matchingPrevious.path] : []),
    ])].filter((alias) => alias !== path);
    records.push({ id, path, type: metadata?.entityType === "note" ? "note" : "conversation", ...(aliases.length ? { aliases } : {}) });
  }
  const defaultServiceId = DEFAULT_BACKEND_SERVICE_ID;
  const workspace = fallbackManifest?.workspace ?? {
    schemaVersion: WORKSPACE_DOCUMENT_SCHEMA_VERSION,
    preferences: { defaultServiceId, defaultModelId: getDefaultModelIdForService(defaultServiceId) },
    view: { activeItemId: "", activeRootId: "", graphLayouts: {}, groups: {}, pinnedItemIds: [], railOpen: false },
  };
  return {
    files: Object.fromEntries(Object.entries(files).filter(([path]) => isSafeMarkdownPath(path))),
    manifest: {
      ...fallbackManifest,
      files: records,
      formatVersion: MARKDOWN_WORKSPACE_FORMAT_VERSION,
      savedAt: fallbackManifest?.savedAt ?? "1970-01-01T00:00:00.000Z",
      workspace,
    },
  };
}

/** Plain imports gain a portable identity before synchronization; their body stays untouched. */
export function assignMarkdownFileIdentities(workspace: MarkdownWorkspace): MarkdownWorkspace {
  const files = { ...workspace.files };
  for (const record of workspace.manifest.files) {
    const source = files[record.path];
    if (source === undefined || parseMetadata(source) || parseFrontmatterString(source, "margin-chat-id") === record.id) continue;
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    const field = `margin-chat-id: ${JSON.stringify(record.id)}`;
    if (/^---\r?\n/.test(source) && /^---\r?\n[\s\S]*?\r?\n---/.test(source)) {
      files[record.path] = source.replace(/^---\r?\n/, (opening) => `${opening}${field}${newline}`);
    } else {
      files[record.path] = `---${newline}${field}${newline}---${newline}${source}`;
    }
  }
  return { ...workspace, files };
}

export function parseMarkdownWorkspace(
  manifest: MarkdownWorkspaceManifest,
  fileContents: Record<string, string>,
): AppState | null {
  try {
    const recordByTarget = new Map<string, MarkdownWorkspaceFileRecord>();
    for (const record of manifest.files) {
      for (const target of [record.path, ...(record.aliases ?? [])].flatMap(getLinkTargetAliases)) {
        recordByTarget.set(target, record);
      }
    }

    const parsedConversations = new Map<string, ParsedConversationFile>();
    const parsedNotes: Array<{
      file: ParsedNoteFile;
      record: MarkdownWorkspaceFileRecord;
    }> = [];

    for (const record of manifest.files) {
      const source = fileContents[record.path];
      if (typeof source !== "string") return null;

      if (record.type === "conversation") {
        const parsed = parseConversationFile(source.replace(/\r\n/g, "\n"), record, manifest.workspace);
        if (!parsed || parsed.conversation.id !== record.id) return null;
        parsedConversations.set(record.id, parsed);
      } else {
        const parsed = parseNoteFile(source.replace(/\r\n/g, "\n"));
        if (!parsed || parsed.note.id !== record.id) return null;
        parsedNotes.push({ file: parsed, record });
      }
    }

    const conversations = Object.fromEntries(
      [...parsedConversations].map(([id, parsed]) => [id, parsed.conversation]),
    ) as Record<string, Conversation>;

    for (const [conversationId, parsed] of parsedConversations) {
      const parentRecord = parsed.parentTarget
        ? resolveLinkRecord(recordByTarget, parsed.parentTarget)
        : null;

      conversations[conversationId].parentId =
        parentRecord?.type === "conversation" ? parentRecord.id : null;
    }

    const notesByConversation = new Map<
      string,
      Array<{ index: number; note: ConversationNote }>
    >();
    for (const [conversationId, parsed] of parsedConversations) {
      const primaryNote = parsed.conversation.notes?.[0];
      if (primaryNote && parsed.primaryNoteIndex !== null) {
        notesByConversation.set(conversationId, [
          { index: parsed.primaryNoteIndex, note: primaryNote },
        ]);
      }
    }

    for (const { file } of parsedNotes) {
      const parentRecord = file.parentTarget
        ? resolveLinkRecord(recordByTarget, file.parentTarget)
        : null;
      if (parentRecord?.type !== "conversation") continue;

      const bucket = notesByConversation.get(parentRecord.id) ?? [];
      bucket.push({ index: file.index, note: file.note });
      notesByConversation.set(parentRecord.id, bucket);
    }

    for (const [conversationId, parsed] of parsedConversations) {
      const referencedNotes = parsed.noteTargets
        .map((target) => resolveLinkRecord(recordByTarget, target))
        .filter(
          (record): record is MarkdownWorkspaceFileRecord =>
            record?.type === "note",
        );

      for (const noteRecord of referencedNotes) {
        const parsedNote = parsedNotes.find(
          (candidate) => candidate.record.path === noteRecord.path,
        );
        if (!parsedNote) continue;

        const alreadyAttached = [...notesByConversation.values()].some((notes) =>
          notes.some(({ note }) => note.id === parsedNote.file.note.id),
        );
        if (!alreadyAttached) {
          const bucket = notesByConversation.get(conversationId) ?? [];
          bucket.push({ index: parsedNote.file.index, note: parsedNote.file.note });
          notesByConversation.set(conversationId, bucket);
        }
      }
    }

    for (const conversation of Object.values(conversations)) {
      conversation.childIds = [];
      conversation.notes = (notesByConversation.get(conversation.id) ?? [])
        .sort((left, right) => left.index - right.index)
        .map(({ note }) => note);
    }

    for (const conversation of Object.values(conversations)) {
      if (conversation.parentId && conversations[conversation.parentId]) {
        conversations[conversation.parentId].childIds.push(conversation.id);
      }
    }

    for (const [conversationId, parsed] of parsedConversations) {
      const linkedChildren = parsed.childTargets
        .map((target) => resolveLinkRecord(recordByTarget, target))
        .filter(
          (record): record is MarkdownWorkspaceFileRecord =>
            record?.type === "conversation" &&
            conversations[record.id]?.parentId === conversationId,
        )
        .map((record) => record.id);
      const linkedChildSet = new Set(linkedChildren);
      const remainingChildren = conversations[conversationId].childIds
        .filter((id) => !linkedChildSet.has(id))
        .sort((left, right) =>
          conversations[left].createdAt.localeCompare(conversations[right].createdAt),
        );
      conversations[conversationId].childIds = [
        ...linkedChildren,
        ...remainingChildren,
      ];
    }

    const state = createAppStateFromWorkspaceMetadata(manifest.workspace, conversations);
    const firstId = Object.values(conversations).find((conversation) => !conversation.parentId)?.id ?? Object.keys(conversations)[0] ?? "";
    if (!conversations[state.activeConversationId]) state.activeConversationId = firstId;
    if (!conversations[state.rootId]) state.rootId = firstId;
    state.graphLayouts ??= {};
    state.groups ??= {};
    state.pinnedThreadIds ??= [];
    return state;
  } catch {
    return null;
  }
}

function parseConversationFile(source: string, record: MarkdownWorkspaceFileRecord, workspace: WorkspaceDocumentMetadata): ParsedConversationFile | null {
  const metadata = parseMetadata(source);
  if (!metadata) return /<!--\s*margin-chat-metadata\b/.test(source) ? null : parsePlainMarkdownNote(source, record, workspace);
  if (metadata.entityType !== "conversation") return null;

  const relationships = parseRelationships(source);
  const isNote = metadata.conversation.kind === "note";
  const messages = parseMessages(source);
  if (!messages) return null;
  const primaryNote = metadata.primaryNote
    ? {
        ...metadata.primaryNote.note,
        content: isNote ? parseNoteBody(source) : "",
      }
    : null;

  return {
    childTargets: relationships.childTargets,
    conversation: {
      ...metadata.conversation,
      childIds: [],
      messages,
      notes: primaryNote ? [primaryNote] : [],
      parentId: null,
      title:
        parseFrontmatterString(source, "title")?.trim() ||
        metadata.conversation.title,
    },
    noteTargets: relationships.noteTargets,
    parentTarget: relationships.parentTarget,
    primaryNoteIndex: metadata.primaryNote?.index ?? null,
  };
}

function parseNoteFile(source: string): ParsedNoteFile | null {
  const metadata = parseMetadata(source);
  if (!metadata || metadata.entityType !== "note") return null;
  const relationships = parseRelationships(source);

  return {
    index: metadata.index,
    note: {
      ...metadata.note,
      content: parseNoteBody(source),
    },
    parentTarget: relationships.parentTarget,
  };
}

function parseMetadata(source: string): EntityMetadata | null {
  const match = /^<!-- margin-chat-metadata (.+) -->\r?$/m.exec(source);
  if (!match) return null;

  const parsed = JSON.parse(match[1]) as EntityMetadata;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schemaVersion !== 1 ||
    (parsed.entityType !== "conversation" && parsed.entityType !== "note")
  ) {
    return null;
  }

  return parsed;
}

function parseRelationships(source: string) {
  const relationshipStart = source.indexOf("## Relationships");
  const contentStarts = [source.indexOf("\n## Messages"), source.indexOf("\n## Context messages"), source.indexOf("\n## Note")]
    .filter((index) => index > relationshipStart);
  const relationshipEnd = contentStarts.length
    ? Math.min(...contentStarts)
    : source.length;
  const section = relationshipStart === -1
    ? ""
    : source.slice(relationshipStart, relationshipEnd);
  const parentMatch = /^- Parent:\s*(?:\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|None)\s*$/m.exec(
    section,
  );

  return {
    childTargets: getRelationshipTargets(section, "Child"),
    noteTargets: getRelationshipTargets(section, "Note"),
    parentTarget: parentMatch?.[1]?.trim() ?? null,
  };
}

function getRelationshipTargets(section: string, relationship: "Child" | "Note") {
  const pattern = new RegExp(
    `^- ${relationship}:\\s*\\[\\[([^\\]|]+)(?:\\|[^\\]]*)?\\]\\]\\s*$`,
    "gm",
  );
  return [...section.matchAll(pattern)].map((match) => match[1].trim());
}

function parseMessages(source: string): Message[] | null {
  const marker = /^<!-- margin-chat-message (.+) -->$/gm;
  const messages: Message[] = [];
  let match: RegExpExecArray | null;

  while ((match = marker.exec(source))) {
    const metadata = JSON.parse(match[1]) as Message & { contentLength?: number };
    let contentFrom = marker.lastIndex;
    if (source[contentFrom] === "\r") contentFrom += 1;
    if (source[contentFrom] === "\n") contentFrom += 1;

    const expectedContentTo =
      typeof metadata.contentLength === "number"
        ? contentFrom + metadata.contentLength
        : -1;
    const endMarker = "\n<!-- margin-chat-message-end -->";
    const contentTo =
      expectedContentTo >= contentFrom &&
      source.startsWith(endMarker, expectedContentTo)
        ? expectedContentTo
        : source.indexOf(endMarker, contentFrom);

    if (
      contentTo === -1 ||
      typeof metadata.id !== "string" ||
      !["assistant", "system", "user"].includes(metadata.role) ||
      typeof metadata.createdAt !== "string"
    ) {
      return null;
    }

    messages.push({
      content: source.slice(contentFrom, contentTo),
      createdAt: metadata.createdAt,
      id: metadata.id,
      role: metadata.role,
    });
    marker.lastIndex = contentTo + endMarker.length;
  }

  return messages;
}

function parseNoteBody(source: string) {
  const marker = /^## Note\r?\n\r?\n/gm;
  const messageRanges = messageBlocks(source).map((block) => [block.start, block.end]);
  for (const match of source.matchAll(marker)) {
    if (!messageRanges.some(([start, end]) => match.index >= start && match.index <= end)) {
      return source.slice(match.index + match[0].length);
    }
  }
  return "";
}

function parseFrontmatterString(source: string, key: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
  if (!frontmatter) return null;
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter);
  if (!match) return null;

  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" ? value : null;
  } catch {
    return match[1].trim().replace(/^['"]|['"]$/g, "");
  }
}

function parsePlainMarkdownNote(
  source: string,
  record: MarkdownWorkspaceFileRecord,
  workspace: WorkspaceDocumentMetadata,
): ParsedConversationFile {
  const createdAt = validDate(parseFrontmatterString(source, "created")) ?? "1970-01-01T00:00:00.000Z";
  const updatedAt = validDate(parseFrontmatterString(source, "updated")) ?? createdAt;
  const content = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, "");
  const title = parseFrontmatterString(source, "title") || /^#\s+(.+)$/m.exec(content)?.[1]?.trim()
    || record.path.split("/").at(-1)!.replace(/\.md$/i, "");
  return {
    childTargets: [], noteTargets: [], parentTarget: null, primaryNoteIndex: 0,
    conversation: {
      id: record.id, kind: "note", title, parentId: null, childIds: [], branchAnchor: null,
      serviceId: workspace.preferences.defaultServiceId,
      modelId: workspace.preferences.defaultModelId,
      createdAt, updatedAt, messages: [], documents: [],
      notes: [{ id: `${record.id}-body`, kind: "standalone", content, createdAt, updatedAt,
        sourceMessageId: null, startOffset: null, endOffset: null, quote: null }],
    },
  };
}

function validDate(value: string | null) {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Preserve the user's bytes outside the app fields that actually changed. */
function preserveMarkdownEdits(raw: string, before: string, after: string, record: MarkdownWorkspaceFileRecord) {
  if (!parseMetadata(raw)) {
    // An ordinary Markdown note acquires stable identity only when edited in-app.
    return mergeFrontmatter(raw, after, before);
  }
  let result = raw;
  const beforeMeta = /^<!-- margin-chat-metadata .+ -->$/m.exec(before)?.[0];
  const afterMeta = /^<!-- margin-chat-metadata .+ -->$/m.exec(after)?.[0];
  if (beforeMeta !== afterMeta && afterMeta) result = result.replace(/^<!-- margin-chat-metadata .+ -->\r?$/m, () => afterMeta);
  const beforeTitle = parseFrontmatterString(before, "title");
  const afterTitle = parseFrontmatterString(after, "title");
  if (beforeTitle !== afterTitle && afterTitle) result = result.replace(/^# .+$/m, () => `# ${sanitizeHeading(afterTitle)}`);
  result = mergeFrontmatter(raw, result, before, after);
  const beforeAttachments = attachmentSection(before);
  const afterAttachments = attachmentSection(after);
  if (beforeAttachments !== afterAttachments) {
    const existing = attachmentSection(result);
    if (existing) result = result.replace(existing, () => afterAttachments);
    else if (afterAttachments) result = insertAttachmentSection(result, afterAttachments);
  }

  const beforeRelationships = parseRelationships(before);
  const afterRelationships = parseRelationships(after);
  if (JSON.stringify(beforeRelationships) !== JSON.stringify(afterRelationships)) {
    const newLines = relationshipLines(after);
    const start = result.indexOf("## Relationships");
    if (start !== -1) {
      const tail = result.slice(start);
      const endOffset = tail.search(/\n## (?!Relationships\b)/);
      const end = endOffset === -1 ? result.length : start + endOffset;
      const section = result.slice(start, end).replace(/^- (?:Parent|Child|Note):.*(?:\r?\n|$)/gm, "");
      result = result.slice(0, start) + section.replace(/^## Relationships\r?\n/, () => `## Relationships\n${newLines}\n`) + result.slice(end);
    }
  }
  const beforeMessages = messageBlocks(before);
  const afterMessages = messageBlocks(after);
  const rawMessages = messageBlocks(result);
  for (const block of [...rawMessages].reverse()) {
    const next = afterMessages.find((candidate) => candidate.id === block.id);
    const previous = beforeMessages.find((candidate) => candidate.id === block.id);
    if (!next) result = result.slice(0, block.start) + result.slice(block.end);
    else if (next.text !== previous?.text) result = result.slice(0, block.start) + next.text + result.slice(block.end);
  }
  const additions = afterMessages.filter((block) => !beforeMessages.some((previous) => previous.id === block.id));
  if (additions.length) {
    const existing = messageBlocks(result);
    const noteBody = parseNoteBody(result);
    const noteStart = result.length - noteBody.length;
    const insertion = existing.at(-1)?.end ?? (record.type === "note" || parseMetadata(result)?.entityType === "conversation" && (parseMetadata(result) as ConversationFileMetadata).conversation.kind === "note"
      ? Math.max(0, result.lastIndexOf("## Note", noteStart)) : result.length);
    const text = additions.map((block) => block.text).join("\n\n");
    result = result.slice(0, insertion) + `\n\n${text}\n\n` + result.slice(insertion);
  }
  const oldBody = parseNoteBody(before);
  const newBody = parseNoteBody(after);
  if (oldBody !== newBody) {
    const currentBody = parseNoteBody(result);
    if (/^## Note\r?$/m.test(result)) result = result.slice(0, result.length - currentBody.length) + newBody;
  }
  return result;
}

function relationshipLines(source: string) {
  const start = source.indexOf("## Relationships");
  if (start === -1) return "";
  const endOffset = source.slice(start).search(/\n## (?!Relationships\b)/);
  const section = source.slice(start, endOffset === -1 ? undefined : start + endOffset);
  return section.split(/\r?\n/).filter((line) => /^- (?:Parent|Child|Note):/.test(line)).join("\n");
}

export function getAttachmentVaultPath(document: Pick<ConversationDocument, "id" | "filename">) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(document.id)) return null;
  const filename = String(document.filename ?? "attachment").replace(/[\\/\u0000-\u001f%:#?]/gu, "_").replace(/^\.+$/u, "attachment").slice(0, 180) || "attachment";
  return `Attachments/${document.id}/${filename === "metadata.json" ? "original-metadata.json" : filename}`;
}

function renderAttachments(documents: ConversationDocument[], sourcePath: string) {
  const prefix = "../".repeat(Math.max(0, sourcePath.split("/").length - 1));
  const links = documents.flatMap((document) => {
    const path = getAttachmentVaultPath(document);
    if (!path) return [];
    const href = prefix + path.split("/").map((segment) => encodeURIComponent(segment).replaceAll("(", "%28").replaceAll(")", "%29")).join("/");
    const label = document.filename.replace(/[\\\[\]]/g, (character) => `\\${character}`).replace(/\r?\n/g, " ");
    return [`- [${label}](${href})`];
  });
  return links.length ? `<!-- margin-chat-attachments -->\n## Attachments\n${links.join("\n")}\n<!-- margin-chat-attachments-end -->` : "";
}

function attachmentSection(source: string) {
  return /<!-- margin-chat-attachments -->\r?\n[\s\S]*?<!-- margin-chat-attachments-end -->/.exec(source)?.[0] ?? "";
}

function insertAttachmentSection(source: string, section: string) {
  const content = source.search(/^## (?:Messages|Context messages|Note)\r?$/m);
  return content === -1 ? `${source}\n\n${section}` : `${source.slice(0, content)}${section}\n\n${source.slice(content)}`;
}

function messageBlocks(source: string) {
  const blocks: Array<{ id: string; start: number; end: number; text: string }> = [];
  const marker = /^<!-- margin-chat-message (.+) -->\r?$/gm;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(source))) {
    const metadata = JSON.parse(match[1]);
    const endMarker = "<!-- margin-chat-message-end -->";
    const contentStart = marker.lastIndex + (source[marker.lastIndex] === "\r" ? 2 : 1);
    const expectedEnd = contentStart + metadata.contentLength + 1;
    const endStart = Number.isFinite(expectedEnd) && source.startsWith(endMarker, expectedEnd) ? expectedEnd : source.indexOf(endMarker, marker.lastIndex);
    if (endStart === -1) break;
    const precedingHeading = /### [^\n]+\r?\n$/.exec(source.slice(0, match.index));
    const start = precedingHeading?.index ?? match.index;
    const end = endStart + endMarker.length;
    blocks.push({ id: metadata.id, start, end, text: source.slice(start, end) });
    marker.lastIndex = end;
  }
  return blocks;
}

function mergeFrontmatter(raw: string, result: string, before: string, after = result) {
  const pattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/;
  const original = pattern.exec(raw);
  const next = pattern.exec(after);
  if (!next) return result;
  const lines = original ? original[1].split(/\r?\n/) : [];
  for (const line of next[1].split(/\r?\n/)) {
    const key = /^([^:#\s][^:]*):/.exec(line)?.[1];
    if (!key) continue;
    const index = lines.findIndex((entry) => entry.startsWith(`${key}:`));
    const changed = parseFrontmatterString(before, key) !== parseFrontmatterString(after, key);
    if (index === -1) lines.push(line);
    else if (changed) lines[index] = line;
  }
  const frontmatter = `---\n${lines.join("\n")}\n---\n`;
  return pattern.test(result) ? result.replace(pattern, () => frontmatter) : frontmatter + result;
}

function renderConversationRelationships(args: {
  annotationPathById: Map<string, string>;
  conversation: Conversation;
  conversationPathById: Map<string, string>;
  conversations: Record<string, Conversation>;
  primaryNote: ConversationNote | null;
}) {
  const parent = args.conversation.parentId
    ? args.conversations[args.conversation.parentId]
    : null;
  const lines = [
    "## Relationships",
    parent
      ? `- Parent: ${renderWikiLink(
          args.conversationPathById.get(parent.id)!,
          parent.title,
        )}`
      : "- Parent: None",
  ];

  for (const childId of args.conversation.childIds) {
    const child = args.conversations[childId];
    const path = child ? args.conversationPathById.get(child.id) : null;
    if (child && path) lines.push(`- Child: ${renderWikiLink(path, child.title)}`);
  }

  for (const note of args.conversation.notes ?? []) {
    if (note === args.primaryNote) continue;
    const path = args.annotationPathById.get(note.id);
    if (path) lines.push(`- Note: ${renderWikiLink(path, buildAnnotationTitle(note, args.conversation.title))}`);
  }

  return lines.join("\n");
}

function renderMessages(messages: Message[]) {
  return messages
    .map((message) => {
      const metadata = safeJson({
        contentLength: message.content.length,
        createdAt: message.createdAt,
        id: message.id,
        role: message.role,
      });
      const role = message.role[0].toUpperCase() + message.role.slice(1);
      return [
        `### ${role} · ${message.createdAt}`,
        `<!-- margin-chat-message ${metadata} -->`,
        message.content,
        "<!-- margin-chat-message-end -->",
      ].join("\n");
    })
    .join("\n\n");
}

function renderFrontmatter(
  conversation: Conversation,
  kind: "chat" | "note",
) {
  return [
    "---",
    `margin-chat-id: ${JSON.stringify(conversation.id)}`,
    `margin-chat-kind: ${kind}`,
    `title: ${JSON.stringify(conversation.title)}`,
    `created: ${JSON.stringify(conversation.createdAt)}`,
    `updated: ${JSON.stringify(conversation.updatedAt)}`,
    `tags: [margin-chat, ${kind}]`,
    "---",
  ].join("\n");
}

function renderNoteFrontmatter(note: ConversationNote, title: string) {
  return [
    "---",
    `margin-chat-id: ${JSON.stringify(note.id)}`,
    "margin-chat-kind: note",
    `margin-chat-note-kind: ${note.kind ?? "comment"}`,
    `title: ${JSON.stringify(title)}`,
    `created: ${JSON.stringify(note.createdAt)}`,
    `updated: ${JSON.stringify(note.updatedAt)}`,
    "tags: [margin-chat, note]",
    "---",
  ].join("\n");
}

function serializeMetadata(metadata: EntityMetadata) {
  return `<!-- margin-chat-metadata ${safeJson(metadata)} -->`;
}

function safeJson(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

function renderWikiLink(path: string, label: string) {
  const target = path.replace(/\.md$/i, "");
  const safeLabel = label
    .replaceAll("]", ")")
    .replaceAll("|", "¦")
    .replace(/\s+/g, " ");
  return `[[${target}|${safeLabel}]]`;
}

function getConversationMarkdownPath(conversation: Conversation) {
  const directory = conversation.kind === "note" ? "Notes" : "Chats";
  const prefix = conversation.kind === "note" ? "note" : "chat";
  return `${directory}/${prefix}-${safeFileId(conversation.id)}.md`;
}

function getAnnotationMarkdownPath(noteId: string) {
  return `Notes/note-${safeFileId(noteId)}.md`;
}

function safeFileId(id: string) {
  const slug = id
    .normalize("NFKD")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "item";
  return `${slug}-${hashString(id)}`;
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getPrimaryStandaloneNote(conversation: Conversation) {
  if (conversation.kind !== "note") return null;
  return (
    (conversation.notes ?? []).find((note) => note.kind === "standalone") ?? null
  );
}

function omitNoteContent(note: ConversationNote): Omit<ConversationNote, "content"> {
  const { content: _content, ...metadata } = note;
  return metadata;
}

function buildAnnotationTitle(note: ConversationNote, conversationTitle: string) {
  const firstTextLine = note.content
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  const preview = firstTextLine?.slice(0, 64);
  return preview ? `Note — ${preview}` : `Note on ${conversationTitle}`;
}

function sanitizeHeading(value: string) {
  return value.replace(/\r?\n/g, " ").trim() || "Untitled";
}

function isMarkdownWorkspaceFileRecord(
  input: unknown,
): input is MarkdownWorkspaceFileRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Partial<MarkdownWorkspaceFileRecord>;
  return (
    typeof record.id === "string" &&
    Boolean(record.id) &&
    typeof record.path === "string" &&
    isSafeMarkdownPath(record.path) &&
    (record.aliases === undefined || Array.isArray(record.aliases) && record.aliases.every((alias) => typeof alias === "string" && isSafeMarkdownPath(alias))) &&
    (record.type === "conversation" || record.type === "note")
  );
}

export function isSafeMarkdownPath(path: string) {
  return Boolean(path) && /\.md$/i.test(path) && !/[\\\u0000-\u001f]/u.test(path)
    && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.startsWith("."));
}

function isAuxiliaryMarkdownPath(path: string) {
  return /^(?:_conflicts|attachments)\//i.test(path);
}

function getLinkTargetAliases(path: string) {
  const withoutExtension = path.replace(/\.md$/i, "");
  const basename = withoutExtension.slice(withoutExtension.lastIndexOf("/") + 1);
  return [path, withoutExtension, basename];
}

function resolveLinkRecord(
  records: Map<string, MarkdownWorkspaceFileRecord>,
  target: string,
) {
  const normalized = target.replace(/^\.\//, "").replace(/\.md$/i, "");
  return records.get(normalized) ?? records.get(normalized.split("/").at(-1) ?? "");
}
