import { decodeReadableMarkdown, encodeReadableMarkdown, isReadableMarkdown, isSafeMarkdownPath, discoverMarkdownWorkspace, parseMarkdownWorkspace, parseMarkdownWorkspaceManifest } from "./workspaceMarkdown";
import { sameVaultFile, type VaultFile } from "./vaultTypes";

type Result<T> = { value: T; conflicted: boolean };
type Patch = { start: number; end: number; insert: string[] };
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const absent = Symbol("absent");
type OptionalJson = Json | typeof absent;
const MAX_SOURCE = 1_000_000;
const MAX_DIFF_CELLS = 1_000_000;
const MAX_MERGE_CELLS = 4_000_000;
type DiffBudget = { remainingCells: number };

/** A deterministic three-way merge. The caller must durably retain all inputs
 * before publishing the result, including when an ambiguous passage picks cloud. */
export function mergeVaultFile(path: string, base: VaultFile | null, local: VaultFile | null, remote: VaultFile | null): { file: VaultFile | null; conflicted: boolean } {
  if (sameVaultFile(local, remote)) return { file: remote, conflicted: false };
  if (sameVaultFile(base, local)) return { file: remote, conflicted: false };
  if (sameVaultFile(base, remote)) return { file: local, conflicted: false };
  // A stale device must not resurrect a document deleted elsewhere.
  if (!local || !remote) return { file: null, conflicted: true };
  const fallback = { file: remote, conflicted: true };
  if (!base || base.encoding || local.encoding || remote.encoding
    || [base, local, remote].some((file) => file.content.length > MAX_SOURCE || file.content.includes("\0"))) return fallback;
  try {
    if (path === "workspace.json") {
      const inputs = [base, local, remote].map((file) => JSON.parse(file.content) as Json);
      if (!inputs.every((value) => parseMarkdownWorkspaceManifest(value))) return fallback;
      const merged = mergeJson(inputs[0], inputs[1], inputs[2]);
      if (!parseMarkdownWorkspaceManifest(merged.value)) return fallback;
      return { file: { ...remote, content: JSON.stringify(merged.value, null, 2) }, conflicted: merged.conflicted };
    }
    if (!/\.md$/iu.test(path)) return fallback;
    const inputs = [base.content, local.content, remote.content];
    const [before, edited, current] = inputs.map(decodeReadableMarkdown);
    const merged = mergeMarkdown(before, edited, current, path);
    if (inputs.some(isReadableMarkdown)) merged.value = encodeReadableMarkdown(merged.value);
    // Validate with the actual reader, so a combination of valid edits cannot
    // publish invalid references or metadata that prevents reopening a document.
    const workspace = discoverMarkdownWorkspace({ [path]: merged.value });
    if (!parseMarkdownWorkspace(workspace.manifest, workspace.files)) return fallback;
    return { file: { ...remote, content: merged.value }, conflicted: merged.conflicted };
  } catch {
    return fallback;
  }
}

function equal(a: OptionalJson, b: OptionalJson): boolean {
  if (a === b) return true;
  if (a === absent || b === absent || a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => equal(value, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

function record(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeJson(base: OptionalJson, local: OptionalJson, remote: OptionalJson, key = "", depth = 0): Result<OptionalJson> {
  if (equal(local, remote) || equal(base, local)) return { value: remote, conflicted: false };
  if (equal(base, remote)) return { value: local, conflicted: false };
  if (local === absent || remote === absent) return { value: absent, conflicted: true };
  // Edit timestamps are observations, not competing authored passages.
  if (["updatedAt", "savedAt", "updated"].includes(key) && typeof local === "string" && typeof remote === "string"
    && Number.isFinite(Date.parse(local)) && Number.isFinite(Date.parse(remote))) {
    return { value: Date.parse(local) > Date.parse(remote) ? local : remote, conflicted: false };
  }
  if (depth > 40) return { value: remote, conflicted: true };
  if (record(base) && record(local) && record(remote)) {
    const entries: [string, Json][] = [];
    let conflicted = false;
    for (const name of new Set([...Object.keys(remote), ...Object.keys(local), ...Object.keys(base)])) {
      const read = (value: Record<string, Json>) => Object.hasOwn(value, name) ? value[name] : absent;
      const merged = mergeJson(read(base), read(local), read(remote), name, depth + 1);
      conflicted ||= merged.conflicted;
      if (merged.value !== absent) entries.push([name, merged.value]);
    }
    return { value: Object.fromEntries(entries), conflicted };
  }
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    if ([base, local, remote].some((items) => items.length > 2_000)) return { value: remote, conflicted: true };
    const keyed = (items: Json[]) => items.every((item) => record(item) && typeof item.id === "string")
      && new Set(items.map((item) => (item as Record<string, Json>).id)).size === items.length;
    if ([base, local, remote].every(keyed)) {
      const maps = [base, local, remote].map((items) => new Map(items.map((item) => [(item as Record<string, Json>).id as string, item])));
      const values = new Map<string, Json>();
      let conflicted = false;
      for (const id of new Set(maps.flatMap((map) => [...map.keys()]))) {
        const merged = mergeJson(maps[0].get(id) ?? absent, maps[1].get(id) ?? absent, maps[2].get(id) ?? absent, "", depth + 1);
        conflicted ||= merged.conflicted;
        if (merged.value !== absent) values.set(id, merged.value);
      }
      const order = mergeOrder(...maps.map((map) => [...map.keys()]) as [string[], string[], string[]], new Set(values.keys()));
      return { value: order.value.map((id) => values.get(id)!), conflicted: conflicted || order.conflicted };
    }
  }
  return { value: remote, conflicted: true };
}

/** Keep an unopposed move; competing moves use cloud order. Independent new
 * identities survive even when both devices insert at the same position. */
function mergeOrder(base: string[], local: string[], remote: string[], keep: Set<string>): Result<string[]> {
  const common = new Set(base.filter((id) => keep.has(id) && local.includes(id) && remote.includes(id)));
  const existing = (ids: string[]) => ids.filter((id) => common.has(id)).join("\0");
  const localMoved = existing(local) !== existing(base);
  const remoteMoved = existing(remote) !== existing(base);
  const primary = localMoved && !remoteMoved ? local : remote;
  const secondary = primary === remote ? local : remote;
  const order = primary.filter((id) => keep.has(id));
  for (let index = 0; index < secondary.length; index += 1) {
    const id = secondary[index];
    if (!keep.has(id) || order.includes(id)) continue;
    const next = secondary.slice(index + 1).find((candidate) => order.includes(candidate));
    order.splice(next === undefined ? order.length : order.indexOf(next), 0, id);
  }
  return { value: order, conflicted: localMoved && remoteMoved && existing(local) !== existing(remote) };
}

/** Bounded LCS after trimming equal edges. Oversized ambiguous ranges use the
 * same recovery fallback as any other unresolved overlap. */
function patches(base: string[], changed: string[], budget: DiffBudget): Patch[] | null {
  let start = 0;
  while (start < base.length && start < changed.length && base[start] === changed[start]) start += 1;
  let aEnd = base.length;
  let bEnd = changed.length;
  while (aEnd > start && bEnd > start && base[aEnd - 1] === changed[bEnd - 1]) { aEnd -= 1; bEnd -= 1; }
  const n = aEnd - start;
  const m = bEnd - start;
  if (!n || !m) return n || m ? [{ start, end: aEnd, insert: changed.slice(start, bEnd) }] : [];
  const cells = (n + 1) * (m + 1);
  if (cells > MAX_DIFF_CELLS || cells > budget.remainingCells) return null;
  budget.remainingCells -= cells;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let a = n - 1; a >= 0; a -= 1) for (let b = m - 1; b >= 0; b -= 1) {
    table[a * width + b] = base[start + a] === changed[start + b]
      ? 1 + table[(a + 1) * width + b + 1]
      : Math.max(table[(a + 1) * width + b], table[a * width + b + 1]);
  }
  const result: Patch[] = [];
  let pending: Patch | undefined;
  let a = 0;
  let b = 0;
  while (a < n || b < m) {
    if (a < n && b < m && base[start + a] === changed[start + b]) {
      if (pending) result.push(pending);
      pending = undefined;
      a += 1; b += 1;
    } else {
      pending ??= { start: start + a, end: start + a, insert: [] };
      if (b < m && (a === n || table[a * width + b + 1] > table[(a + 1) * width + b])) {
        pending.insert.push(changed[start + b++]);
      } else { a += 1; pending.end = start + a; }
    }
  }
  if (pending) result.push(pending);
  return result;
}

function overlaps(a: Patch, b: Patch) {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

function mergeTokens(base: string[], local: string[], remote: string[], budget: DiffBudget, refine?: (base: string, local: string, remote: string) => Result<string>): Result<string> {
  if (local.join("") === remote.join("") || base.join("") === local.join("")) return { value: remote.join(""), conflicted: false };
  if (base.join("") === remote.join("")) return { value: local.join(""), conflicted: false };
  const left = patches(base, local, budget);
  const right = patches(base, remote, budget);
  if (!left || !right) return { value: remote.join(""), conflicted: true };
  const accepted = [...right];
  let conflicted = false;
  // Connected overlapping patches form one ambiguity region. Resolve the whole
  // region together instead of splicing half of either replacement into it.
  const pending = [...left];
  while (pending.length) {
    const group = [pending.shift()!];
    const remoteGroup: Patch[] = [];
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const patch of right) if (!remoteGroup.includes(patch) && group.some((item) => overlaps(item, patch))) { remoteGroup.push(patch); expanded = true; }
      for (let i = pending.length - 1; i >= 0; i -= 1) if (remoteGroup.some((item) => overlaps(item, pending[i]))) { group.push(pending.splice(i, 1)[0]); expanded = true; }
    }
    if (!remoteGroup.length) { accepted.push(...group); continue; }
    const start = Math.min(...group.map((p) => p.start), ...remoteGroup.map((p) => p.start));
    const end = Math.max(...group.map((p) => p.end), ...remoteGroup.map((p) => p.end));
    const render = (items: Patch[]) => applyPatches(base.slice(start, end), items.map((p) => ({ ...p, start: p.start - start, end: p.end - start })));
    const l = render(group);
    const r = render(remoteGroup);
    const resolution = l === r ? { value: r, conflicted: false }
      : refine ? refine(base.slice(start, end).join(""), l, r) : { value: r, conflicted: true };
    conflicted ||= resolution.conflicted;
    for (const patch of remoteGroup) accepted.splice(accepted.indexOf(patch), 1);
    accepted.push({ start, end, insert: [resolution.value] });
  }
  return { value: applyPatches(base, accepted), conflicted };
}

function applyPatches(base: string[], edits: Patch[]): string {
  let cursor = 0;
  const output: string[] = [];
  for (const patch of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
    output.push(...base.slice(cursor, patch.start), ...patch.insert);
    cursor = patch.end;
  }
  output.push(...base.slice(cursor));
  return output.join("");
}

function mergeText(base: string, local: string, remote: string, budget: DiffBudget): Result<string> {
  const lines = (value: string) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const words = (value: string) => value.match(/\0[^\0]*\0|[\p{L}\p{N}_]+|[^\S\r\n]+|\r\n|[^\p{L}\p{N}_\s\0]+|[\r\n]/gu) ?? [];
  return mergeTokens(lines(base), lines(local), lines(remote), budget, (b, l, r) => mergeTokens(words(b), words(l), words(r), budget));
}

type Node = { key: string; kind: string; metadata: Record<string, Json>; content?: string; raw: string; newline: string };
type Parsed = { source: string; nodes: Map<string, Node>; identity: string | undefined };
const token = (key: string) => `\0${key}\0`;
const keys = (text: string) => [...text.matchAll(/\0([^\0]*)\0/g)].map((match) => match[1]);

function documentLayout(source: string) {
  const opening = /^<!-- margin-chat-document -->\r?$/m.exec(source);
  const closing = /^<!-- margin-chat-document-end -->\r?$/m.exec(source);
  if (!opening || !closing || closing.index < opening.index) return null;
  const raw = source.slice(opening.index, closing.index + closing[0].length);
  const ids = keys(raw);
  // Ordinary generated block containers have only headings and whitespace
  // between nodes. Unknown authored inter-block content takes the source merge.
  if (ids.some((id) => !id.startsWith("document-block:"))
    || !/^<!-- margin-chat-document -->\s*(?:## Document\s*)?<!-- margin-chat-document-end -->\r?$/.test(raw.replace(/\0[^\0]*\0/g, ""))) return null;
  const first = ids.length ? raw.indexOf(token(ids[0])) : closing.index - opening.index;
  const last = ids.length ? raw.lastIndexOf(token(ids.at(-1)!)) + token(ids.at(-1)!).length : first;
  const gaps = new Map(ids.slice(0, -1).map((id, index) => [JSON.stringify([id, ids[index + 1]]),
    raw.slice(raw.indexOf(token(id)) + token(id).length, raw.indexOf(token(ids[index + 1])))]));
  return { raw, ids, gaps, prefix: raw.slice(0, first), suffix: raw.slice(last), newline: raw.includes("\r\n") ? "\r\n" : "\n" };
}

/** Treat known marker payloads as structured data, and all unrecognized Markdown
 * as source text. No Markdown reserialization can discard unfamiliar syntax. */
function parseMarkdown(source: string): Parsed {
  const nodes = new Map<string, Node>();
  const marker = /^<!-- margin-chat-(metadata|document-block|message) (.+) -->\r?$/gm;
  let cursor = 0;
  let skeleton = "";
  let match: RegExpExecArray | null;
  while ((match = marker.exec(source))) {
    const kind = match[1];
    const metadata = JSON.parse(match[2]) as Json;
    if (!record(metadata) || kind !== "metadata" && (typeof metadata.id !== "string" || !metadata.id)) throw new Error("Invalid marker");
    // JSON escaping keeps arbitrary valid IDs (including control characters)
    // distinct from the private NUL-delimited skeleton tokens.
    const key = kind === "metadata" ? kind : `${kind}:${JSON.stringify(metadata.id)}`;
    if (nodes.has(key)) throw new Error("Duplicate identity");
    const newline = source[marker.lastIndex - 1] === "\r" ? "\r\n" : "\n";
    let end = marker.lastIndex;
    let content: string | undefined;
    if (kind !== "metadata") {
      if (source[end] !== "\n") throw new Error("Missing block content");
      const contentStart = end + 1;
      const ending = kind === "document-block" ? `<!-- margin-chat-document-block-end ${JSON.stringify(metadata.id)} -->` : "<!-- margin-chat-message-end -->";
      const expected = contentStart + Number(metadata.contentLength);
      let contentEnd = Number.isSafeInteger(metadata.contentLength) && Number(metadata.contentLength) >= 0 && source.startsWith(`${newline}${ending}`, expected) ? expected : -1;
      if (contentEnd < 0 && newline === "\r\n" && Number.isSafeInteger(metadata.contentLength) && Number(metadata.contentLength) >= 0) {
        let offset = contentStart;
        for (let consumed = 0; consumed < Number(metadata.contentLength) && offset < source.length; consumed += 1) offset += source.startsWith("\r\n", offset) ? 2 : 1;
        if (source.startsWith(`${newline}${ending}`, offset)) contentEnd = offset;
      }
      if (contentEnd < 0) contentEnd = source.indexOf(`${newline}${ending}`, contentStart);
      if (contentEnd < 0) throw new Error("Incomplete block");
      content = source.slice(contentStart, contentEnd);
      end = contentEnd + newline.length + ending.length;
      marker.lastIndex = end;
    }
    nodes.set(key, { key, kind, metadata, content, raw: source.slice(match.index, end), newline });
    skeleton += source.slice(cursor, match.index) + token(key);
    cursor = end;
  }
  skeleton += source.slice(cursor);
  // Never treat a damaged marker as prose and accidentally merge its JSON.
  if (/<!--\s*margin-chat-(?:metadata|document-block|message)\b/.test(skeleton)) throw new Error("Malformed marker");
  const documentStarts = skeleton.match(/^<!-- margin-chat-document -->\r?$/gm) ?? [];
  const documentEnds = skeleton.match(/^<!-- margin-chat-document-end -->\r?$/gm) ?? [];
  if (documentStarts.length !== documentEnds.length || documentStarts.length > 1) throw new Error("Malformed document section");
  const documentStart = skeleton.indexOf("<!-- margin-chat-document -->");
  const documentEnd = skeleton.indexOf("<!-- margin-chat-document-end -->");
  if ([...nodes].some(([key, node]) => node.kind === "document-block"
    && (skeleton.indexOf(token(key)) < documentStart || skeleton.indexOf(token(key)) > documentEnd))) throw new Error("Block outside document section");
  // Keep the generated frontmatter observation out of the prose diff. Splitting
  // a timestamp into word tokens could combine two dates or invent a conflict.
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(skeleton)?.[0];
  const updated = frontmatter && /^updated:[ \t]*(.+?)\r?$/m.exec(frontmatter);
  if (updated) {
    let date = updated[1];
    try { date = JSON.parse(date); } catch { date = date.replace(/^'|'$/g, ""); }
    if (typeof date === "string" && Number.isFinite(Date.parse(date))) {
      const key = "frontmatter-updated";
      nodes.set(key, { key, kind: key, metadata: { updated: date }, raw: updated[0], newline: "\n" });
      skeleton = skeleton.slice(0, updated.index) + token(key) + skeleton.slice(updated.index + updated[0].length);
    }
  }
  const metadata = nodes.get("metadata")?.metadata;
  const entity = metadata && (record(metadata.conversation) ? metadata.conversation : record(metadata.note) ? metadata.note : undefined);
  const frontId = /^margin-chat-id:\s*(.+)\r?$/m.exec(source)?.[1]?.trim();
  const identity = entity && typeof entity.id === "string" ? entity.id : frontId;
  return { source: skeleton, nodes, identity };
}

function mergeNode(base: Node | undefined, local: Node | undefined, remote: Node | undefined, budget: DiffBudget): Result<Node | undefined> {
  if (local?.raw === remote?.raw || base?.raw === local?.raw) return { value: remote, conflicted: false };
  if (base?.raw === remote?.raw) return { value: local, conflicted: false };
  if (!local || !remote) return { value: undefined, conflicted: true };
  if (!base) return { value: remote, conflicted: true };
  const withoutLength = (node: Node) => Object.fromEntries(Object.entries(node.metadata).filter(([key]) => key !== "contentLength"));
  const metadata = mergeJson(withoutLength(base), withoutLength(local), withoutLength(remote));
  if (!record(metadata.value)) return { value: remote, conflicted: true };
  const body = base.content === undefined ? { value: undefined, conflicted: false } : mergeText(base.content, local.content!, remote.content!, budget);
  const value = { ...remote, metadata: metadata.value, content: body.value };
  if (value.kind === "frontmatter-updated") {
    value.raw = `updated: ${JSON.stringify(value.metadata.updated)}${remote.raw.endsWith("\r") ? "\r" : ""}`;
    return { value, conflicted: metadata.conflicted };
  }
  const json = JSON.stringify({ ...value.metadata, ...(body.value === undefined ? {} : { contentLength: body.value.length }) }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  value.raw = `<!-- margin-chat-${value.kind} ${json} -->` + (body.value === undefined ? "" : `${value.newline}${body.value}${value.newline}<!-- margin-chat-${value.kind}-end${value.kind === "document-block" ? ` ${JSON.stringify(value.metadata.id)}` : ""} -->`);
  return { value, conflicted: metadata.conflicted || body.conflicted };
}

function mergeMarkdown(base: string, local: string, remote: string, path: string): Result<string> {
  // One allowance covers every block, surrounding source, and refinement in
  // this merge. A document with many difficult blocks must not freeze saving.
  const budget: DiffBudget = { remainingCells: MAX_MERGE_CELLS };
  const [b, l, r] = [base, local, remote].map(parseMarkdown);
  if (b.identity !== l.identity || b.identity !== r.identity) return { value: remote, conflicted: true };
  const frontmatterId = (source: string) => /^margin-chat-id:[ \t]*(.+?)\r?$/m.exec(source)?.[1];
  if (frontmatterId(base) !== frontmatterId(local) || frontmatterId(base) !== frontmatterId(remote)) return { value: remote, conflicted: true };
  const nodes = new Map<string, Node>();
  let conflicted = false;
  for (const key of new Set([...b.nodes.keys(), ...l.nodes.keys(), ...r.nodes.keys()])) {
    const merged = mergeNode(b.nodes.get(key), l.nodes.get(key), r.nodes.get(key), budget);
    conflicted ||= merged.conflicted;
    if (merged.value) {
      if (key === "metadata") {
        const metadata = merged.value.metadata;
        const files = [b, l, r].map((input) => input.nodes.get("metadata")?.metadata.file).filter(record);
        const remoteFile = r.nodes.get("metadata")?.metadata.file;
        if (files.length || record(metadata.file)) {
          const nextFile = record(metadata.file) ? { ...metadata.file } : {};
          const aliases = [...new Set([...files, nextFile].flatMap((file) => [
            ...(Array.isArray(file.aliases) ? file.aliases : []), file.managedPath,
          ]).filter((value): value is string => typeof value === "string" && value !== path && isSafeMarkdownPath(value)))];
          // The surviving cloud location determines filename ownership. A local
          // title rename must not claim an external cloud path, or accidentally
          // make the still-managed cloud path appear externally renamed.
          if (record(remoteFile) && typeof remoteFile.managedPath === "string") nextFile.managedPath = remoteFile.managedPath === path ? path : remoteFile.managedPath;
          else delete nextFile.managedPath;
          if (aliases.length) nextFile.aliases = aliases;
          else delete nextFile.aliases;
          merged.value = { ...merged.value, metadata: { ...metadata, file: nextFile } };
          merged.value.raw = `<!-- margin-chat-metadata ${JSON.stringify(merged.value.metadata).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")} -->${merged.value.raw.endsWith("\r") ? "\r" : ""}`;
        }
      }
      nodes.set(key, merged.value);
    }
  }
  const layouts = [b, l, r].map((parsed) => documentLayout(parsed.source));
  let documentSource: string | undefined;
  let sources = [b.source, l.source, r.source];
  if (layouts.every((layout) => layout !== null)) {
    const [baseLayout, localLayout, remoteLayout] = layouts as NonNullable<ReturnType<typeof documentLayout>>[];
    const keep = new Set([...nodes.keys()].filter((key) => key.startsWith("document-block:")));
    const order = mergeOrder(baseLayout.ids, localLayout.ids, remoteLayout.ids, keep);
    conflicted ||= order.conflicted;
    const layout = remoteLayout.ids.length ? remoteLayout : localLayout.ids.length ? localLayout : baseLayout;
    const separator = `${layout.newline}${layout.newline}`;
    const prefix = mergeText(baseLayout.prefix, localLayout.prefix, remoteLayout.prefix, budget);
    const suffix = mergeText(baseLayout.suffix, localLayout.suffix, remoteLayout.suffix, budget);
    conflicted ||= prefix.conflicted || suffix.conflicted;
    const body = order.value.map((id, index) => {
      if (index === 0) return token(id);
      const pair = JSON.stringify([order.value[index - 1], id]);
      const gaps = [baseLayout, localLayout, remoteLayout].map((item) => item.gaps.get(pair));
      const gap = gaps.every((value) => value !== undefined) ? mergeText(gaps[0]!, gaps[1]!, gaps[2]!, budget)
        : { value: gaps[2] ?? gaps[1] ?? gaps[0] ?? separator, conflicted: false };
      conflicted ||= gap.conflicted;
      return gap.value + token(id);
    }).join("");
    // Use the selected intact layout around stable block identities; block
    // content is merged separately, so moves never discard concurrent typing.
    documentSource = prefix.value + body + suffix.value;
    sources = sources.map((source, index) => source.replace(layouts[index]!.raw, token("document-container")));
  }
  const source = mergeText(sources[0], sources[1], sources[2], budget);
  conflicted ||= source.conflicted;
  let skeleton = source.value;
  if (documentSource !== undefined) skeleton = skeleton.replace(token("document-container"), () => documentSource!);
  // Conflicting moves can duplicate an identity in a text diff. Choose a valid
  // cloud arrangement while retaining all independently merged block contents.
  const present = keys(skeleton);
  if (new Set(present).size !== present.length || [...nodes.keys()].some((key) => b.nodes.has(key) && !present.includes(key))) {
    skeleton = r.source;
    conflicted = true;
  }
  for (const key of keys(skeleton)) if (!nodes.has(key)) skeleton = skeleton.replace(token(key), "");
  // Preserve new local identities even if both devices inserted at the same gap.
  for (const [key] of nodes) {
    if (skeleton.includes(token(key))) continue;
    const side = l.nodes.has(key) ? l : r;
    const kind = nodes.get(key)!.kind;
    const order = keys(side.source).filter((id) => side.nodes.get(id)?.kind === kind);
    const index = order.indexOf(key);
    const next = order.slice(index + 1).find((id) => skeleton.includes(token(id)));
    const previous = order.slice(0, index).reverse().find((id) => skeleton.includes(token(id)));
    if (next) skeleton = skeleton.replace(token(next), () => `${token(key)}\n\n${token(next)}`);
    else if (previous) skeleton = skeleton.replace(token(previous), () => `${token(previous)}\n\n${token(key)}`);
    else if (kind === "document-block" && skeleton.includes("<!-- margin-chat-document-end -->")) {
      skeleton = skeleton.replace("<!-- margin-chat-document-end -->", () => `${token(key)}\n\n<!-- margin-chat-document-end -->`);
    } else if (kind === "message") {
      const peer = keys(skeleton).reverse().find((id) => nodes.get(id)?.kind === "message");
      if (!peer) return { value: remote, conflicted: true };
      skeleton = skeleton.replace(token(peer), () => `${token(peer)}\n\n${token(key)}`);
    } else return { value: remote, conflicted: true };
  }
  return { value: skeleton.replace(/\0([^\0]*)\0/g, (_match, key: string) => nodes.get(key)!.raw), conflicted };
}
