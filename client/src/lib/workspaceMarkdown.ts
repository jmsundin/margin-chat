import type {
  AppState,
  Conversation,
  ConversationNote,
  Message,
} from "../types";
import {
  createAppStateFromWorkspaceMetadata,
  createWorkspaceDocumentMetadata,
  WORKSPACE_DOCUMENT_SCHEMA_VERSION,
  type WorkspaceDocumentMetadata,
} from "./workspaceModel";

export const MARKDOWN_WORKSPACE_FORMAT_VERSION = 3;

export interface MarkdownWorkspaceFileRecord {
  id: string;
  path: string;
  type: "conversation" | "note";
}

export interface MarkdownWorkspaceManifest {
  files: MarkdownWorkspaceFileRecord[];
  formatVersion: number;
  savedAt: string;
  workspace: WorkspaceDocumentMetadata;
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
): {
  files: Record<string, string>;
  manifest: MarkdownWorkspaceManifest;
} {
  const conversationPathById = new Map<string, string>();
  const annotationPathById = new Map<string, string>();

  for (const conversation of Object.values(state.conversations)) {
    conversationPathById.set(
      conversation.id,
      getConversationMarkdownPath(conversation),
    );

    const primaryNote = getPrimaryStandaloneNote(conversation);
    for (const note of conversation.notes ?? []) {
      if (note !== primaryNote) {
        annotationPathById.set(note.id, getAnnotationMarkdownPath(note.id));
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
    const body =
      conversation.kind === "note"
        ? [
            renderFrontmatter(conversation, "note"),
            serializeMetadata(metadata),
            `# ${title}`,
            relationships,
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
            "## Messages",
            contextMessages,
          ]
            .filter((section) => section !== "")
            .join("\n\n");

    files[path] = body;
    fileRecords.push({ id: conversation.id, path, type: "conversation" });

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
      fileRecords.push({ id: note.id, path: notePath, type: "note" });
    }
  }

  return {
    files,
    manifest: {
      files: fileRecords.sort((left, right) => left.path.localeCompare(right.path)),
      formatVersion: MARKDOWN_WORKSPACE_FORMAT_VERSION,
      savedAt,
      workspace: createWorkspaceDocumentMetadata(state),
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
    files,
    formatVersion: MARKDOWN_WORKSPACE_FORMAT_VERSION,
    savedAt: candidate.savedAt,
    workspace: candidate.workspace as WorkspaceDocumentMetadata,
  };
}

export function parseMarkdownWorkspace(
  manifest: MarkdownWorkspaceManifest,
  fileContents: Record<string, string>,
): AppState | null {
  try {
    const recordByTarget = new Map<string, MarkdownWorkspaceFileRecord>();
    for (const record of manifest.files) {
      for (const target of getLinkTargetAliases(record.path)) {
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
        const parsed = parseConversationFile(source);
        if (!parsed || parsed.conversation.id !== record.id) return null;
        parsedConversations.set(record.id, parsed);
      } else {
        const parsed = parseNoteFile(source);
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

    return createAppStateFromWorkspaceMetadata(manifest.workspace, conversations);
  } catch {
    return null;
  }
}

function parseConversationFile(source: string): ParsedConversationFile | null {
  const metadata = parseMetadata(source);
  if (!metadata || metadata.entityType !== "conversation") return null;

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
  const match = /^<!-- margin-chat-metadata (.+) -->$/m.exec(source);
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
  const marker = "\n## Note\n\n";
  const index = source.lastIndexOf(marker);
  return index === -1 ? "" : source.slice(index + marker.length);
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
    /^(?:Chats|Notes)\/[^/]+\.md$/u.test(record.path) &&
    (record.type === "conversation" || record.type === "note")
  );
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
