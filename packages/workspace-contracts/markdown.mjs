import { createAppStateFromWorkspaceMetadata, createWorkspaceDocumentMetadata, WORKSPACE_DOCUMENT_SCHEMA_VERSION, } from "./workspaceModel.mjs";
import { normalizeAIExecution } from "./ai.mjs";
import { normalizePublicTopicSource, normalizeLinkedConversationIds } from "./exploration.mjs";
import { normalizeEditableDocument } from "./editableDocument.mjs";
import { normalizeDocumentLayout } from "./documentLayout.mjs";
import { DEFAULT_WORKSPACE_PREFERENCES } from "./workspaceModel.mjs";
import { encodeReadableMarkdown, decodeReadableMarkdown, isReadableMarkdown } from "./markdownReadable.mjs";
import { titleMarkdownPath, legacyMarkdownPath } from "./markdownPaths.mjs";
export { encodeReadableMarkdown, decodeReadableMarkdown, isReadableMarkdown } from "./markdownReadable.mjs";
export const MARKDOWN_WORKSPACE_FORMAT_VERSION = 4;

function decodeWorkspace(workspace) {
    if (!workspace) return undefined;
    return { ...workspace, files: Object.fromEntries(Object.entries(workspace.files).map(([path, source]) =>
        [path, isAuxiliaryMarkdownPath(path) ? source : decodeReadableMarkdown(source)])) };
}
function encodeWorkspace(workspace, previous, decodedPrevious) {
    const files = { ...workspace.files };
    for (const record of workspace.manifest.files) {
        const source = files[record.path];
        files[record.path] = decodedPrevious?.files[record.path] === source
            ? previous.files[record.path] : encodeReadableMarkdown(source);
    }
    return { ...workspace, files };
}
export function createMarkdownWorkspace(state, savedAt = new Date().toISOString(), previousWorkspace, options = {}) {
    const decoded = decodeWorkspace(previousWorkspace);
    return encodeWorkspace(createLegacyMarkdownWorkspace(state, savedAt, decoded, options), previousWorkspace, decoded);
}

function createLegacyMarkdownWorkspace(state, savedAt = new Date().toISOString(), previousWorkspace, options = {}) {
    const result = renderMarkdownWorkspace(state, savedAt, previousWorkspace?.manifest, undefined, options.preservePaths);
    if (!previousWorkspace)
        return result;
    for (const [path, source] of Object.entries(previousWorkspace.files)) {
        if (isAuxiliaryMarkdownPath(path))
            result.files[path] = source;
    }
    const previousState = parseMarkdownWorkspace(previousWorkspace.manifest, previousWorkspace.files);
    if (!previousState)
        throw new Error("Existing Markdown could not be parsed. Its files were preserved.");
    const representedIds = new Set(Object.values(previousState.conversations).flatMap((conversation) => [conversation.id, ...(conversation.notes ?? []).map((note) => note.id)]));
    // A temporarily missing parent must not cause its standalone annotation file to disappear.
    for (const record of previousWorkspace.manifest.files) {
        if (!representedIds.has(record.id) && previousWorkspace.files[record.path] !== undefined) {
            result.files[record.path] = previousWorkspace.files[record.path];
            result.manifest.files.push(record);
        }
    }
    result.manifest.files.sort((left, right) => left.path.localeCompare(right.path));
    const previousRendered = renderMarkdownWorkspace(previousState, savedAt, previousWorkspace.manifest, undefined, true);
    const previousRecords = new Map(previousWorkspace.manifest.files.map((record) => [record.id, record]));
    for (const record of result.manifest.files) {
        const previousPath = previousRecords.get(record.id)?.path;
        const raw = previousWorkspace.files[previousPath];
        const canonical = previousRendered.files[previousPath];
        if (raw === undefined || canonical === undefined)
            continue;
        if (result.files[record.path] === canonical) {
            result.files[record.path] = raw;
        }
        else {
            result.files[record.path] = preserveMarkdownEdits(raw, canonical, result.files[record.path], record);
        }
    }
    return result;
}
/** Reuses unchanged documents between immutable editor snapshots. External snapshots
 * and relationship changes deliberately take the complete recovery/validation path. */
export function createMarkdownWorkspaceRenderer() {
    const render = createLegacyMarkdownWorkspaceRenderer();
    let previousResult;
    let previousDecoded;
    return (state, savedAt, workspace) => {
        const decoded = workspace === previousResult ? previousDecoded : decodeWorkspace(workspace);
        const result = render(state, savedAt, decoded);
        const encoded = encodeWorkspace(result, workspace, decoded);
        previousResult = encoded;
        previousDecoded = result;
        return encoded;
    };
}
function createLegacyMarkdownWorkspaceRenderer() {
    let previousState;
    let previousResult;
    let canonicalFiles;
    let requiresFullRecovery = false;
    return (state, savedAt = new Date().toISOString(), workspace) => {
        const ids = Object.keys(state.conversations);
        // Plain notes inherit preferences from the manifest. Their canonical content
        // can change without a new conversation object, so keep full recovery for them.
        const sameStructure = !requiresFullRecovery && previousState && workspace === previousResult
            && ids.length === Object.keys(previousState.conversations).length
            && ids.every((id) => {
                const before = previousState.conversations[id];
                const after = state.conversations[id];
                return before && before.title === after.title && before.kind === after.kind && before.parentId === after.parentId
                    && before.childIds.join("\0") === after.childIds.join("\0")
                    && (before.notes ?? []).map((note) => `${note.id}:${note.kind}:${buildAnnotationTitle(note, before.title)}`).join("\0")
                        === (after.notes ?? []).map((note) => `${note.id}:${note.kind}:${buildAnnotationTitle(note, after.title)}`).join("\0");
            });
        let result;
        if (!sameStructure) {
            result = createLegacyMarkdownWorkspace(state, savedAt, workspace);
            const parsed = parseMarkdownWorkspace(result.manifest, result.files);
            if (!parsed) throw new Error("Saved Markdown could not be parsed. Its files were preserved.");
            canonicalFiles = renderMarkdownWorkspace(parsed, savedAt, result.manifest).files;
            requiresFullRecovery = result.manifest.files.some((record) => record.type === "conversation"
                && !parseMetadata(result.files[record.path] ?? ""));
        } else {
            const changed = new Set(ids.filter((id) => state.conversations[id] !== previousState.conversations[id]));
            const rendered = renderMarkdownWorkspace(state, savedAt, workspace.manifest, changed);
            result = {
                files: { ...workspace.files },
                manifest: { ...rendered.manifest, files: workspace.manifest.files },
            };
            for (const record of rendered.manifest.files) {
                const raw = workspace.files[record.path];
                const before = canonicalFiles[record.path];
                const after = rendered.files[record.path];
                result.files[record.path] = raw === undefined || before === undefined ? after
                    : before === after ? raw : preserveMarkdownEdits(raw, before, after, record);
            }
            canonicalFiles = { ...canonicalFiles, ...rendered.files };
        }
        previousState = state;
        previousResult = result;
        return result;
    };
}

function renderMarkdownWorkspace(state, savedAt, previousManifest, selectedConversationIds, preservePaths = false) {
    const previousRecords = new Map(previousManifest?.files.map((record) => [record.id, record]));
    const plannedRecords = new Map();
    const conversationPathById = new Map();
    const annotationPathById = new Map();
    // Reserve imported paths before allocating generated names, including on case-insensitive disks.
    const reserved = new Set((previousManifest?.files ?? []).map((record) => pathKey(record.path)));
    function plan(id, title, folder, type) {
        const previous = previousRecords.get(id);
        const owned = !previous || previous.managedPath === previous.path
            || (!previous.managedPath && previous.path === legacyMarkdownPath(folder, id));
        let path = previous?.path;
        if ((!preservePaths && owned) || !path) {
            const desired = titleMarkdownPath(folder, title, id);
            path = desired;
            let ordinal = 2;
            while (reserved.has(pathKey(path)) && pathKey(path) !== pathKey(previous?.path ?? "")) {
                path = desired.replace(/\.md$/, ` (${ordinal++}).md`);
            }
        }
        reserved.add(pathKey(path));
        const aliases = [...new Set([...(previous?.aliases ?? []),
            ...(previous && previous.path !== path ? [previous.path] : [])])].filter((alias) => alias !== path);
        const record = { ...previous, id, path, type,
            ...(owned && !preservePaths ? { managedPath: path } : {}),
            ...(aliases.length ? { aliases } : {}) };
        plannedRecords.set(id, record);
        return path;
    }
    for (const conversation of Object.values(state.conversations).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
        conversationPathById.set(conversation.id, plan(conversation.id, conversation.title, conversation.kind === "note" ? "Notes" : "Chats", "conversation"));
        const primaryNote = getPrimaryStandaloneNote(conversation);
        for (const note of conversation.notes ?? []) {
            if (note !== primaryNote) {
                annotationPathById.set(note.id, plan(note.id, buildAnnotationTitle(note, conversation.title), "Notes", "note"));
            }
        }
    }
    const files = {};
    const fileRecords = [];
    for (const conversation of Object.values(state.conversations)) {
        if (selectedConversationIds && !selectedConversationIds.has(conversation.id)) continue;
        const path = conversationPathById.get(conversation.id);
        const primaryNote = getPrimaryStandaloneNote(conversation);
        const primaryNoteIndex = primaryNote
            ? (conversation.notes ?? []).indexOf(primaryNote)
            : -1;
        const { childIds: _childIds, messages: _messages, notes: _notes, parentId: _parentId, ...conversationMetadata } = conversation;
        const metadata = {
            file: portableFileRecord(plannedRecords.get(conversation.id)),
            conversation: {
                ...conversationMetadata,
                ...(conversation.document ? { document: { ...conversation.document, blocks: [] } } : {}),
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
        const documentBody = conversation.document ? renderEditableDocument(conversation.document) : "";
        const body = conversation.kind === "note"
            ? [
                renderFrontmatter(conversation, "note"),
                serializeMetadata(metadata),
                `# ${title}`,
                relationships,
                attachments,
                documentBody,
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
                documentBody,
                "## Messages",
                contextMessages,
            ]
                .filter((section) => section !== "")
                .join("\n\n");
        files[path] = body;
        fileRecords.push(plannedRecords.get(conversation.id));
        for (const [index, note] of (conversation.notes ?? []).entries()) {
            if (note === primaryNote)
                continue;
            const notePath = annotationPathById.get(note.id);
            const noteMetadata = {
                file: portableFileRecord(plannedRecords.get(note.id)),
                entityType: "note",
                index,
                note: omitNoteContent(note),
                schemaVersion: 1,
            };
            const parentPath = conversationPathById.get(conversation.id);
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
            fileRecords.push(plannedRecords.get(note.id));
        }
    }
    const { documentDock: _oldDocumentDock, ...previousView } = previousManifest?.workspace.view ?? {};
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
                view: { ...previousView, ...createWorkspaceDocumentMetadata(state).view },
            },
        },
    };
}
export function parseMarkdownWorkspaceManifest(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return null;
    const candidate = input;
    if (![3, MARKDOWN_WORKSPACE_FORMAT_VERSION].includes(candidate.formatVersion) ||
        typeof candidate.savedAt !== "string" ||
        Number.isNaN(Date.parse(candidate.savedAt)) ||
        !candidate.workspace ||
        typeof candidate.workspace !== "object" ||
        candidate.workspace.schemaVersion !== WORKSPACE_DOCUMENT_SCHEMA_VERSION ||
        !Array.isArray(candidate.files)) {
        return null;
    }
    const files = candidate.files.filter(isMarkdownWorkspaceFileRecord);
    if (files.length !== candidate.files.length)
        return null;
    return {
        ...candidate,
        files,
        formatVersion: MARKDOWN_WORKSPACE_FORMAT_VERSION,
        savedAt: candidate.savedAt,
        workspace: candidate.workspace,
    };
}
/** Rebuild the file registry from actual Markdown, never from absent-file assumptions. */
export function discoverMarkdownWorkspace(files, fallbackManifest, previousFiles = {}) {
    const previousByPath = new Map(fallbackManifest?.files.map((record) => [record.path, record]));
    const records = [];
    const ids = new Set();
    for (const [path, source] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
        if (!isSafeMarkdownPath(path) || isAuxiliaryMarkdownPath(path))
            continue;
        let metadata;
        try {
            metadata = parseMetadata(source);
        }
        catch {
            throw new Error(`Invalid Markdown metadata in ${path}. The file was preserved.`);
        }
        if (!metadata && /<!--\s*margin-chat-metadata\b/.test(source)) {
            throw new Error(`Invalid Markdown metadata in ${path}. The file was preserved.`);
        }
        const exactRenames = [...previousByPath.values()].filter((record) => files[record.path] === undefined && previousFiles[record.path] === source);
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
                ...(Array.isArray(metadata?.file?.aliases) ? metadata.file.aliases.filter((alias) => typeof alias === "string" && isSafeMarkdownPath(alias)) : []),
                ...(typeof metadata?.file?.managedPath === "string" && metadata.file.managedPath !== path && isSafeMarkdownPath(metadata.file.managedPath) ? [metadata.file.managedPath] : []),
                ...(matchingPrevious && matchingPrevious.path !== path ? [matchingPrevious.path] : []),
            ])].filter((alias) => alias !== path);
        const managedPath = metadata?.file?.managedPath ?? matchingPrevious?.managedPath;
        records.push({ id, path, type: metadata?.entityType === "note" ? "note" : "conversation",
            ...(typeof managedPath === "string" && isSafeMarkdownPath(managedPath) ? { managedPath } : {}),
            ...(aliases.length ? { aliases } : {}) });
    }
    const { defaultServiceId, defaultModelId } = DEFAULT_WORKSPACE_PREFERENCES;
    const workspace = fallbackManifest?.workspace ?? {
        schemaVersion: WORKSPACE_DOCUMENT_SCHEMA_VERSION,
        preferences: { defaultServiceId, defaultModelId },
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
export function assignMarkdownFileIdentities(workspace) {
    const files = { ...workspace.files };
    for (const record of workspace.manifest.files) {
        const source = files[record.path];
        if (source === undefined || parseMetadata(source) || parseFrontmatterString(source, "margin-chat-id") === record.id)
            continue;
        const newline = source.includes("\r\n") ? "\r\n" : "\n";
        const field = `margin-chat-id: ${JSON.stringify(record.id)}`;
        if (/^---\r?\n/.test(source) && /^---\r?\n[\s\S]*?\r?\n---/.test(source)) {
            files[record.path] = source.replace(/^---\r?\n/, (opening) => `${opening}${field}${newline}`);
        }
        else {
            files[record.path] = `---${newline}${field}${newline}---${newline}${source}`;
        }
    }
    return { ...workspace, files };
}
export function parseMarkdownWorkspace(manifest, fileContents) {
    try {
        const recordByTarget = new Map();
        for (const record of manifest.files) {
            for (const target of [record.path, ...(record.aliases ?? [])].flatMap(getLinkTargetAliases)) {
                recordByTarget.set(target, record);
            }
        }
        // Current paths take precedence over historical aliases that have since been reused.
        for (const record of manifest.files) {
            for (const target of getLinkTargetAliases(record.path)) recordByTarget.set(target, record);
        }
        const parsedConversations = new Map();
        const parsedNotes = [];
        for (const record of manifest.files) {
            const source = fileContents[record.path];
            if (typeof source !== "string")
                return null;
            if (record.type === "conversation") {
                const parsed = parseConversationFile(decodeReadableMarkdown(source).replace(/\r\n/g, "\n"), record, manifest.workspace);
                if (!parsed || parsed.conversation.id !== record.id)
                    return null;
                parsedConversations.set(record.id, parsed);
            }
            else {
                const parsed = parseNoteFile(decodeReadableMarkdown(source).replace(/\r\n/g, "\n"));
                if (!parsed || parsed.note.id !== record.id)
                    return null;
                parsedNotes.push({ file: parsed, record });
            }
        }
        const conversations = Object.fromEntries([...parsedConversations].map(([id, parsed]) => [id, parsed.conversation]));
        for (const [conversationId, parsed] of parsedConversations) {
            const parentRecord = parsed.parentTarget
                ? resolveLinkRecord(recordByTarget, parsed.parentTarget)
                : null;
            conversations[conversationId].parentId =
                parentRecord?.type === "conversation" ? parentRecord.id : null;
            const linkedIds = (parsed.linkedTargets ?? []).map((target) => resolveLinkRecord(recordByTarget, target))
                .filter((record) => record?.type === "conversation").map((record) => record.id);
            if (linkedIds.length || Array.isArray(conversations[conversationId].linkedConversationIds)) {
                conversations[conversationId].linkedConversationIds = normalizeLinkedConversationIds(linkedIds, conversationId, conversations);
            }
        }
        const notesByConversation = new Map();
        for (const conversation of Object.values(conversations)) {
            const documentLayout = normalizeDocumentLayout(conversation.documentLayout, conversation.id, conversations);
            if (documentLayout) conversation.documentLayout = documentLayout;
            else delete conversation.documentLayout;
        }
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
            if (parentRecord?.type !== "conversation")
                continue;
            const bucket = notesByConversation.get(parentRecord.id) ?? [];
            bucket.push({ index: file.index, note: file.note });
            notesByConversation.set(parentRecord.id, bucket);
        }
        for (const [conversationId, parsed] of parsedConversations) {
            const referencedNotes = parsed.noteTargets
                .map((target) => resolveLinkRecord(recordByTarget, target))
                .filter((record) => record?.type === "note");
            for (const noteRecord of referencedNotes) {
                const parsedNote = parsedNotes.find((candidate) => candidate.record.path === noteRecord.path);
                if (!parsedNote)
                    continue;
                const alreadyAttached = [...notesByConversation.values()].some((notes) => notes.some(({ note }) => note.id === parsedNote.file.note.id));
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
                .filter((record) => record?.type === "conversation" &&
                conversations[record.id]?.parentId === conversationId)
                .map((record) => record.id);
            const linkedChildSet = new Set(linkedChildren);
            const remainingChildren = conversations[conversationId].childIds
                .filter((id) => !linkedChildSet.has(id))
                .sort((left, right) => conversations[left].createdAt.localeCompare(conversations[right].createdAt));
            conversations[conversationId].childIds = [
                ...linkedChildren,
                ...remainingChildren,
            ];
        }
        const state = createAppStateFromWorkspaceMetadata(manifest.workspace, conversations);
        const firstId = Object.values(conversations).find((conversation) => !conversation.parentId)?.id ?? Object.keys(conversations)[0] ?? "";
        if (!conversations[state.activeConversationId])
            state.activeConversationId = firstId;
        if (!conversations[state.rootId])
            state.rootId = firstId;
        state.graphLayouts ??= {};
        state.groups ??= {};
        state.pinnedThreadIds ??= [];
        return state;
    }
    catch {
        return null;
    }
}
function parseConversationFile(source, record, workspace) {
    source = decodeReadableMarkdown(source);
    const metadata = parseMetadata(source);
    if (!metadata)
        return /<!--\s*margin-chat-metadata\b/.test(source) ? null : parsePlainMarkdownNote(source, record, workspace);
    if (metadata.entityType !== "conversation")
        return null;
    const relationships = parseRelationships(source);
    const isNote = metadata.conversation.kind === "note";
    const messages = parseMessages(source);
    if (!messages)
        return null;
    const primaryNote = metadata.primaryNote
        ? {
            ...metadata.primaryNote.note,
            content: isNote ? parseNoteBody(source) : "",
        }
        : null;
    const { publicTopic: rawPublicTopic, linkedConversationIds, document: rawDocument, ...conversationMetadata } = metadata.conversation;
    const documentSection = editableDocumentSection(source);
    const document = rawDocument === undefined ? undefined : documentSection && normalizeEditableDocument({
        ...rawDocument, blocks: parseEditableDocumentContent(documentSection.text, metadata.conversation),
    });
    if (rawDocument !== undefined && !document) return null;
    const publicTopic = normalizePublicTopicSource(rawPublicTopic);
    return {
        childTargets: relationships.childTargets,
        linkedTargets: relationships.linkedTargets,
        conversation: {
            ...conversationMetadata,
            ...(document ? { document } : {}),
            ...(publicTopic ? { publicTopic } : {}),
            ...(Array.isArray(linkedConversationIds) ? { linkedConversationIds } : {}),
            childIds: [],
            messages,
            notes: primaryNote ? [primaryNote] : [],
            parentId: null,
            title: parseFrontmatterString(source, "title")?.trim() ||
                metadata.conversation.title,
        },
        noteTargets: relationships.noteTargets,
        parentTarget: relationships.parentTarget,
        primaryNoteIndex: metadata.primaryNote?.index ?? null,
    };
}
function parseNoteFile(source) {
    source = decodeReadableMarkdown(source);
    const metadata = parseMetadata(source);
    if (!metadata || metadata.entityType !== "note")
        return null;
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
/** Restoring an older version changes content, not ownership of its surviving filename. */
export function preserveMarkdownFileLocation(source, currentSource, path) {
    const current = parseMetadata(currentSource);
    const decoded = decodeReadableMarkdown(source);
    const selected = parseMetadata(decoded);
    const identity = (metadata) => metadata?.entityType === "conversation" ? metadata.conversation?.id : metadata?.note?.id;
    if (!selected || !current || identity(selected) !== identity(current) || !current.file) return source;
    const aliases = [...new Set([...(selected.file?.aliases ?? []), ...(current.file.aliases ?? []),
        selected.file?.managedPath, current.file.managedPath])]
        .filter((alias) => typeof alias === "string" && alias !== path && isSafeMarkdownPath(alias));
    const file = { ...selected.file, ...current.file };
    if (!current.file.managedPath) delete file.managedPath;
    if (aliases.length) file.aliases = aliases;
    else delete file.aliases;
    if (JSON.stringify(file) === JSON.stringify(selected.file)) return source;
    const updated = decoded.replace(/^<!-- margin-chat-metadata .+ -->\r?$/m,
        (line) => serializeMetadata({ ...selected, file }) + (line.endsWith("\r") ? "\r" : ""));
    return isReadableMarkdown(source) ? encodeReadableMarkdown(updated) : updated;
}
function parseMetadata(source) {
    source = decodeReadableMarkdown(source);
    const match = /^<!-- margin-chat-metadata (.+) -->\r?$/m.exec(source);
    if (!match)
        return null;
    const parsed = JSON.parse(match[1]);
    if (!parsed ||
        typeof parsed !== "object" ||
        parsed.schemaVersion !== 1 ||
        (parsed.entityType !== "conversation" && parsed.entityType !== "note")) {
        return null;
    }
    return parsed;
}
function parseRelationships(source) {
    const relationshipStart = source.indexOf("## Relationships");
    const contentStarts = [source.indexOf("\n## Messages"), source.indexOf("\n## Context messages"), source.indexOf("\n## Note"), source.indexOf("\n<!-- margin-chat-document -->")]
        .filter((index) => index > relationshipStart);
    const relationshipEnd = contentStarts.length
        ? Math.min(...contentStarts)
        : source.length;
    const section = relationshipStart === -1
        ? ""
        : source.slice(relationshipStart, relationshipEnd);
    const parentMatch = /^- Parent:\s*(?:\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|None)\s*$/m.exec(section);
    return {
        childTargets: getRelationshipTargets(section, "Child"),
        linkedTargets: getRelationshipTargets(section, "Linked"),
        noteTargets: getRelationshipTargets(section, "Note"),
        parentTarget: parentMatch?.[1]?.trim() ?? null,
    };
}
function getRelationshipTargets(section, relationship) {
    const pattern = new RegExp(`^- ${relationship}:\\s*\\[\\[([^\\]|]+)(?:\\|[^\\]]*)?\\]\\]\\s*$`, "gm");
    return [...section.matchAll(pattern)].map((match) => match[1].trim());
}
function parseMessages(source) {
    const marker = /^<!-- margin-chat-message (.+) -->$/gm;
    const messages = [];
    const documentSection = editableDocumentSection(source);
    let match;
    while ((match = marker.exec(source))) {
        if (documentSection && match.index >= documentSection.start && match.index < documentSection.end) {
            marker.lastIndex = documentSection.end;
            continue;
        }
        const metadata = JSON.parse(match[1]);
        let contentFrom = marker.lastIndex;
        if (source[contentFrom] === "\r")
            contentFrom += 1;
        if (source[contentFrom] === "\n")
            contentFrom += 1;
        const expectedContentTo = typeof metadata.contentLength === "number"
            ? contentFrom + metadata.contentLength
            : -1;
        const endMarker = "\n<!-- margin-chat-message-end -->";
        const contentTo = expectedContentTo >= contentFrom &&
            source.startsWith(endMarker, expectedContentTo)
            ? expectedContentTo
            : source.indexOf(endMarker, contentFrom);
        if (contentTo === -1 ||
            typeof metadata.id !== "string" ||
            !["assistant", "system", "user"].includes(metadata.role) ||
            typeof metadata.createdAt !== "string") {
            return null;
        }
        messages.push({
            content: source.slice(contentFrom, contentTo),
            createdAt: metadata.createdAt,
            id: metadata.id,
            role: metadata.role,
            ...(normalizeAIExecution(metadata.execution) ? { execution: normalizeAIExecution(metadata.execution) } : {}),
        });
        marker.lastIndex = contentTo + endMarker.length;
    }
    return messages;
}
function parseNoteBody(source) {
    const marker = /^## Note\r?\n\r?\n/gm;
    const messageRanges = messageBlocks(source).map((block) => [block.start, block.end]);
    const documentSection = editableDocumentSection(source);
    if (documentSection) messageRanges.push([documentSection.start, documentSection.end]);
    for (const match of source.matchAll(marker)) {
        if (!messageRanges.some(([start, end]) => match.index >= start && match.index <= end)) {
            return source.slice(match.index + match[0].length);
        }
    }
    return "";
}
function parseFrontmatterString(source, key) {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
    if (!frontmatter)
        return null;
    const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter);
    if (!match)
        return null;
    try {
        const value = JSON.parse(match[1]);
        return typeof value === "string" ? value : null;
    }
    catch {
        return match[1].trim().replace(/^['"]|['"]$/g, "");
    }
}
function parsePlainMarkdownNote(source, record, workspace) {
    const createdAt = validDate(parseFrontmatterString(source, "created")) ?? "1970-01-01T00:00:00.000Z";
    const updatedAt = validDate(parseFrontmatterString(source, "updated")) ?? createdAt;
    const content = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, "");
    const title = parseFrontmatterString(source, "title") || /^#\s+(.+)$/m.exec(content)?.[1]?.trim()
        || record.path.split("/").at(-1).replace(/\.md$/i, "");
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
function validDate(value) {
    return value && Number.isFinite(Date.parse(value)) ? value : null;
}
/** Preserve the user's bytes outside the app fields that actually changed. */
function preserveMarkdownEdits(raw, before, after, record) {
    if (!parseMetadata(raw)) {
        // An ordinary Markdown note acquires stable identity only when edited in-app.
        return mergeFrontmatter(raw, after, before);
    }
    let result = raw;
    const beforeMeta = /^<!-- margin-chat-metadata .+ -->$/m.exec(before)?.[0];
    const afterMeta = /^<!-- margin-chat-metadata .+ -->$/m.exec(after)?.[0];
    if (beforeMeta !== afterMeta && afterMeta)
        result = result.replace(/^<!-- margin-chat-metadata .+ -->\r?$/m, () => afterMeta);
    const beforeTitle = parseFrontmatterString(before, "title");
    const afterTitle = parseFrontmatterString(after, "title");
    if (beforeTitle !== afterTitle && afterTitle)
        result = result.replace(/^# .+$/m, () => `# ${sanitizeHeading(afterTitle)}`);
    result = mergeFrontmatter(raw, result, before, after);
    const beforeAttachments = attachmentSection(before);
    const afterAttachments = attachmentSection(after);
    if (beforeAttachments !== afterAttachments) {
        const existing = attachmentSection(result);
        if (existing)
            result = result.replace(existing, () => afterAttachments);
        else if (afterAttachments)
            result = insertAttachmentSection(result, afterAttachments);
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
            const section = result.slice(start, end).replace(/^- (?:Parent|Child|Note|Linked):.*(?:\r?\n|$)/gm, "");
            result = result.slice(0, start) + section.replace(/^## Relationships\r?\n/, () => `## Relationships\n${newLines}\n`) + result.slice(end);
        }
    }
    const beforeDocument = editableDocumentSection(before);
    const afterDocument = editableDocumentSection(after);
    if (beforeDocument?.text !== afterDocument?.text) {
        const existingDocument = editableDocumentSection(result);
        if (existingDocument) {
            result = result.slice(0, existingDocument.start) + (afterDocument?.text ?? "") + result.slice(existingDocument.end);
        } else if (afterDocument) {
            const contentStart = result.search(/^## (?:Messages|Context messages|Note)\r?$/m);
            const insertion = contentStart === -1 ? result.length : contentStart;
            result = result.slice(0, insertion) + `${afterDocument.text}\n\n` + result.slice(insertion);
        }
    }
    const beforeMessages = messageBlocks(before);
    const afterMessages = messageBlocks(after);
    const rawMessages = messageBlocks(result);
    for (const block of [...rawMessages].reverse()) {
        const next = afterMessages.find((candidate) => candidate.id === block.id);
        const previous = beforeMessages.find((candidate) => candidate.id === block.id);
        if (!next)
            result = result.slice(0, block.start) + result.slice(block.end);
        else if (next.text !== previous?.text)
            result = result.slice(0, block.start) + next.text + result.slice(block.end);
    }
    const additions = afterMessages.filter((block) => !beforeMessages.some((previous) => previous.id === block.id));
    if (additions.length) {
        const existing = messageBlocks(result);
        const noteBody = parseNoteBody(result);
        const noteStart = result.length - noteBody.length;
        const insertion = existing.at(-1)?.end ?? (record.type === "note" || parseMetadata(result)?.entityType === "conversation" && parseMetadata(result).conversation.kind === "note"
            ? Math.max(0, result.lastIndexOf("## Note", noteStart)) : result.length);
        const text = additions.map((block) => block.text).join("\n\n");
        result = result.slice(0, insertion) + `\n\n${text}\n\n` + result.slice(insertion);
    }
    const oldBody = parseNoteBody(before);
    const newBody = parseNoteBody(after);
    if (oldBody !== newBody) {
        const currentBody = parseNoteBody(result);
        if (/^## Note\r?$/m.test(result)) {
            const prefix = result.slice(0, result.length - currentBody.length);
            // Empty generated notes end at the heading. A first edit must introduce
            // the same separator as a newly rendered nonempty note before its body.
            result = prefix.replace(/(^|\r?\n)## Note(?:\r?\n)*$/, "$1## Note\n\n") + newBody;
        }
    }
    return result;
}
function relationshipLines(source) {
    const start = source.indexOf("## Relationships");
    if (start === -1)
        return "";
    const endOffset = source.slice(start).search(/\n## (?!Relationships\b)/);
    const section = source.slice(start, endOffset === -1 ? undefined : start + endOffset);
    return section.split(/\r?\n/).filter((line) => /^- (?:Parent|Child|Note|Linked):/.test(line)).join("\n");
}
export function getAttachmentVaultPath(document) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(document.id))
        return null;
    const filename = String(document.filename ?? "attachment").replace(/[\\/\u0000-\u001f%:#?]/gu, "_").replace(/^\.+$/u, "attachment").slice(0, 180) || "attachment";
    return `Attachments/${document.id}/${filename === "metadata.json" ? "original-metadata.json" : filename}`;
}
function renderAttachments(documents, sourcePath) {
    const prefix = "../".repeat(Math.max(0, sourcePath.split("/").length - 1));
    const links = documents.flatMap((document) => {
        const path = getAttachmentVaultPath(document);
        if (!path)
            return [];
        const href = prefix + path.split("/").map((segment) => encodeURIComponent(segment).replaceAll("(", "%28").replaceAll(")", "%29")).join("/");
        const label = document.filename.replace(/[\\\[\]]/g, (character) => `\\${character}`).replace(/\r?\n/g, " ");
        return [`- [${label}](${href})`];
    });
    return links.length ? `<!-- margin-chat-attachments -->\n## Attachments\n${links.join("\n")}\n<!-- margin-chat-attachments-end -->` : "";
}
function attachmentSection(source) {
    return /<!-- margin-chat-attachments -->\r?\n[\s\S]*?<!-- margin-chat-attachments-end -->/.exec(source)?.[0] ?? "";
}
function insertAttachmentSection(source, section) {
    const content = source.search(/^(?:## (?:Messages|Context messages|Note)|<!-- margin-chat-document -->)\r?$/m);
    return content === -1 ? `${source}\n\n${section}` : `${source.slice(0, content)}${section}\n\n${source.slice(content)}`;
}
function messageBlocks(source) {
    const blocks = [];
    const marker = /^<!-- margin-chat-message (.+) -->\r?$/gm;
    const documentSection = editableDocumentSection(source);
    let match;
    while ((match = marker.exec(source))) {
        if (documentSection && match.index >= documentSection.start && match.index < documentSection.end) {
            marker.lastIndex = documentSection.end;
            continue;
        }
        const metadata = JSON.parse(match[1]);
        const endMarker = "<!-- margin-chat-message-end -->";
        const contentStart = marker.lastIndex + (source[marker.lastIndex] === "\r" ? 2 : 1);
        const expectedEnd = contentStart + metadata.contentLength + 1;
        const endStart = Number.isFinite(expectedEnd) && source.startsWith(endMarker, expectedEnd) ? expectedEnd : source.indexOf(endMarker, marker.lastIndex);
        if (endStart === -1)
            break;
        const precedingHeading = /### [^\n]+\r?\n$/.exec(source.slice(0, match.index));
        const start = precedingHeading?.index ?? match.index;
        const end = endStart + endMarker.length;
        blocks.push({ id: metadata.id, start, end, text: source.slice(start, end) });
        marker.lastIndex = end;
    }
    return blocks;
}
function mergeFrontmatter(raw, result, before, after = result) {
    const pattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/;
    const original = pattern.exec(raw);
    const next = pattern.exec(after);
    if (!next)
        return result;
    const lines = original ? original[1].split(/\r?\n/) : [];
    for (const line of next[1].split(/\r?\n/)) {
        const key = /^([^:#\s][^:]*):/.exec(line)?.[1];
        if (!key)
            continue;
        const index = lines.findIndex((entry) => entry.startsWith(`${key}:`));
        const changed = parseFrontmatterString(before, key) !== parseFrontmatterString(after, key);
        if (index === -1)
            lines.push(line);
        else if (changed)
            lines[index] = line;
    }
    const newline = /^---(\r?\n)/.exec(raw)?.[1] ?? "\n";
    const frontmatter = `---${newline}${lines.join(newline)}${newline}---${newline}`;
    return pattern.test(result) ? result.replace(pattern, () => frontmatter) : frontmatter + result;
}
function renderConversationRelationships(args) {
    const parent = args.conversation.parentId
        ? args.conversations[args.conversation.parentId]
        : null;
    const lines = [
        "## Relationships",
        parent
            ? `- Parent: ${renderWikiLink(args.conversationPathById.get(parent.id), parent.title)}`
            : "- Parent: None",
    ];
    for (const childId of args.conversation.childIds) {
        const child = args.conversations[childId];
        const path = child ? args.conversationPathById.get(child.id) : null;
        if (child && path)
            lines.push(`- Child: ${renderWikiLink(path, child.title)}`);
    }
    for (const linkedId of normalizeLinkedConversationIds(args.conversation.linkedConversationIds, args.conversation.id, args.conversations) ?? []) {
        const linked = args.conversations[linkedId];
        const path = args.conversationPathById.get(linkedId);
        if (path) lines.push(`- Linked: ${renderWikiLink(path, linked.title)}`);
    }
    for (const note of args.conversation.notes ?? []) {
        if (note === args.primaryNote)
            continue;
        const path = args.annotationPathById.get(note.id);
        if (path)
            lines.push(`- Note: ${renderWikiLink(path, buildAnnotationTitle(note, args.conversation.title))}`);
    }
    return lines.join("\n");
}
function renderMessages(messages) {
    return messages
        .map((message) => {
        const metadata = safeJson({
            contentLength: message.content.length,
            createdAt: message.createdAt,
            id: message.id,
            role: message.role,
            ...(normalizeAIExecution(message.execution) ? { execution: normalizeAIExecution(message.execution) } : {}),
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
function renderFrontmatter(conversation, kind) {
    const publicTopic = normalizePublicTopicSource(conversation.publicTopic);
    return [
        "---",
        `margin-chat-id: ${JSON.stringify(conversation.id)}`,
        `margin-chat-kind: ${kind}`,
        `title: ${JSON.stringify(conversation.title)}`,
        `created: ${JSON.stringify(conversation.createdAt)}`,
        `updated: ${JSON.stringify(conversation.updatedAt)}`,
        `tags: [margin-chat, ${kind}]`,
        ...(publicTopic ? [
            `public-topic-id: ${JSON.stringify(publicTopic.id)}`,
            `public-topic-label: ${JSON.stringify(publicTopic.label)}`,
            `public-topic-source: ${JSON.stringify(publicTopic.wikidataUrl)}`,
            ...(publicTopic.wikipediaUrl ? [`public-topic-article: ${JSON.stringify(publicTopic.wikipediaUrl)}`] : []),
            `public-topic-retrieved: ${JSON.stringify(publicTopic.retrievedAt)}`,
            ...(publicTopic.revision ? [`public-topic-revision: ${publicTopic.revision}`] : []),
        ] : []),
        "---",
    ].join("\n");
}
function renderNoteFrontmatter(note, title) {
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
function serializeMetadata(metadata) {
    return `<!-- margin-chat-metadata ${safeJson(metadata)} -->`;
}
function safeJson(value) {
    return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}
function renderWikiLink(path, label) {
    const target = path.replace(/\.md$/i, "");
    const safeLabel = label
        .replaceAll("]", ")")
        .replaceAll("|", "¦")
        .replace(/\s+/g, " ");
    return `[[${target}|${safeLabel}]]`;
}
function pathKey(path) { return path.normalize("NFC").toLowerCase(); }
function portableFileRecord(record) {
    return { ...(record.managedPath ? { managedPath: record.managedPath } : {}),
        ...(record.aliases?.length ? { aliases: record.aliases } : {}) };
}
function safeFileId(id) {
    const slug = id
        .normalize("NFKD")
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 96) || "item";
    return `${slug}-${hashString(id)}`;
}
function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}
function getPrimaryStandaloneNote(conversation) {
    if (conversation.kind !== "note")
        return null;
    return ((conversation.notes ?? []).find((note) => note.kind === "standalone") ?? null);
}
function omitNoteContent(note) {
    const { content: _content, ...metadata } = note;
    return metadata;
}
function buildAnnotationTitle(note, conversationTitle) {
    const firstTextLine = note.content
        .split("\n")
        .map((line) => line.replace(/^#+\s*/, "").trim())
        .find(Boolean);
    const preview = firstTextLine?.slice(0, 64);
    return preview ? `Note — ${preview}` : `Note on ${conversationTitle}`;
}
function sanitizeHeading(value) {
    return value.replace(/\r?\n/g, " ").trim() || "Untitled";
}
function isMarkdownWorkspaceFileRecord(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return false;
    const record = input;
    return (typeof record.id === "string" &&
        Boolean(record.id) &&
        typeof record.path === "string" &&
        isSafeMarkdownPath(record.path) &&
        (record.managedPath === undefined || typeof record.managedPath === "string" && isSafeMarkdownPath(record.managedPath)) &&
        (record.aliases === undefined || Array.isArray(record.aliases) && record.aliases.every((alias) => typeof alias === "string" && isSafeMarkdownPath(alias))) &&
        (record.type === "conversation" || record.type === "note"));
}
export function isSafeMarkdownPath(path) {
    return Boolean(path) && /\.md$/i.test(path) && !/[\\\u0000-\u001f]/u.test(path)
        && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.startsWith("."));
}
function isAuxiliaryMarkdownPath(path) {
    return /^(?:_conflicts|attachments)\//i.test(path);
}
function getLinkTargetAliases(path) {
    const withoutExtension = path.replace(/\.md$/i, "");
    const basename = withoutExtension.slice(withoutExtension.lastIndexOf("/") + 1);
    return [path, withoutExtension, basename];
}
function resolveLinkRecord(records, target) {
    const normalized = target.replace(/^\.\//, "").replace(/\.md$/i, "");
    return records.get(normalized) ?? records.get(normalized.split("/").at(-1) ?? "");
}

/** Visible Markdown is authoritative; metadata carries settings/history, never a second body. */
function renderEditableDocument(document) {
    const blocks = document.blocks.map(({ content, ...metadata }) =>
        `<!-- margin-chat-document-block ${JSON.stringify({ ...metadata, contentLength: content.length })} -->\n${content}\n<!-- margin-chat-document-block-end ${JSON.stringify(metadata.id)} -->`);
    return ["<!-- margin-chat-document -->", "## Document", ...blocks, "<!-- margin-chat-document-end -->"].join("\n\n");
}

function editableDocumentBlocks(source, start = 0) {
    const blocks = [];
    const marker = /^<!-- margin-chat-document-block (.+) -->\r?$/gm;
    marker.lastIndex = start;
    let match;
    while ((match = marker.exec(source))) {
        const metadata = JSON.parse(match[1]);
        if (typeof metadata.id !== "string") throw new Error("Invalid document block identity.");
        const contentStart = marker.lastIndex + (source[marker.lastIndex] === "\r" ? 2 : 1);
        const endMarker = `\n<!-- margin-chat-document-block-end ${JSON.stringify(metadata.id)} -->`;
        const expectedEnd = contentStart + metadata.contentLength;
        const contentEnd = Number.isSafeInteger(metadata.contentLength) && metadata.contentLength >= 0 && source.startsWith(endMarker, expectedEnd)
            ? expectedEnd : source.indexOf(endMarker, contentStart);
        if (contentEnd < 0) throw new Error("Incomplete document block. Its content was preserved.");
        const end = contentEnd + endMarker.length;
        const { contentLength: _contentLength, ...block } = metadata;
        blocks.push({ start: match.index, end, text: source.slice(match.index, end), value: { ...block, content: source.slice(contentStart, contentEnd) } });
        marker.lastIndex = end;
    }
    return blocks;
}

function parseEditableDocumentContent(section, conversation) {
    const markedBlocks = editableDocumentBlocks(section);
    const values = [];
    const ids = new Set(markedBlocks.map((block) => block.value.id));
    const opening = /^<!-- margin-chat-document -->\r?\n(?:\r?\n)?(?:## Document\r?\n(?:\r?\n)?)?/.exec(section);
    let cursor = opening?.[0].length ?? "<!-- margin-chat-document -->".length;
    const appendUnmarked = (until) => {
        const raw = section.slice(cursor, until);
        if (!raw.trim()) return;
        // An external editor may insert ordinary Markdown between identified blocks.
        // Import it as a new block rather than silently dropping authored text.
        const content = raw.replace(/^\n{1,2}/, "").replace(/\n{1,2}$/, "");
        let hash = 2166136261;
        for (let index = 0; index < content.length; index += 1) hash = Math.imul(hash ^ content.charCodeAt(index), 16777619);
        const baseId = `imported:${(hash >>> 0).toString(36)}`;
        let id = baseId;
        for (let ordinal = 2; ids.has(id); ordinal += 1) id = `${baseId}:${ordinal}`;
        ids.add(id);
        values.push({ id, kind: "markdown", content, createdAt: conversation.updatedAt, updatedAt: conversation.updatedAt });
    };
    for (const block of markedBlocks) {
        appendUnmarked(block.start);
        values.push(block.value);
        cursor = block.end;
    }
    appendUnmarked(section.lastIndexOf("<!-- margin-chat-document-end -->"));
    return values;
}

function editableDocumentSection(source) {
    if (parseMetadata(source)?.conversation?.document === undefined) return null;
    const startMatch = /^<!-- margin-chat-document -->\r?$/m.exec(source);
    if (!startMatch) return null;
    // Walk complete blocks first so literal section-end markers inside authored text cannot close it.
    const marker = /^<!-- margin-chat-document-(?:block (.+)|end) -->\r?$/gm;
    marker.lastIndex = startMatch.index + startMatch[0].length;
    let match;
    while ((match = marker.exec(source))) {
        if (!match[1]) {
            const end = match.index + match[0].length;
            return { start: startMatch.index, end, text: source.slice(startMatch.index, end) };
        }
        const metadata = JSON.parse(match[1]);
        const contentStart = marker.lastIndex + (source[marker.lastIndex] === "\r" ? 2 : 1);
        const endMarker = `\n<!-- margin-chat-document-block-end ${JSON.stringify(metadata.id)} -->`;
        const expectedEnd = contentStart + metadata.contentLength;
        const contentEnd = Number.isSafeInteger(metadata.contentLength) && metadata.contentLength >= 0 && source.startsWith(endMarker, expectedEnd)
            ? expectedEnd : source.indexOf(endMarker, contentStart);
        if (contentEnd < 0) throw new Error("Incomplete document block. Its content was preserved.");
        marker.lastIndex = contentEnd + endMarker.length;
    }
    throw new Error("Incomplete editable document. Its content was preserved.");
}
