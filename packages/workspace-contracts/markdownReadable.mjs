import { getDocumentBlockAuthorship } from "./editableDocument.mjs";

const GUARD = "# <!-- margin-chat-metadata: frontmatter format 4 -->";
const AUTHOR_GUARD = "# <!-- margin-chat-metadata: frontmatter format 5 -->";
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const safeJson = (value) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
const fail = () => { throw new Error("Invalid readable Markdown metadata or block boundaries. The original file was preserved."); };

function frontmatter(source) {
    const opening = /^---\r?\n/.exec(source);
    if (!opening) return null;
    const closing = /^---[ \t]*\r?$/gm;
    closing.lastIndex = opening[0].length;
    const match = closing.exec(source);
    return match ? { start: opening[0].length, end: match.index, after: match.index + match[0].length - (match[0].endsWith("\r") ? 1 : 0),
        text: source.slice(opening[0].length, match.index), newline: opening[0].endsWith("\r\n") ? "\r\n" : "\n" } : null;
}

/** Only the reserved top-level frontmatter field identifies this format. */
export function isReadableMarkdown(source) {
    const header = frontmatter(source);
    return Boolean(header && /^margin-chat:(?:[ \t]|\r?$)/m.test(header.text));
}

function headerLines(header) {
    return [...header.text.matchAll(/([^\r\n]*)(\r\n|\n|$)/g)]
        .filter((match) => match[0].length)
        .map((match) => ({ value: match[1], start: header.start + match.index, end: header.start + match.index + match[0].length }));
}

function readRegistry(source, header) {
    const lines = headerLines(header);
    const fields = lines.flatMap((line, index) => /^margin-chat:(?:[ \t]|$)/.test(line.value) ? [index] : []);
    if (fields.length !== 1 || lines[fields[0]].value !== "margin-chat: |-") fail();
    const start = fields[0];
    let end = start + 1;
    const json = [];
    while (end < lines.length && /^(?: {2}|$)/.test(lines[end].value)) {
        json.push(lines[end].value.slice(2));
        end += 1;
    }
    let registry;
    try { registry = JSON.parse(json.join("\n")); } catch { fail(); }
    if (!record(registry) || ![2, 3].includes(registry.schemaVersion) || !record(registry.metadata)
        || !record(registry.blocks) || !record(registry.messages)) fail();
    const guards = lines.filter((line) => line.value === (registry.schemaVersion === 3 ? AUTHOR_GUARD : GUARD));
    if (guards.length !== 1) fail();
    return { registry, removals: [{ start: lines[start].start, end: lines[end - 1].end }, ...guards] };
}

function lineEnd(source, start, text) {
    if (!source.startsWith(text, start)) return null;
    let end = start + text.length;
    if (source[end] === "\r") end += 1;
    return source[end] === "\n" || end === source.length ? end : null;
}

/** Length is a hint, never permission to slice through a closing delimiter.
 * Windows line endings may have been introduced by an external editor. */
function blockEnd(source, contentStart, ending, length, unique = true, hintOnly = false) {
    const at = (position) => {
        const newline = source.startsWith("\r\n", position) ? "\r\n" : source[position] === "\n" ? "\n" : null;
        if (!newline) return null;
        const start = position + newline.length;
        const end = lineEnd(source, start, ending);
        return end === null ? null : { contentEnd: position, end, newline };
    };
    if (Number.isSafeInteger(length) && length >= 0) {
        const direct = at(contentStart + length);
        if (direct) return direct;
        let offset = contentStart;
        let consumed = 0;
        while (offset < source.length && consumed < length) {
            offset += source.startsWith("\r\n", offset) ? 2 : 1;
            consumed += 1;
        }
        const normalized = consumed === length ? at(offset) : null;
        if (normalized) return normalized;
    }
    if (hintOnly) fail();
    const candidates = [];
    let cursor = contentStart;
    while ((cursor = source.indexOf(ending, cursor)) !== -1) {
        const newlineStart = source[cursor - 1] === "\n" ? cursor - (source[cursor - 2] === "\r" ? 2 : 1) : -1;
        const candidate = newlineStart >= contentStart ? at(newlineStart) : null;
        if (candidate) {
            // Legacy messages share one closing marker. Match their existing
            // codec's first-delimiter fallback after an external content edit.
            if (!unique) return candidate;
            candidates.push(candidate);
        }
        cursor += ending.length;
    }
    // Repeated literal closing markers with a stale hint are ambiguous. Refuse
    // to reassign their text to another block merely to produce valid Markdown.
    if (candidates.length !== 1) fail();
    return candidates[0];
}

function replaceRanges(source, replacements) {
    let result = source;
    for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
        result = result.slice(0, replacement.start) + (replacement.text ?? "") + result.slice(replacement.end);
    }
    return result;
}

function metadataRemoval(source, header, start, end) {
    // The legacy codec places the owned metadata directly after the header.
    // Remove its preceding separator; decoding restores it in that location.
    const preceding = source.slice(header?.after ?? 0, start);
    return { start: /^\s*$/.test(preceding) ? header?.after ?? 0 : start, end };
}

/** Move structural data to one YAML block scalar; authored body bytes remain
 * authoritative and are never copied into the registry. */
function encodeCompactMarkdown(source) {
    if (isReadableMarkdown(source)) return source;
    const header = frontmatter(source);
    if (header?.text.includes(GUARD)) fail();
    const registry = { schemaVersion: 2, metadata: null, blocks: Object.create(null), messages: Object.create(null) };
    const replacements = [];
    const marker = /^<!-- margin-chat-(metadata|document-block|message) (.+) -->\r?$/gm;
    marker.lastIndex = header?.after ?? 0;
    let match;
    while ((match = marker.exec(source))) {
        let metadata;
        try { metadata = JSON.parse(match[2]); } catch { fail(); }
        if (!record(metadata)) fail();
        if (match[1] === "metadata") {
            if (registry.metadata) fail();
            registry.metadata = metadata;
            replacements.push(metadataRemoval(source, header, match.index, marker.lastIndex - (source[marker.lastIndex - 1] === "\r" ? 1 : 0)));
            continue;
        }
        if (typeof metadata.id !== "string" || !metadata.id || source[marker.lastIndex] !== "\n") fail();
        const group = match[1] === "document-block" ? "blocks" : "messages";
        const compact = group === "blocks" ? "block" : "msg";
        if (Object.hasOwn(registry[group], metadata.id)) fail();
        const newline = source[marker.lastIndex - 1] === "\r" ? "\r\n" : "\n";
        const contentStart = marker.lastIndex + 1;
        const ending = group === "blocks" ? `<!-- margin-chat-document-block-end ${JSON.stringify(metadata.id)} -->` : "<!-- margin-chat-message-end -->";
        const end = blockEnd(source, contentStart, ending, metadata.contentLength, group !== "messages");
        const content = source.slice(contentStart, end.contentEnd);
        registry[group][metadata.id] = { ...metadata, contentLength: content.length };
        replacements.push({ start: match.index, end: end.end,
            text: `<!-- margin-chat-${compact} ${safeJson(metadata.id)} -->${newline}${content}${end.newline}<!-- margin-chat-${compact}-end ${safeJson(metadata.id)} -->${source[end.end - 1] === "\r" ? "\r" : ""}` });
        marker.lastIndex = end.end;
    }
    // Plain imported notes have no structured payload and retain their exact
    // bytes until the shared codec assigns one through an authored app edit.
    if (!registry.metadata) {
        if (Object.keys(registry.blocks).length || Object.keys(registry.messages).length) fail();
        return source;
    }
    const newline = header?.newline ?? "\n";
    const owned = `${GUARD}${newline}margin-chat: |-${newline}${JSON.stringify(registry, null, 2).split("\n").map((line) => `  ${line}`).join(newline)}${newline}`;
    if (header) replacements.push({ start: header.end, end: header.end, text: owned });
    const result = replaceRanges(source, replacements);
    return header ? result : `---${newline}${owned}---${newline}${newline}${result}`;
}

/** Restore the legacy internal representation for the shared parser and merge
 * engine. Refresh lengths from visible content after external edits. */
function decodeCompactMarkdown(source) {
    const header = frontmatter(source);
    if (!isReadableMarkdown(source)) {
        if (header?.text.includes(GUARD)) fail();
        return source;
    }
    const { registry, removals } = readRegistry(source, header);
    const replacements = [...removals];
    const seen = { blocks: new Set(), messages: new Set() };
    const marker = /^<!-- margin-chat-(block|msg) (.+) -->\r?$/gm;
    marker.lastIndex = header.after;
    let match;
    while ((match = marker.exec(source))) {
        let id;
        try { id = JSON.parse(match[2]); } catch { fail(); }
        const group = match[1] === "block" ? "blocks" : "messages";
        if (typeof id !== "string" || !id || !Object.hasOwn(registry[group], id) || seen[group].has(id)
            || source[marker.lastIndex] !== "\n") fail();
        const metadata = registry[group][id];
        if (!record(metadata) || metadata.id !== id) fail();
        seen[group].add(id);
        const newline = source[marker.lastIndex - 1] === "\r" ? "\r\n" : "\n";
        const contentStart = marker.lastIndex + 1;
        const ending = `<!-- margin-chat-${match[1]}-end ${safeJson(id)} -->`;
        const end = blockEnd(source, contentStart, ending, metadata.contentLength);
        const content = source.slice(contentStart, end.contentEnd);
        const kind = group === "blocks" ? "document-block" : "message";
        // The legacy workspace reader normalizes Windows newlines before
        // consulting marker lengths. Its hints therefore count normalized text.
        const updated = { ...metadata, contentLength: content.replace(/\r\n/g, "\n").length };
        replacements.push({ start: match.index, end: end.end,
            text: `<!-- margin-chat-${kind} ${safeJson(updated)} -->${newline}${content}${end.newline}<!-- margin-chat-${kind}-end${group === "blocks" ? ` ${JSON.stringify(id)}` : ""} -->${source[end.end - 1] === "\r" ? "\r" : ""}` });
        marker.lastIndex = end.end;
    }
    // Check the source outside complete bodies, so literal marker examples
    // within authored blocks/messages stay ordinary text.
    const remaining = replaceRanges(source, replacements.filter((item) => item.start >= header.after).map((item) => ({ ...item, text: "" })));
    if (/^<!-- margin-chat-(?:block|msg)(?:\s|-end\b)/m.test(remaining.slice(header.after))) fail();
    let result = replaceRanges(source, replacements);
    const restored = frontmatter(result);
    const legacyMetadata = `<!-- margin-chat-metadata ${safeJson(registry.metadata)} -->`;
    if (restored && !restored.text.trim()) {
        result = result.slice(restored.after).replace(/^(?:\r?\n){1,2}/, "");
        return legacyMetadata + result;
    }
    if (!restored) fail();
    return result.slice(0, restored.after) + header.newline + header.newline + legacyMetadata + result.slice(restored.after);
}

function fingerprint(content) {
    const value = content.replace(/\r\n/g, "\n");
    let first = 2166136261;
    let second = 5381;
    for (let i = 0; i < value.length; i += 1) {
        first = Math.imul(first ^ value.charCodeAt(i), 16777619);
        second = Math.imul(second, 33) ^ value.charCodeAt(i);
    }
    return `${value.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

function escapeAttribute(value) {
    return value.replace(/[&"<>]|[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/gu, (character) =>
        ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[character] ?? `&#x${character.codePointAt(0).toString(16)};`);
}

function unescapeAttribute(value) {
    if (/&(?!amp;|quot;|lt;|gt;|#\d+;|#x[\da-f]+;)/iu.test(value)) fail();
    return value.replace(/&(amp|quot|lt|gt|#\d+|#x[\da-f]+);/giu, (_match, entity) => {
        if (entity[0] !== "#") return ({ amp: "&", quot: '"', lt: "<", gt: ">" })[entity.toLowerCase()];
        const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) fail();
        return String.fromCodePoint(code);
    });
}

function writeRegistry(source, registry, header, parsed) {
    const field = parsed.removals[0];
    const guard = parsed.removals[1];
    const json = JSON.stringify(registry, null, 2).split("\n").map((line) => `  ${line}`).join(header.newline);
    return replaceRanges(source, [{ ...field, text: `margin-chat: |-${header.newline}${json}${header.newline}` },
        { ...guard, text: `${registry.schemaVersion === 3 ? AUTHOR_GUARD : GUARD}${header.newline}` }]);
}

function compactNodes(source, header, registry) {
    const nodes = [];
    const marker = /^<!-- margin-chat-(block|msg) (.+) -->\r?$/gm;
    marker.lastIndex = header.after;
    let match;
    while ((match = marker.exec(source))) {
        let id;
        try { id = JSON.parse(match[2]); } catch { fail(); }
        const group = match[1] === "block" ? "blocks" : "messages";
        if (typeof id !== "string" || !id || !Object.hasOwn(registry[group], id)) fail();
        const metadata = registry[group][id];
        const contentStart = marker.lastIndex + 1;
        const newline = source[marker.lastIndex - 1] === "\r" ? "\r\n" : "\n";
        const end = blockEnd(source, contentStart, `<!-- margin-chat-${match[1]}-end ${safeJson(id)} -->`, metadata.contentLength);
        nodes.push({ id, group, metadata, start: match.index, end: end.end, content: source.slice(contentStart, end.contentEnd), newline,
            closingNewline: end.newline, trailingCR: source[end.end - 1] === "\r" ? "\r" : "" });
        marker.lastIndex = end.end;
    }
    return nodes;
}

function documentClosing(source, nodes) {
    const matches = [...source.matchAll(/^<!-- margin-chat-document-end -->\r?$/gm)]
        .filter((match) => !nodes.some((node) => match.index >= node.start && match.index < node.end));
    return matches.length === 1 ? matches[0].index + matches[0][0].length - (matches[0][0].endsWith("\r") ? 1 : 0) : null;
}

function noteBody(source, nodes, metadata, documentEnd) {
    const note = metadata.entityType === "note" ? metadata.note : metadata.primaryNote?.note;
    if (!record(note) || typeof note.id !== "string") return null;
    for (const match of source.matchAll(/^## Note(?:\r?\n\r?\n|$)/gm)) {
        if (documentEnd !== null && match.index < documentEnd || nodes.some((node) => match.index >= node.start && match.index < node.end)) continue;
        return { id: note.id, start: match.index + match[0].length, headingStart: match.index, end: source.length,
            content: source.slice(match.index + match[0].length), needsSeparator: !match[0].endsWith("\n") };
    }
    return null;
}

/** Version 5 gives current document content one visible body, with provenance
 * wrappers. Original messages remain recoverable history in the same header. */
export function encodeReadableMarkdown(source) {
    if (isReadableMarkdown(source)) {
        const header = frontmatter(source);
        const parsed = readRegistry(source, header);
        if (parsed.registry.schemaVersion === 3) return source;
        source = decodeCompactMarkdown(source);
    }
    const compact = encodeCompactMarkdown(source);
    if (!isReadableMarkdown(compact)) return compact;
    const header = frontmatter(compact);
    const parsed = readRegistry(compact, header);
    const registry = parsed.registry;
    const nodes = compactNodes(compact, header, registry);
    const messages = Object.values(registry.messages);
    const documentEnd = record(registry.metadata.conversation?.document) ? documentClosing(compact, nodes) : null;
    const note = noteBody(compact, nodes, registry.metadata, documentEnd);
    let historyEnd = null;
    if (documentEnd !== null) {
        const tailNodes = nodes.filter((node) => node.group === "messages" && node.start >= documentEnd);
        const end = note?.end ?? tailNodes.at(-1)?.end;
        if (end !== undefined) {
            let skeleton = compact.slice(documentEnd, end);
            const ranges = tailNodes.map((node) => ({ start: node.start - documentEnd, end: node.end - documentEnd, text: "" }));
            if (note) ranges.push({ start: note.start - documentEnd, end: note.end - documentEnd, text: "" });
            skeleton = replaceRanges(skeleton, ranges);
            // Unknown authored interstitial text stays visible. Only the known
            // context headings and original note body become historical data.
            if (skeleton.split(/\r?\n/).every((line) => !line.trim() || /^## (?:Messages|Context messages|Note)$/.test(line) || /^### (?:User|Assistant|System) · /.test(line))) historyEnd = end;
        } else if (/^\s*## Messages\s*$/.test(compact.slice(documentEnd))) historyEnd = compact.length;
    }
    const replacements = [];
    if (historyEnd !== null) {
        registry.history = { afterDocument: compact.slice(documentEnd, historyEnd) };
        replacements.push({ start: documentEnd, end: historyEnd, text: "" });
    }
    for (const node of nodes) {
        if (historyEnd !== null && node.start >= documentEnd && node.end <= historyEnd) continue;
        const author = node.group === "blocks" ? getDocumentBlockAuthorship(node.metadata, messages)
            : node.metadata.role === "assistant" ? "ai" : node.metadata.role === "system" ? "system" : "user";
        const tag = author === "mixed" ? "ai" : author;
        const attribute = node.group === "blocks" ? "id" : "message-id";
        if (node.group === "blocks") {
            registry.blocks[node.id] = { ...node.metadata, contentFingerprint: fingerprint(node.content) };
        }
        replacements.push({ start: node.start, end: node.end,
            text: `<${tag} ${attribute}="${escapeAttribute(node.id)}"${author === "mixed" ? ' edited-by="user"' : ""}>${node.newline}${node.newline}${node.content}${node.closingNewline}${node.closingNewline}</${tag}>${node.trailingCR}` });
    }
    if (note && historyEnd === null) {
        registry.notes = { [note.id]: { contentLength: note.content.length, ...(note.needsSeparator ? { addedSeparator: true } : {}) } };
        replacements.push({ start: note.start, end: note.end,
            text: `${note.needsSeparator ? header.newline + header.newline : ""}<user note-id="${escapeAttribute(note.id)}">${header.newline}${header.newline}${note.content}${header.newline}${header.newline}</user>` });
    }
    registry.schemaVersion = 3;
    const result = replaceRanges(compact, replacements);
    return writeRegistry(result, registry, header, parsed);
}

function taggedEnd(source, start, tag, lengths, registry) {
    const ending = `</${tag}>`;
    // Trust a saved length only when it lands on the matching line delimiter.
    for (const length of new Set(lengths)) {
        try { return blockEnd(source, start, ending, length, true, true); } catch { /* External edits need structural scanning. */ }
    }
    let fence = null;
    const candidates = [];
    const lines = /([^\r\n]*)(\r\n|\n|$)/g;
    lines.lastIndex = start;
    let match;
    while ((match = lines.exec(source)) && match[0]) {
        const line = match[1];
        const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fenceMatch) {
            if (!fence) fence = fenceMatch[1];
            else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = null;
            continue;
        }
        if (fence) continue;
        const next = /^<(ai|user|system) (id|message-id|note-id)="([^"]*)"(?: edited-by="user")?>$/.exec(line);
        if (next) {
            const group = next[2] === "id" ? "blocks" : next[2] === "message-id" ? "messages" : "notes";
            if (Object.hasOwn(registry[group] ?? {}, unescapeAttribute(next[3]))) {
                if (!candidates.length) fail();
                break;
            }
        }
        if (line === ending && match.index > start) {
            const newline = source[match.index - 2] === "\r" ? "\r\n" : "\n";
            candidates.push({ contentEnd: match.index - newline.length, end: match.index + line.length + (match[2] === "\r\n" ? 1 : 0), newline });
        }
    }
    if (candidates.length !== 1) fail();
    return candidates[0];
}

function fencedRanges(source, start, end = source.length) {
    const ranges = [];
    let fence = null;
    let opening = 0;
    for (const match of source.slice(start, end).matchAll(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/gm)) {
        if (!fence) { fence = match[1]; opening = start + match.index; }
        else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) {
            ranges.push({ start: opening, end: start + match.index + match[0].length });
            fence = null;
        }
    }
    if (fence) ranges.push({ start: opening, end });
    return ranges;
}

function decodeAuthoredMarkdown(source, header, parsed) {
    const registry = parsed.registry;
    if (registry.notes !== undefined && !record(registry.notes) || registry.history !== undefined
        && (!record(registry.history) || typeof registry.history.afterDocument !== "string")) fail();
    const replacements = [];
    const ranges = [];
    const seen = { blocks: new Set(), messages: new Set(), notes: new Set() };
    const fences = [];
    let outsideCursor = header.after;
    const marker = /^<(ai|user|system) (id|message-id|note-id)="([^"]*)"( edited-by="user")?>\r?$/gm;
    marker.lastIndex = header.after;
    let match;
    while ((match = marker.exec(source))) {
        const outsideFences = fencedRanges(source, outsideCursor, marker.lastIndex);
        if (outsideFences.some((range) => match.index >= range.start && match.index < range.end)) continue;
        fences.push(...outsideFences);
        const tag = match[1];
        const group = match[2] === "id" ? "blocks" : match[2] === "message-id" ? "messages" : "notes";
        const id = unescapeAttribute(match[3]);
        const metadata = registry[group]?.[id];
        if (!id || !Object.hasOwn(registry[group] ?? {}, id) || !record(metadata) || seen[group].has(id)
            || group !== "notes" && metadata.id !== id || group !== "messages" && tag === "system" || source[marker.lastIndex] !== "\n") fail();
        seen[group].add(id);
        const newline = source[marker.lastIndex - 1] === "\r" ? "\r\n" : "\n";
        const contentStart = marker.lastIndex + 1 + newline.length;
        if (source.slice(marker.lastIndex + 1, contentStart) !== newline) fail();
        // The owned blank line has a raw width and a normalized width. Editors
        // may change LF to CRLF without changing the saved content length.
        const lengths = [metadata.contentLength + newline.length, metadata.contentLength + 1];
        const normalizedLength = typeof metadata.contentFingerprint === "string" ? Number(metadata.contentFingerprint.split(":", 1)[0]) : NaN;
        if (Number.isSafeInteger(normalizedLength) && normalizedLength >= 0) lengths.push(normalizedLength + 1);
        const end = taggedEnd(source, contentStart, tag, lengths, registry);
        if (source.slice(end.contentEnd - end.newline.length, end.contentEnd) !== end.newline) fail();
        const content = source.slice(contentStart, end.contentEnd - end.newline.length);
        let text;
        if (group === "notes") text = content;
        else {
            const { contentFingerprint, ...original } = metadata;
            const authorship = tag === "user" ? "user" : match[4] || contentFingerprint && contentFingerprint !== fingerprint(content) ? "mixed" : "ai";
            const inferred = getDocumentBlockAuthorship(original, Object.values(registry.messages));
            registry[group][id] = { ...original, ...(group === "blocks" && authorship !== inferred ? { authorship } : {}), contentLength: content.length };
            const compact = group === "blocks" ? "block" : "msg";
            text = `<!-- margin-chat-${compact} ${safeJson(id)} -->${newline}${content}${end.newline}<!-- margin-chat-${compact}-end ${safeJson(id)} -->${source[end.end - 1] === "\r" ? "\r" : ""}`;
        }
        let start = match.index;
        if (group === "notes" && metadata.addedSeparator && !content && source.slice(start - newline.length * 2, start) === newline + newline) start -= newline.length * 2;
        replacements.push({ start, end: end.end, text });
        ranges.push({ start: match.index, end: end.end });
        marker.lastIndex = end.end;
        outsideCursor = end.end;
    }
    fences.push(...fencedRanges(source, outsideCursor));
    for (const tag of source.matchAll(/^<(?:ai|user|system)(?:\s|>)|^<\/(?:ai|user|system)>/gm)) {
        if (tag.index >= header.after && ![...ranges, ...fences].some((range) => tag.index >= range.start && tag.index < range.end)) fail();
    }
    let result = replaceRanges(source, replacements);
    if (registry.history) {
        const compact = compactNodes(result, header, registry);
        const closing = documentClosing(result, compact);
        if (closing === null) fail();
        result = result.slice(0, closing) + registry.history.afterDocument + result.slice(closing);
    }
    registry.schemaVersion = 2;
    delete registry.history;
    delete registry.notes;
    result = writeRegistry(result, registry, header, parsed);
    return decodeCompactMarkdown(result);
}

/** Both earlier portable formats remain readable. Literal Markdown tags inside
 * complete blocks are never interpreted as another document's provenance. */
export function decodeReadableMarkdown(source) {
    if (!isReadableMarkdown(source)) {
        const header = frontmatter(source);
        if (header?.text.includes(AUTHOR_GUARD)) fail();
        return decodeCompactMarkdown(source);
    }
    const header = frontmatter(source);
    const parsed = readRegistry(source, header);
    return parsed.registry.schemaVersion === 3 ? decodeAuthoredMarkdown(source, header, parsed) : decodeCompactMarkdown(source);
}
