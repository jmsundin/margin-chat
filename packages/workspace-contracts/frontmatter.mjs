/**
 * Frontmatter helpers that understand whole YAML entries, not single lines.
 *
 * Obsidian rewrites properties in block style (`tags:` followed by `  - a`), so
 * a key's value can span several lines. Every reader and writer here treats a
 * key line plus its continuation lines as one entry, and parses only the YAML
 * subset properties use: scalars, flow and block sequences, flow and block
 * mappings, and literal or folded block scalars. Anything else reads as
 * `undefined` and is left exactly as written.
 */

const OPENING = /^---\r?\n/;
const KEY_LINE = /^([^\s#\-"'][^:\r\n]*?)[ \t]*:(?:[ \t]|$)/;

/** The frontmatter block of a Markdown source, with each top-level entry located. */
export function readFrontmatter(source) {
    const opening = OPENING.exec(source);
    if (!opening) return null;
    const closing = /\r?\n---[ \t]*(?:\r?\n|$)/g;
    closing.lastIndex = opening[0].length - 1;
    const match = closing.exec(source);
    if (!match) return null;
    const start = opening[0].length;
    // An empty block (`---` directly after the opening line) has no text.
    const end = Math.max(start, match.index);
    const text = source.slice(start, end);
    return { start, end, text, newline: opening[0].endsWith("\r\n") ? "\r\n" : "\n",
        after: match.index + match[0].length, entries: frontmatterEntries(text, start) };
}

/** Top-level entries of frontmatter text. Positions are offset by `base`. */
export function frontmatterEntries(text, base = 0) {
    const lines = [...text.matchAll(/[^\r\n]*(?:\r?\n|$)/g)].filter((line) => line[0].length || line.index < text.length);
    const entries = [];
    let current = null;
    const close = (index) => {
        if (!current) return;
        let end = index;
        // Trailing blank lines separate entries; they are not part of a value.
        while (end > current.firstLine + 1 && !lines[end - 1][0].trim()) end -= 1;
        const startOffset = lines[current.firstLine].index;
        const last = lines[end - 1];
        const endOffset = last.index + last[0].replace(/\r?\n$/, "").length;
        entries.push({ key: current.key, start: base + startOffset, end: base + endOffset, raw: text.slice(startOffset, endOffset) });
        current = null;
    };
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index][0].replace(/\r?\n$/, "");
        const key = KEY_LINE.exec(line)?.[1];
        if (key !== undefined) {
            close(index);
            current = { key: key.trim(), firstLine: index };
        } else if (current && (/^[ \t]/.test(line) || /^-(?:[ \t]|$)/.test(line) || !line.trim())) {
            continue;
        } else close(index);
    }
    close(lines.length);
    return entries;
}

/** One entry's raw text, or undefined when the key is absent. */
export function frontmatterEntry(source, key) {
    return readFrontmatter(source)?.entries.find((entry) => entry.key === key);
}

/** The parsed value of one key, or undefined when absent or outside the supported subset. */
export function readFrontmatterValue(source, key) {
    const entry = frontmatterEntry(source, key);
    return entry ? parseFrontmatterEntryValue(entry.raw) : undefined;
}

/** Every parsed entry, keyed by name. Unsupported values are omitted. */
export function readFrontmatterValues(source) {
    const values = {};
    for (const entry of readFrontmatter(source)?.entries ?? []) {
        const value = parseFrontmatterEntryValue(entry.raw);
        if (value !== undefined) values[entry.key] = value;
    }
    return values;
}

/** Parse one entry (`key: value` plus continuation lines). */
export function parseFrontmatterEntryValue(raw) {
    const lines = raw.split(/\r?\n/);
    const first = KEY_LINE.exec(lines[0]);
    if (!first) return undefined;
    const inline = lines[0].slice(first[0].length).trim();
    const rest = lines.slice(1);
    try {
        if (/^[|>][+-]?\d*$/.test(inline)) return blockScalar(inline, rest);
        if (inline && !isComment(inline)) {
            if (rest.some((line) => line.trim())) {
                // A flow collection may wrap onto indented lines.
                if (/^[[{]/.test(inline)) return parseFlowText([inline, ...rest.map((line) => line.trim())].join(" "));
                return undefined;
            }
            return parseInline(inline);
        }
        const body = rest.filter((line) => line.trim() && !/^\s*#/.test(line));
        if (!body.length) return null;
        return parseBlock(body, indentOf(body[0]));
    } catch {
        return undefined;
    }
}

/** Serialize a value as one line. JSON is valid YAML, keeps every value on its
 * key's line, and reads back identically in Obsidian. */
export function renderFrontmatterEntry(key, value) {
    return `${key}: ${JSON.stringify(value)}`;
}

/** Replace, insert, or (with `undefined`) remove top-level entries, keeping all other bytes. */
export function setFrontmatterEntries(source, updates) {
    const header = readFrontmatter(source);
    const newline = header?.newline ?? (source.includes("\r\n") ? "\r\n" : "\n");
    const pending = new Map(Object.entries(updates));
    if (!header) {
        const lines = [...pending].filter(([, raw]) => raw !== undefined).map(([, raw]) => raw.replace(/\r?\n/g, newline));
        return lines.length ? `---${newline}${lines.join(newline)}${newline}---${newline}${source}` : source;
    }
    let text = header.text;
    const relative = header.entries.map((entry) => ({ ...entry, start: entry.start - header.start, end: entry.end - header.start }));
    for (const entry of [...relative].reverse()) {
        if (!pending.has(entry.key)) continue;
        const raw = pending.get(entry.key);
        pending.delete(entry.key);
        if (raw === undefined) {
            // Remove the entry together with its line break.
            const end = text.startsWith("\r\n", entry.end) ? entry.end + 2 : text[entry.end] === "\n" ? entry.end + 1 : entry.end;
            const start = end === entry.end && entry.start > 0 ? entry.start - (text[entry.start - 2] === "\r" ? 2 : 1) : entry.start;
            text = text.slice(0, start) + text.slice(end);
        } else {
            text = text.slice(0, entry.start) + raw.replace(/\r?\n/g, newline) + text.slice(entry.end);
        }
    }
    const additions = [...pending].filter(([, raw]) => raw !== undefined).map(([, raw]) => raw.replace(/\r?\n/g, newline));
    if (additions.length) {
        text = text.trim() ? `${text.replace(/(?:\r?\n)+$/, "")}${newline}${additions.join(newline)}`
            : `${additions.join(newline)}${header.end === header.start ? newline : ""}`;
    }
    return source.slice(0, header.start) + text + source.slice(header.end);
}

function isComment(text) { return text.startsWith("#"); }
function indentOf(line) { return /^[ \t]*/.exec(line)[0].length; }

function blockScalar(indicator, lines) {
    const content = lines.filter((line, index) => line.trim() || lines.slice(index).some((rest) => rest.trim()));
    const indent = Math.min(...content.filter((line) => line.trim()).map(indentOf));
    const values = content.map((line) => line.slice(Number.isFinite(indent) ? indent : 0));
    const text = indicator.startsWith(">")
        ? values.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ")
        : values.join("\n");
    return indicator.includes("-") ? text : `${text}\n`;
}

function parseBlock(lines, indent) {
    if (/^-(?:[ \t]|$)/.test(lines[0].slice(indent))) {
        const items = [];
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (indentOf(line) < indent) break;
            const own = line.slice(indent);
            if (!/^-(?:[ \t]|$)/.test(own)) throw new Error("Unsupported sequence");
            const value = own.slice(1).trim();
            const nested = [];
            while (index + 1 < lines.length && indentOf(lines[index + 1]) > indent) nested.push(lines[++index]);
            if (value && nested.length) throw new Error("Unsupported sequence item");
            items.push(value ? parseInline(value) : nested.length ? parseBlock(nested, indentOf(nested[0])) : null);
        }
        return items;
    }
    const value = {};
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (indentOf(line) !== indent) throw new Error("Unsupported mapping");
        const own = line.slice(indent);
        const match = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#\s][^:]*?)[ \t]*:(?:[ \t]+(.*))?$/.exec(own);
        if (!match) throw new Error("Unsupported mapping entry");
        const key = String(parseScalar(match[1]));
        const nested = [];
        while (index + 1 < lines.length && (indentOf(lines[index + 1]) > indent
            || indentOf(lines[index + 1]) === indent && /^-(?:[ \t]|$)/.test(lines[index + 1].slice(indent)) && !match[2])) nested.push(lines[++index]);
        const inline = match[2]?.trim();
        value[key] = inline && !isComment(inline) ? parseInline(inline) : nested.length ? parseBlock(nested, indentOf(nested[0])) : null;
    }
    return value;
}

function parseInline(text) {
    text = stripComment(text);
    // Obsidian links written without quotes would otherwise read as nested lists.
    if (/^\[\[[^\]]*\]\]$/.test(text)) return text;
    if (/^[[{]/.test(text)) return parseFlowText(text);
    return parseScalar(text);
}

function stripComment(text) {
    let quote = null;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (quote) {
            if (character === "\\" && quote === '"') index += 1;
            else if (character === quote) quote = null;
        } else if (character === '"' || character === "'") quote = character;
        else if (character === "#" && /\s/.test(text[index - 1] ?? "")) return text.slice(0, index).trim();
    }
    return text.trim();
}

function parseScalar(text) {
    text = text.trim();
    if (text.startsWith('"')) return JSON.parse(text);
    if (text.startsWith("'")) {
        if (!/^'(?:[^']|'')*'$/.test(text)) throw new Error("Unterminated string");
        return text.slice(1, -1).replaceAll("''", "'");
    }
    if (text === "" || text === "~" || /^null$/i.test(text)) return null;
    if (/^(?:true|false)$/i.test(text)) return text.toLowerCase() === "true";
    if (/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(text)) return Number(text);
    return text;
}

function parseFlowText(text) {
    const parser = { text, index: 0 };
    const value = parseFlow(parser);
    skipSpace(parser);
    if (parser.index !== text.length && !isComment(text.slice(parser.index))) throw new Error("Trailing flow content");
    return value;
}

function skipSpace(parser) {
    while (/\s/.test(parser.text[parser.index] ?? "")) parser.index += 1;
}

function parseFlow(parser) {
    skipSpace(parser);
    const character = parser.text[parser.index];
    if (character === "[") {
        // An unquoted [[wiki link]] item is a string, as Obsidian intends it.
        const link = /^\[\[[^\]]*\]\]/.exec(parser.text.slice(parser.index));
        if (link && parser.text[parser.index - 1] !== undefined && /[[,\s]/.test(parser.text[parser.index - 1])) {
            parser.index += link[0].length;
            return link[0];
        }
        parser.index += 1;
        const items = [];
        skipSpace(parser);
        if (parser.text[parser.index] === "]") { parser.index += 1; return items; }
        for (;;) {
            items.push(parseFlow(parser));
            skipSpace(parser);
            const next = parser.text[parser.index++];
            if (next === "]") return items;
            if (next !== ",") throw new Error("Invalid flow sequence");
            skipSpace(parser);
            if (parser.text[parser.index] === "]") { parser.index += 1; return items; }
        }
    }
    if (character === "{") {
        parser.index += 1;
        const value = {};
        skipSpace(parser);
        if (parser.text[parser.index] === "}") { parser.index += 1; return value; }
        for (;;) {
            skipSpace(parser);
            const key = String(flowScalar(parser, ":"));
            skipSpace(parser);
            if (parser.text[parser.index++] !== ":") throw new Error("Invalid flow mapping");
            value[key] = parseFlow(parser);
            skipSpace(parser);
            const next = parser.text[parser.index++];
            if (next === "}") return value;
            if (next !== ",") throw new Error("Invalid flow mapping");
            skipSpace(parser);
            if (parser.text[parser.index] === "}") { parser.index += 1; return value; }
        }
    }
    return flowScalar(parser, "");
}

function flowScalar(parser, extraStop) {
    skipSpace(parser);
    const rest = parser.text.slice(parser.index);
    const quoted = /^"(?:[^"\\]|\\.)*"|^'(?:[^']|'')*'/.exec(rest);
    if (quoted) {
        parser.index += quoted[0].length;
        return parseScalar(quoted[0]);
    }
    let end = parser.index;
    while (end < parser.text.length && !",]}".includes(parser.text[end])
        && !(extraStop && parser.text[end] === ":" && /[\s,\]}]|$/.test(parser.text[end + 1] ?? ""))) end += 1;
    const raw = parser.text.slice(parser.index, end);
    parser.index = end;
    return parseScalar(raw);
}
