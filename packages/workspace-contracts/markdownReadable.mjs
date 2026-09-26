const GUARD = "# <!-- margin-chat-metadata: frontmatter format 4 -->";
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
    if (!record(registry) || registry.schemaVersion !== 2 || !record(registry.metadata)
        || !record(registry.blocks) || !record(registry.messages)) fail();
    const guards = lines.filter((line) => line.value === GUARD);
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
function blockEnd(source, contentStart, ending, length, unique = true) {
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
export function encodeReadableMarkdown(source) {
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
export function decodeReadableMarkdown(source) {
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
