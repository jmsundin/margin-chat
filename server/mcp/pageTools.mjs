import { vaultFileDocumentId } from "@margin-chat/workspace-contracts";

/**
 * Tools that let an agent with a write token keep an HTML page in the vault up to date: a game or
 * tool the member plays inside Margin Chat, and the scripts and styles in its folder. Unlike notes,
 * a page is code, so it is edited in place. Every change first keeps the version it replaces under
 * `.margin-chat/page-versions/`, and is saved through the vault's normal commit, so an edit made on
 * another device meanwhile is refused rather than overwritten. Notes, PDFs and pictures are out of reach,
 * and so is a page the member hid from AI, with the files in its folder.
 */

export const MAX_PAGE_FILE_BYTES = 4_000_000;
export const MAX_PAGE_READ_CHARACTERS = 60_000;
export const MAX_PAGE_WRITE_CHARACTERS = 200_000;
const MAX_EDITS = 40;
const MAX_MATCHES = 30;
/** Versions kept per file; a game edited often would otherwise fill the vault with copies of itself. */
export const MAX_PAGE_VERSIONS = 20;
const HTML = /\.html?$/iu;
/** Text a page is made of. Notes are not among them. */
const TEXT = /\.(?:html?|js|mjs|css|json|svg|csv|xml)$/iu;
const MANAGED = /^(?:attachments|_conflicts|\.margin-chat)(?:\/|$)/iu;
const TYPES = { html: "text/html", htm: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css",
  json: "application/json", svg: "image/svg+xml", csv: "text/csv", xml: "application/xml" };
const CHANGING = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const PAGE_READ_TOOL_DEFINITION = {
  name: "read_page_file",
  title: "Read page file",
  description: "Read the source of an HTML page in the user's Margin Chat vault (a game or tool they play there), or of a script, stylesheet or data file in that page's folder. With an empty path, lists the pages and the files beside them. A long file is read in parts with offset and limit, or searched with search, which returns each match's offset and the text around it. Returns the revision_id that edit_page_file needs.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file's path in the vault, as the listing gives it. An empty string lists pages and their files." },
      offset: { type: "integer", minimum: 0, description: "Character to start reading at. Default 0." },
      limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_READ_CHARACTERS, description: `Characters to return, at most ${MAX_PAGE_READ_CHARACTERS}.` },
      search: { type: "string", description: "Exact text to find in the file instead of reading a range." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

export const PAGE_EDIT_TOOL_DEFINITION = {
  name: "edit_page_file",
  title: "Edit page file",
  description: "Change an HTML page in the user's Margin Chat vault, or a text file in that page's folder, in place. Give edits (each old_text must occur exactly once in the file and is replaced by new_text) with the revision_id you read, or give content to replace the whole file or to add a new file in a page's folder. The version being replaced is kept, and what the page saved (progress) is untouched. Notes, PDFs and pictures can't be edited with this tool.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file's path in the vault." },
      base_revision_id: { type: "string", description: "The revision_id you read. Omit only when adding a new file." },
      edits: {
        type: "array", minItems: 1, maxItems: MAX_EDITS,
        description: "Applied in order to the revision you read.",
        items: {
          type: "object",
          properties: {
            old_text: { type: "string", description: "Text that occurs exactly once in the file." },
            new_text: { type: "string", description: "What replaces it; empty deletes it." },
          },
          required: ["old_text", "new_text"],
          additionalProperties: false,
        },
      },
      content: { type: "string", description: "The whole file's new text, instead of edits." },
      reason: { type: "string", description: "Optional, at most 280 characters: what changed and why." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: CHANGING,
};

export const PAGE_TOOL_NAMES = new Set([PAGE_READ_TOOL_DEFINITION.name, PAGE_EDIT_TOOL_DEFINITION.name]);

const fail = (error) => ({ ok: false, error });
const folderOf = (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const visible = (path) => !MANAGED.test(path) && !path.split("/").some((part) => part.startsWith("."));

/** Where the version a change replaces is kept: beside nothing the member sees, named by when it was replaced. */
export function pageVersionPath(path, stamp) {
  return `.margin-chat/page-versions/${path}/${stamp.replace(/[:.]/gu, "-")}.${/\.([a-z0-9]+)$/iu.exec(path)?.[1]?.toLowerCase() ?? "txt"}`;
}

/** The text with each edit applied in order, or the reason one of them can't be. */
export function applyPageEdits(text, edits) {
  let next = text;
  for (const [index, edit] of edits.entries()) {
    if (typeof edit?.old_text !== "string" || typeof edit?.new_text !== "string" || !edit.old_text) return fail(`Edit ${index + 1} needs old_text and new_text.`);
    const first = next.indexOf(edit.old_text);
    if (first < 0) return fail(`Edit ${index + 1}: old_text isn't in the file. Read it again and copy the text exactly.`);
    if (next.indexOf(edit.old_text, first + 1) >= 0) return fail(`Edit ${index + 1}: old_text occurs more than once. Include more of the text around it.`);
    next = next.slice(0, first) + edit.new_text + next.slice(first + edit.old_text.length);
  }
  return { ok: true, text: next };
}

export function createPageTools({ userId, vault, database, quotaBytes, now = () => new Date() }) {
  async function files() {
    const [{ manifest }, hidden] = await Promise.all([
      vault.status(userId, { quotaBytes }),
      database?.listAIHiddenIds ? database.listAIHiddenIds({ userId }) : [],
    ]);
    const all = Object.fromEntries(Object.entries(manifest?.files ?? {}).filter(([path, entry]) => !entry.deleted && visible(path)));
    const hiddenIds = new Set(hidden);
    const hiddenPages = Object.keys(all).filter((path) => HTML.test(path) && hiddenIds.has(vaultFileDocumentId(path)));
    // A hidden page takes its folder with it: its scripts are the page.
    const hiddenFolders = hiddenPages.map(folderOf).filter(Boolean);
    return Object.fromEntries(Object.entries(all).filter(([path]) => !hiddenPages.includes(path)
      && !hiddenFolders.some((folder) => path.startsWith(`${folder}/`))));
  }
  /** The oldest kept versions of a file beyond the newest ones, as deletions for the same commit. */
  async function surplusVersions(path, adding) {
    const { manifest } = await vault.status(userId, { quotaBytes });
    const prefix = `.margin-chat/page-versions/${path}/`;
    const kept = Object.entries(manifest?.files ?? {}).filter(([other, entry]) => !entry.deleted && other.startsWith(prefix) && other !== adding)
      .sort(([left], [right]) => left < right ? -1 : 1);
    return kept.slice(0, Math.max(0, kept.length + 1 - MAX_PAGE_VERSIONS)).map(([other, entry]) => ({ path: other, content: null, baseRevision: entry.revision }));
  }
  /** Folders that hold a page; the top of the vault is not one, since everything would be beside a page there. */
  const pageFolders = (all) => new Set(Object.keys(all).filter((path) => HTML.test(path)).map(folderOf).filter(Boolean));
  /** A page itself, or a text file somewhere under a page's folder. */
  function reachable(path, all) {
    if (typeof path !== "string" || !path || path.length > 512 || !visible(path) || !TEXT.test(path)) return false;
    if (path.split("/").some((part) => !part || part === "." || part === "..")) return false;
    if (HTML.test(path) && Object.hasOwn(all, path)) return true;
    const folders = pageFolders(all);
    for (let folder = folderOf(path); folder; folder = folderOf(folder)) if (folders.has(folder)) return true;
    return false;
  }
  const refused = "That isn't an HTML page or a text file in a page's folder. Call read_page_file with an empty path to see what can be read.";

  async function read(args) {
    const all = await files();
    if (args.path === undefined || args.path === "") {
      const folders = pageFolders(all);
      const pages = Object.keys(all).filter((path) => HTML.test(path)).sort().map((path) => {
        const folder = folderOf(path);
        const beside = folder && folders.has(folder)
          ? Object.keys(all).filter((other) => other !== path && other.startsWith(`${folder}/`) && !HTML.test(other)).sort()
            .map((other) => ({ path: other, bytes: all[other].size ?? null, editable: TEXT.test(other) && (all[other].size ?? 0) <= MAX_PAGE_FILE_BYTES })) : [];
        return { path, bytes: all[path].size ?? null, files: beside.slice(0, 200), ...(beside.length > 200 ? { more_files: beside.length - 200 } : {}) };
      });
      return { ok: true, pages };
    }
    const path = String(args.path);
    if (!reachable(path, all) || !all[path]) return fail(all[path] || !TEXT.test(path) ? refused : "No file has that path.");
    if ((all[path].size ?? 0) > MAX_PAGE_FILE_BYTES) return fail("That file is too large to read here.");
    const { bytes, revision } = await vault.readFile({ userId, path, revision: all[path].revision });
    const text = bytes.toString("utf8");
    const base = { ok: true, path, revision_id: revision, total_characters: text.length };
    if (typeof args.search === "string" && args.search) {
      const matches = [];
      let total = 0;
      for (let at = text.indexOf(args.search); at >= 0; at = text.indexOf(args.search, at + args.search.length)) {
        total += 1;
        if (matches.length < MAX_MATCHES) matches.push({ offset: at, around: text.slice(Math.max(0, at - 200), at + args.search.length + 200) });
      }
      return { ...base, matches, total_matches: total };
    }
    const offset = Number.isSafeInteger(args.offset) && args.offset > 0 ? args.offset : 0;
    const limit = Number.isSafeInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, MAX_PAGE_READ_CHARACTERS) : MAX_PAGE_READ_CHARACTERS;
    const part = text.slice(offset, offset + limit);
    return { ...base, offset, text: part, ...(offset + part.length < text.length ? { next_offset: offset + part.length } : {}) };
  }

  async function edit(args) {
    const path = String(args.path ?? "");
    const all = await files();
    if (!reachable(path, all)) return fail(refused);
    const entry = all[path];
    const hasEdits = Array.isArray(args.edits) && args.edits.length > 0;
    const hasContent = typeof args.content === "string";
    if (hasEdits === hasContent) return fail("Give either edits or content.");
    if (hasEdits && args.edits.length > MAX_EDITS) return fail(`Give at most ${MAX_EDITS} edits at a time.`);
    if (!entry && hasEdits) return fail("No file has that path. Give content to add a new file.");
    if (entry && (entry.size ?? 0) > MAX_PAGE_FILE_BYTES) return fail("That file is too large to edit here.");
    let previous = null;
    if (entry) {
      if (typeof args.base_revision_id !== "string" || !args.base_revision_id) return fail("Give the revision_id you read with read_page_file.");
      if (args.base_revision_id !== entry.revision) return fail("That file changed since you read it. Read it again, then retry.");
      previous = (await vault.readFile({ userId, path, revision: entry.revision })).bytes;
    }
    let text = args.content;
    if (hasEdits) {
      const applied = applyPageEdits(previous.toString("utf8"), args.edits);
      if (!applied.ok) return applied;
      text = applied.text;
    }
    if (hasContent && text.length > MAX_PAGE_WRITE_CHARACTERS) return fail(`Replace at most ${MAX_PAGE_WRITE_CHARACTERS} characters at a time; use edits for a longer file.`);
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_PAGE_FILE_BYTES) return fail("That would make the file too large.");
    if (previous && previous.equals(bytes)) return { ok: true, path, revision_id: entry.revision, changed: false };
    // Kept as the upload was: the app reads a page the same way whoever saved it last.
    const contentType = entry?.contentType && entry.contentType !== "application/octet-stream" ? entry.contentType
      : TYPES[/\.([a-z0-9]+)$/iu.exec(path)[1].toLowerCase()] ?? "text/plain";
    const changes = [{ path, content: bytes.toString("base64"), encoding: "base64", contentType, baseRevision: entry?.revision ?? null }];
    let kept = null;
    if (previous) {
      kept = pageVersionPath(path, now().toISOString());
      changes.push({ path: kept, content: previous.toString("base64"), encoding: "base64", contentType, baseRevision: null });
      changes.push(...await surplusVersions(path, kept));
    }
    try {
      const receipt = await vault.commit(userId, changes, { quotaBytes });
      return { ok: true, path, changed: true, revision_id: receipt?.manifest?.files?.[path]?.revision ?? null,
        ...(kept ? { previous_version: kept } : { created: true }) };
    } catch (error) {
      if (error?.statusCode === 409) return fail("That file changed on another device just now. Read it again, then retry.");
      if (error?.statusCode === 413) return fail(error.message);
      throw error;
    }
  }

  const handlers = { read_page_file: read, edit_page_file: edit };
  return {
    async run(name, args) {
      try {
        return await handlers[name](args);
      } catch (error) {
        console.error("MCP page tool failed", error);
        return fail(name === "edit_page_file" ? "The vault couldn't be saved just now. Nothing was changed." : "The vault couldn't be read just now.");
      }
    },
  };
}
