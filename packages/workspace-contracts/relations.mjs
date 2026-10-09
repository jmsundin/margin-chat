/**
 * Typed relations between documents.
 *
 * A relation is stored in the source document's frontmatter as a property named
 * after its type, holding Obsidian wiki links (`supports: ["[[Bell test]]"]`), so
 * Obsidian's graph sees every edge. Optional attributes live in one
 * `edge-meta` map keyed by `<type>/<target id>`. Inverses are never written:
 * the target's file is untouched and readers derive the inverse.
 */

/** The curated vocabulary. Only these property names are read as relations, so
 * an ordinary property that happens to hold a link (`author: "[[Ada]]"`) is not. */
export const DOCUMENT_RELATION_TYPES = Object.freeze([
    Object.freeze({ id: "supports", label: "Supports", inverseLabel: "Supported by", directed: true }),
    Object.freeze({ id: "contradicts", label: "Contradicts", inverseLabel: "Contradicts", directed: false }),
    Object.freeze({ id: "cites", label: "Cites", inverseLabel: "Cited by", directed: true }),
    Object.freeze({ id: "elaborates", label: "Elaborates", inverseLabel: "Elaborated by", directed: true }),
    Object.freeze({ id: "example-of", label: "Example of", inverseLabel: "Has example", directed: true }),
    Object.freeze({ id: "part-of", label: "Part of", inverseLabel: "Has part", directed: true }),
    Object.freeze({ id: "depends-on", label: "Depends on", inverseLabel: "Needed by", directed: true }),
    Object.freeze({ id: "same-as", label: "Same as", inverseLabel: "Same as", directed: false }),
]);

const RELATION_BY_ID = new Map(DOCUMENT_RELATION_TYPES.map((type) => [type.id, type]));
export const DOCUMENT_RELATION_ORIGINS = Object.freeze(["user", "ai", "import"]);
/** Frontmatter key holding per-edge attributes. */
export const EDGE_META_KEY = "edge-meta";
/** Tags every Margin Chat document carries; they are not the user's own tags. */
export const RESERVED_DOCUMENT_TAGS = Object.freeze(["margin-chat", "document"]);

export function isDocumentRelationType(value) {
    return typeof value === "string" && RELATION_BY_ID.has(value);
}

export function getDocumentRelationType(id) {
    return RELATION_BY_ID.get(id) ?? null;
}

/** One stable key per edge: a type and its target. */
export function documentRelationKey(type, target) {
    return `${type}/${target}`;
}

const BLOCK_ID = /^[A-Za-z0-9_:.-]{1,200}$/;

/**
 * Parse an Obsidian wiki link: `[[target]]`, `[[target|label]]`,
 * `[[target#^block|label]]` or `[[target#Heading]]`. Returns null for anything else.
 */
export function parseWikiLink(value) {
    if (typeof value !== "string") return null;
    const match = /^\s*!?\[\[([^\]|#]*)(?:#(\^)?([^\]|]*))?(?:\|([^\]]*))?\]\]\s*$/.exec(value);
    if (!match) return null;
    const target = match[1].trim();
    if (!target) return null;
    const blockId = match[2] && BLOCK_ID.test(match[3]?.trim() ?? "") ? match[3].trim() : undefined;
    const heading = !match[2] && match[3]?.trim() ? match[3].trim() : undefined;
    return { target, ...(blockId ? { blockId } : {}), ...(heading ? { heading } : {}), ...(match[4]?.trim() ? { label: match[4].trim() } : {}) };
}

/** Lowercase tag names without `#`, as Obsidian treats them. Reserved tags are removed. */
export function normalizeDocumentTags(input) {
    const values = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[,\s]+/) : [];
    const tags = [];
    for (const value of values) {
        if (typeof value !== "string") continue;
        const tag = value.trim().replace(/^#/, "");
        if (!tag || tag.length > 120 || /[\s,#\[\]{}]/.test(tag) || RESERVED_DOCUMENT_TAGS.includes(tag.toLowerCase())) continue;
        if (!tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    }
    return tags.slice(0, 200);
}

/** A short node type such as `question` or `claim`. */
export function normalizeDocumentNodeType(input) {
    if (typeof input !== "string") return undefined;
    const value = input.trim().toLowerCase();
    return /^[\p{L}\p{N}][\p{L}\p{N} _/-]{0,39}$/u.test(value) ? value : undefined;
}

/**
 * Keep valid relations, one per type and target. A relation names its target by
 * document id, or keeps the original link text (`target`) when the document is
 * not in this vault yet, so a dangling link survives the next save.
 */
export function normalizeDocumentRelations(input, conversationId, conversations) {
    if (!Array.isArray(input)) return undefined;
    const relations = [];
    const seen = new Set();
    for (const item of input) {
        if (!item || typeof item !== "object" || Array.isArray(item) || !isDocumentRelationType(item.type)) continue;
        const targetConversationId = typeof item.targetConversationId === "string" && item.targetConversationId ? item.targetConversationId : undefined;
        const target = !targetConversationId && typeof item.target === "string" && item.target.trim() && !/[\[\]|\r\n]/.test(item.target) ? item.target.trim() : undefined;
        if (!targetConversationId && !target) continue;
        if (targetConversationId === conversationId) continue;
        if (targetConversationId && conversations && !Object.hasOwn(conversations, targetConversationId)) continue;
        const key = documentRelationKey(item.type, targetConversationId ?? target);
        if (seen.has(key)) continue;
        seen.add(key);
        const weight = typeof item.weight === "number" && Number.isFinite(item.weight) ? Math.min(1, Math.max(0, item.weight)) : undefined;
        relations.push({
            type: item.type,
            ...(targetConversationId ? { targetConversationId } : { target }),
            ...(typeof item.targetBlockId === "string" && BLOCK_ID.test(item.targetBlockId) ? { targetBlockId: item.targetBlockId } : {}),
            ...(typeof item.sourceBlockId === "string" && BLOCK_ID.test(item.sourceBlockId) ? { sourceBlockId: item.sourceBlockId } : {}),
            ...(weight !== undefined ? { weight } : {}),
            ...(DOCUMENT_RELATION_ORIGINS.includes(item.origin) ? { origin: item.origin } : {}),
            ...(typeof item.note === "string" && item.note.trim() ? { note: item.note.trim().slice(0, 2000) } : {}),
            ...(typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt)) ? { createdAt: item.createdAt } : {}),
        });
        if (relations.length >= 2000) break;
    }
    // Files group links by property, so the model keeps the same order.
    const order = (relation) => DOCUMENT_RELATION_TYPES.findIndex((type) => type.id === relation.type);
    return relations.map((relation, index) => ({ relation, index }))
        .sort((a, b) => order(a.relation) - order(b.relation) || a.index - b.index).map(({ relation }) => relation);
}

/** The attributes written to `edge-meta` for one relation; empty when it has none. */
export function documentRelationMetadata(relation) {
    return {
        ...(relation.weight !== undefined ? { weight: relation.weight } : {}),
        ...(relation.origin ? { origin: relation.origin } : {}),
        ...(relation.sourceBlockId ? { from: relation.sourceBlockId } : {}),
        ...(relation.note ? { note: relation.note } : {}),
        ...(relation.createdAt ? { created: relation.createdAt } : {}),
    };
}

/** Read relation attributes back from an `edge-meta` value. */
export function readDocumentRelationMetadata(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return {
        ...(typeof value.weight === "number" ? { weight: value.weight } : {}),
        ...(typeof value.origin === "string" ? { origin: value.origin } : {}),
        ...(typeof value.from === "string" ? { sourceBlockId: value.from.replace(/^\^/, "") } : {}),
        ...(typeof value.note === "string" ? { note: value.note } : {}),
        ...(typeof value.created === "string" ? { createdAt: value.created } : {}),
    };
}

/**
 * The graph properties of one file's frontmatter values: node type, tags,
 * relation targets (unresolved link text), and edge attributes.
 */
export function readDocumentGraphProperties(values) {
    const relationTargets = [];
    for (const type of DOCUMENT_RELATION_TYPES) {
        const raw = values[type.id];
        for (const item of Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]) {
            const link = parseWikiLink(item);
            if (link) relationTargets.push({ type: type.id, target: link.target, ...(link.blockId ? { targetBlockId: link.blockId } : {}) });
        }
    }
    const edgeMeta = values[EDGE_META_KEY] && typeof values[EDGE_META_KEY] === "object" && !Array.isArray(values[EDGE_META_KEY]) ? values[EDGE_META_KEY] : {};
    const nodeType = normalizeDocumentNodeType(values.type);
    const tags = normalizeDocumentTags(values.tags);
    return { relationTargets, edgeMeta, ...(nodeType ? { nodeType } : {}), tags };
}

/**
 * Wiki links in authored Markdown, outside code. An Obsidian/Dataview inline
 * field (`[supports:: [[Target]]]` or `supports:: [[Target]]`) gives the link a type.
 */
export function extractMarkdownWikiLinks(markdown) {
    if (typeof markdown !== "string" || !markdown.includes("[[")) return [];
    const text = markdown
        .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[^\n]*(?=\n|$)|$)/gm, (block) => " ".repeat(block.length))
        .replace(/(`+)[^`\n]*?\1/g, (span) => " ".repeat(span.length))
        .replace(/%%[\s\S]*?%%/g, (comment) => " ".repeat(comment.length));
    const links = [];
    const pattern = /(?:\[?([\p{L}][\p{L}\p{N}_-]*)::[ \t]*)?(!?\[\[[^\]\n]+\]\])/gu;
    for (const match of text.matchAll(pattern)) {
        const link = parseWikiLink(match[2]);
        if (!link) continue;
        const field = match[1]?.toLowerCase();
        links.push({ ...link, ...(field && isDocumentRelationType(field) ? { type: field } : {}), embed: match[2].startsWith("!"), index: match.index });
    }
    return links;
}

/** The optional graph fields of a conversation, normalized, ready to spread. */
export function normalizeConversationGraphFields(input, conversationId, conversations) {
    const relations = normalizeDocumentRelations(input?.relations, conversationId, conversations);
    const nodeType = normalizeDocumentNodeType(input?.nodeType);
    const tags = normalizeDocumentTags(input?.tags);
    return { ...(relations?.length ? { relations } : {}), ...(nodeType ? { nodeType } : {}), ...(tags.length ? { tags } : {}) };
}
