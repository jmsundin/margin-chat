const MAX_FILENAME_BYTES = 200;
const encoder = new TextEncoder();

function legacyHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

/** Retained exactly for recognizing files produced by the original codec. */
export function legacyMarkdownPath(folder, id) {
    const slug = id.normalize("NFKD")
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 96) || "item";
    return `${folder}/${folder === "Notes" ? "note" : "chat"}-${slug}-${legacyHash(id)}.md`;
}

/** Two independently seeded, mixed 32-bit words provide a compact deterministic
 * identity suffix. This identifies names; it is not a cryptographic checksum. */
function identitySuffix(id) {
    let first = 0xdeadbeef;
    let second = 0x41c6ce57;
    for (let index = 0; index < id.length; index += 1) {
        const code = id.charCodeAt(index);
        first = Math.imul(first ^ code, 2654435761);
        second = Math.imul(second ^ code, 1597334677);
    }
    first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
    second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
    return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

function titleStem(title) {
    let stem = title.normalize("NFC")
        // These characters are unsafe on common filesystems or change wiki-link targets.
        .replace(/[\\/:*?"<>|\[\]#^\u0000-\u001f\u007f-\u009f\ud800-\udfff]/gu, " ")
        .replace(/\s+/gu, " ")
        .replace(/^[. ]+|[. ]+$/gu, "");
    if (!stem) stem = "Untitled";
    // Windows also reserves these names when followed by another extension.
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(stem)) stem = `_${stem}`;
    return stem;
}

/** Human-readable names retain identity across offline devices, including when
 * separate documents independently receive the same title. */
export function titleMarkdownPath(folder, title, id) {
    const suffix = ` — ${identitySuffix(id)}.md`;
    const available = MAX_FILENAME_BYTES - encoder.encode(suffix).length;
    let stem = "";
    let used = 0;
    // Code-point iteration never cuts an emoji's UTF-16 surrogate pair in half.
    for (const character of titleStem(title)) {
        const bytes = encoder.encode(character).length;
        if (used + bytes > available) break;
        stem += character;
        used += bytes;
    }
    stem = stem.replace(/[. ]+$/u, "") || "Untitled";
    return `${folder}/${stem}${suffix}`;
}
