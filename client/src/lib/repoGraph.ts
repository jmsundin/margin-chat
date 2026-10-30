import { apiFetch } from "./apiTransport";
import { ApiError } from "./apiError";
import type { AISettings, BackendServiceId } from "../types";

/**
 * Explore a GitHub repository as a graph. The server downloads and parses
 * the repository (no AI, no cost); this file turns that into the cards and
 * lines of one level at a time: folders, then a file's functions.
 */

export type RepoSymbolKind = "function" | "class" | "method" | "type";
export interface RepoSymbol { name: string; kind: RepoSymbolKind; line: number; end: number; exported: boolean; signature?: string; usedBy?: number[] }
export interface RepoFile { path: string; language: string | null; lines: number; bytes: number; symbols: RepoSymbol[]; imports: string[]; external?: string[] }
export interface RepoGraph {
  repo: { owner: string; name: string; url: string; ref: string | null; folder: string; commit: string | null };
  files: RepoFile[];
  readme: string;
  stats: { files: number; skipped: number; truncated: boolean; downloadedBytes: number };
  retrievedAt: string;
}
export interface RepoAIOptions { serviceId?: BackendServiceId; modelId?: string; ai?: AISettings }

export function isRepoGraph(value: unknown): value is RepoGraph {
  const graph = value as RepoGraph;
  return Boolean(graph && typeof graph === "object" && graph.repo && typeof graph.repo.owner === "string" && typeof graph.repo.name === "string"
    && Array.isArray(graph.files) && graph.files.every((file) => file && typeof file.path === "string" && Array.isArray(file.symbols) && Array.isArray(file.imports))
    && typeof graph.readme === "string" && graph.stats && typeof graph.stats.files === "number");
}

/** `owner/repo`, or a github.com address; null for anything else. Used to spot a pasted repository. */
export function githubRepoFromText(text: string): string | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(\/(?:tree|blob)\/[^\s?#]+)?\/?(?:[?#]\S*)?$/iu);
  if (!match) return null;
  return `https://github.com/${match[1]}/${match[2].replace(/\.git$/u, "")}${match[3] ?? ""}`;
}

async function readStream<T>(response: Response, key: string, signal: AbortSignal, onProgress: (message: string) => void, valid: (value: unknown) => value is T, limit: number): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, typeof body?.error === "string" ? body.error : "That could not be completed. Try again.");
  }
  if (!response.body) throw new Error("The response was empty. Try again.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = "", total = 0, result: T | null = null;
  const event = (line: string) => {
    if (!line.trim()) return;
    const value = JSON.parse(line);
    if (value.type === "error") throw new ApiError(value.statusCode ?? 502, typeof value.error === "string" ? value.error : "That could not be completed.");
    if (value.type === "progress" && typeof value.message === "string") onProgress(value.message);
    if (value.type === "done") {
      if (!valid(value[key])) throw new Error("The server sent something unexpected. Try again.");
      result = value[key];
    }
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      total += value?.length ?? 0;
      if (total > limit) throw new Error("The response was too large.");
      const lines = pending.split("\n"); pending = lines.pop() ?? "";
      for (const line of lines) event(line);
      if (done) { event(pending); break; }
    }
    signal.throwIfAborted();
    if (!result) throw new Error("The connection ended early. Try again.");
    return result;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const post = (path: string, expectedUserId: string, body: unknown, signal: AbortSignal) => apiFetch(path, { method: "POST", credentials: "same-origin", signal,
  headers: { "Content-Type": "application/json", Accept: "application/x-ndjson", "X-Margin-Vault-User": expectedUserId }, body: JSON.stringify(body) });

export async function requestRepoGraph(args: { url: string; expectedUserId: string; signal: AbortSignal; onProgress: (message: string) => void }): Promise<RepoGraph> {
  const response = await post("/api/graph/repo", args.expectedUserId, { url: args.url }, args.signal);
  return readStream(response, "graph", args.signal, args.onProgress, isRepoGraph, 6_000_000);
}

export type ExplainTarget = { kind: "symbol" | "file" | "folder" | "repo"; path: string; name?: string };
export interface Explanation { markdown: string; model: string | null }
const isExplanation = (value: unknown): value is Explanation => Boolean(value && typeof (value as Explanation).markdown === "string");

export async function requestExplanation(args: RepoAIOptions & { repo: string; target: ExplainTarget; style: "note" | "document"; code: string; context: string; question?: string;
  expectedUserId: string; signal: AbortSignal; onProgress: (message: string) => void }): Promise<Explanation> {
  const { expectedUserId, signal, onProgress, ...payload } = args;
  const response = await post("/api/graph/repo/explain", expectedUserId, payload, signal);
  return readStream(response, "explanation", signal, onProgress, isExplanation, 200_000);
}

/** The file's text at the mapped commit, from GitHub's raw file host. */
export const rawFileUrl = (graph: RepoGraph, path: string) =>
  `https://raw.githubusercontent.com/${graph.repo.owner}/${graph.repo.name}/${graph.repo.commit ?? graph.repo.ref ?? "HEAD"}/${path.split("/").map(encodeURIComponent).join("/")}`;
export const githubUrl = (graph: RepoGraph, path: string, lines?: { line: number; end: number }, folder = false) =>
  `${graph.repo.url}/${path && !folder ? "blob" : "tree"}/${graph.repo.commit ?? graph.repo.ref ?? "HEAD"}${path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : ""}${lines ? `#L${lines.line}-L${lines.end}` : ""}`;

export const repoLabel = (graph: RepoGraph) => `${graph.repo.owner}/${graph.repo.name}${graph.repo.folder ? `/${graph.repo.folder}` : ""}`;
export const repoKey = (graph: Pick<RepoGraph, "repo">) => `${graph.repo.owner}/${graph.repo.name}`.toLowerCase();

/* ---------- Levels: what the map shows at one place in the tree. ---------- */

/** A card: a folder, a file or a symbol. Ids are `d:path`, `f:path` and `s:path#name`. */
export interface RepoNode {
  id: string;
  kind: "folder" | "file" | "symbol";
  label: string;
  path: string;
  detail: string;
  /** For a file or folder, how much code it holds; drives card emphasis. */
  lines: number;
  symbol?: RepoSymbol;
  language?: string | null;
  /** A neighbour file shown in a file's view, on the left (imports it) or right (it imports). */
  role?: "imports" | "importedBy";
}
export interface RepoEdge { from: string; to: string; weight: number }
export interface RepoLevel { nodes: RepoNode[]; edges: RepoEdge[]; center?: string }

export const folderId = (path: string) => `d:${path}`;
export const fileId = (path: string) => `f:${path}`;
export const symbolId = (path: string, name: string) => `s:${path}#${name}`;

export interface RepoIndex {
  graph: RepoGraph;
  byPath: Map<string, number>;
  /** Folder to its direct subfolders and files. */
  folders: Map<string, { folders: string[]; files: number[]; lines: number; fileCount: number }>;
  importedBy: Map<number, number[]>;
  /** A file's imports, as file indices (a Go folder import counts as each file in it). */
  importsOf: Map<number, number[]>;
  root: string;
}

const parentOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;
const formatLines = (lines: number) => lines >= 1000 ? `${(lines / 1000).toFixed(lines >= 10_000 ? 0 : 1)}k lines` : `${lines} ${lines === 1 ? "line" : "lines"}`;

export function indexRepo(graph: RepoGraph): RepoIndex {
  const byPath = new Map(graph.files.map((file, index) => [file.path, index]));
  const folders: RepoIndex["folders"] = new Map();
  const folder = (path: string) => {
    let entry = folders.get(path);
    if (!entry) {
      entry = { folders: [], files: [], lines: 0, fileCount: 0 };
      folders.set(path, entry);
      if (path) { const parent = folder(parentOf(path)); parent.folders.push(path); }
    }
    return entry;
  };
  folder("");
  graph.files.forEach((file, index) => {
    folder(parentOf(file.path)).files.push(index);
    for (let path = parentOf(file.path); ; path = parentOf(path)) {
      const entry = folder(path); entry.lines += file.lines; entry.fileCount += 1;
      if (!path) break;
    }
  });
  const importsOf = new Map<number, number[]>(), importedBy = new Map<number, number[]>();
  graph.files.forEach((file, index) => {
    const targets = new Set<number>();
    for (const target of file.imports) {
      const direct = byPath.get(target);
      if (direct !== undefined) targets.add(direct);
      else folders.get(target)?.files.forEach((other) => targets.add(other));
    }
    targets.delete(index);
    importsOf.set(index, [...targets]);
    for (const target of targets) importedBy.set(target, [...importedBy.get(target) ?? [], index]);
  });
  // Start below folders that only hold one folder, like `src` in a repo with nothing else.
  let root = graph.repo.folder && folders.has(graph.repo.folder) ? graph.repo.folder : "";
  while (folders.get(root)!.files.length === 0 && folders.get(root)!.folders.length === 1) root = folders.get(root)!.folders[0];
  return { graph, byPath, folders, importsOf, importedBy, root };
}

/** A folder's child, skipping folders that hold a single folder, so `a/b/c` shows as one card. */
function collapsedFolder(index: RepoIndex, path: string) {
  let current = path;
  while (true) {
    const entry = index.folders.get(current)!;
    if (entry.files.length || entry.folders.length !== 1) return current;
    current = entry.folders[0];
  }
}

export function folderNode(index: RepoIndex, path: string, relativeTo: string): RepoNode {
  const entry = index.folders.get(path)!;
  const label = relativeTo && path.startsWith(`${relativeTo}/`) ? path.slice(relativeTo.length + 1) : path || index.graph.repo.name;
  return { id: folderId(path), kind: "folder", label: `${label}/`, path, lines: entry.lines,
    detail: `${entry.fileCount} ${entry.fileCount === 1 ? "file" : "files"} · ${formatLines(entry.lines)}` };
}

export function fileNode(index: RepoIndex, fileIndex: number, role?: RepoNode["role"]): RepoNode {
  const file = index.graph.files[fileIndex];
  const functions = file.symbols.filter((symbol) => symbol.kind !== "type").length;
  return { id: fileId(file.path), kind: "file", label: baseName(file.path), path: file.path, lines: file.lines, language: file.language, role,
    detail: role ? parentOf(file.path) || "/" : `${formatLines(file.lines)}${functions ? ` · ${functions} ${functions === 1 ? "function" : "functions"}` : ""}` };
}

export function symbolNode(file: RepoFile, symbol: RepoSymbol): RepoNode {
  const length = symbol.end - symbol.line + 1;
  return { id: symbolId(file.path, symbol.name), kind: "symbol", label: symbol.name, path: file.path, symbol, lines: length, language: file.language,
    detail: `${symbol.kind}${symbol.exported ? " · exported" : ""} · ${formatLines(length)}${symbol.usedBy?.length ? ` · used in ${symbol.usedBy.length}` : ""}` };
}

/** The card under `path` that holds file `fileIndex`, among `nodes` of a folder level. */
function holderOf(index: RepoIndex, fileIndex: number, members: Map<string, string>, folder: string) {
  const path = index.graph.files[fileIndex].path;
  if (folder && !path.startsWith(`${folder}/`)) return null;
  const rest = folder ? path.slice(folder.length + 1) : path;
  if (!rest.includes("/")) return members.get(fileId(path)) ?? null;
  const head = folder ? `${folder}/${rest.slice(0, rest.indexOf("/"))}` : rest.slice(0, rest.indexOf("/"));
  return members.get(head) ?? null;
}

/**
 * One folder: its subfolders and files as cards, with a line wherever code
 * in one imports code in another, thicker for more imports.
 */
export function folderLevel(index: RepoIndex, folder: string): RepoLevel {
  const entry = index.folders.get(folder);
  if (!entry) return { nodes: [], edges: [] };
  const nodes: RepoNode[] = [];
  const members = new Map<string, string>(); // a direct child's path → card id
  for (const child of entry.folders) {
    const shown = collapsedFolder(index, child);
    const node = folderNode(index, shown, folder);
    nodes.push(node); members.set(child, node.id);
  }
  for (const file of entry.files) { const node = fileNode(index, file); nodes.push(node); members.set(node.id, node.id); }
  const weights = new Map<string, number>();
  const inside = (path: string) => !folder || path.startsWith(`${folder}/`);
  index.graph.files.forEach((file, from) => {
    if (!inside(file.path)) return;
    const source = holderOf(index, from, members, folder);
    if (!source) return;
    for (const to of index.importsOf.get(from) ?? []) {
      const target = holderOf(index, to, members, folder);
      if (!target || target === source) continue;
      const key = `${source}\n${target}`;
      weights.set(key, (weights.get(key) ?? 0) + 1);
    }
  });
  const edges = [...weights].map(([key, weight]) => { const [from, to] = key.split("\n"); return { from, to, weight }; });
  nodes.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) || b.lines - a.lines || a.label.localeCompare(b.label));
  return { nodes, edges };
}

/**
 * One file: the file in the middle, its functions and classes below, the
 * files it imports to the right and the files that import it to the left.
 */
export function fileLevel(index: RepoIndex, path: string): RepoLevel {
  const position = index.byPath.get(path);
  if (position === undefined) return { nodes: [], edges: [] };
  const file = index.graph.files[position];
  const center = fileNode(index, position);
  const symbols = file.symbols.map((symbol) => symbolNode(file, symbol));
  const imports = (index.importsOf.get(position) ?? []).slice(0, 24).map((other) => fileNode(index, other, "imports"));
  const importedBy = (index.importedBy.get(position) ?? []).slice(0, 24).map((other) => fileNode(index, other, "importedBy"));
  const edges: RepoEdge[] = [
    ...symbols.filter((node) => node.symbol?.kind !== "method").map((node) => ({ from: center.id, to: node.id, weight: 1 })),
    ...imports.map((node) => ({ from: center.id, to: node.id, weight: 1 })),
    ...importedBy.map((node) => ({ from: node.id, to: center.id, weight: 1 })),
  ];
  // A method hangs off its class.
  for (const node of symbols) {
    if (node.symbol?.kind !== "method") continue;
    const owner = symbols.find((other) => other.symbol?.kind === "class" && node.symbol!.name.startsWith(`${other.symbol.name}.`));
    edges.push({ from: owner?.id ?? center.id, to: node.id, weight: 1 });
  }
  return { nodes: [center, ...symbols, ...imports, ...importedBy], edges, center: center.id };
}

/* ---------- Layout ---------- */

export const REPO_CARD = { width: 196, height: 58 };
export interface RepoBox { x: number; y: number; width: number; height: number }
const GAP = { x: 90, y: 16 };

/**
 * Architecture columns: code that is used sits to the right of the code that
 * uses it, so a folder reads left to right from entry points to foundations.
 * Cycles are broken by visiting order, so the layout is the same every time.
 */
export function layoutFolderLevel(level: RepoLevel): Map<string, RepoBox> {
  const ids = level.nodes.map((node) => node.id);
  const out = new Map<string, string[]>();
  for (const edge of level.edges) out.set(edge.from, [...out.get(edge.from) ?? [], edge.to]);
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    if (rank.has(id)) return rank.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    // Foundations, which import nothing here, are 0; anything else is one past its deepest dependency.
    const depth = Math.max(-1, ...(out.get(id) ?? []).map(depthOf)) + 1;
    visiting.delete(id);
    rank.set(id, depth);
    return depth;
  };
  ids.forEach(depthOf);
  const maxRank = Math.max(0, ...rank.values());
  const columns = new Map<number, string[]>();
  for (const id of ids) { const column = maxRank - rank.get(id)!; columns.set(column, [...columns.get(column) ?? [], id]); }
  // Very tall columns wrap into extra columns so the map stays roughly screen-shaped.
  const perColumn = Math.max(6, Math.ceil(Math.sqrt(ids.length * 1.6)));
  const boxes = new Map<string, RepoBox>();
  let x = 0;
  for (const column of [...columns.keys()].sort((a, b) => a - b)) {
    const members = columns.get(column)!;
    for (let start = 0; start < members.length; start += perColumn) {
      const slice = members.slice(start, start + perColumn);
      const height = slice.length * (REPO_CARD.height + GAP.y) - GAP.y;
      slice.forEach((id, row) => boxes.set(id, { x, y: row * (REPO_CARD.height + GAP.y) - height / 2, ...REPO_CARD }));
      x += REPO_CARD.width + (start + perColumn < members.length ? 24 : GAP.x);
    }
  }
  return boxes;
}

/** A file's view: the file centred, importers on the left, imports on the right, its code below. */
export function layoutFileLevel(level: RepoLevel): Map<string, RepoBox> {
  const boxes = new Map<string, RepoBox>();
  const center = level.nodes.find((node) => node.id === level.center);
  if (!center) return boxes;
  boxes.set(center.id, { x: -REPO_CARD.width / 2, y: -REPO_CARD.height / 2, ...REPO_CARD });
  const side = (nodes: RepoNode[], x: number) => {
    const height = nodes.length * (REPO_CARD.height + GAP.y) - GAP.y;
    nodes.forEach((node, row) => boxes.set(node.id, { x, y: row * (REPO_CARD.height + GAP.y) - height / 2, ...REPO_CARD }));
  };
  const symbols = level.nodes.filter((node) => node.kind === "symbol");
  const perRow = Math.max(3, Math.min(6, Math.ceil(Math.sqrt(symbols.length * 1.5))));
  const rowWidth = perRow * (REPO_CARD.width + 14) - 14;
  side(level.nodes.filter((node) => node.role === "importedBy"), -rowWidth / 2 - REPO_CARD.width - GAP.x);
  side(level.nodes.filter((node) => node.role === "imports"), rowWidth / 2 + GAP.x);
  symbols.forEach((node, position) => {
    const row = Math.floor(position / perRow), inRow = Math.min(perRow, symbols.length - row * perRow);
    const width = inRow * (REPO_CARD.width + 14) - 14;
    boxes.set(node.id, { x: -width / 2 + (position % perRow) * (REPO_CARD.width + 14), y: REPO_CARD.height + 70 + row * (REPO_CARD.height + 14), ...REPO_CARD });
  });
  return boxes;
}

/* ---------- What AI is given ---------- */

/** Lines `line`–`end` of `text` (1-based, inclusive). */
export const sliceLines = (text: string, line: number, end: number) => text.split(/\r?\n/u).slice(line - 1, end).join("\n");

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}\n… (cut)` : text;

/** What a function's explanation is told about its surroundings. */
export function symbolContext(index: RepoIndex, path: string, symbol: RepoSymbol) {
  const position = index.byPath.get(path)!;
  const file = index.graph.files[position];
  const others = file.symbols.filter((other) => other !== symbol).slice(0, 40).map((other) => `- ${other.kind} ${other.signature ?? other.name} (lines ${other.line}–${other.end})`);
  const used = (symbol.usedBy ?? []).map((other) => `- ${index.graph.files[other]?.path}`);
  const imports = (index.importsOf.get(position) ?? []).map((other) => `- ${index.graph.files[other].path}`);
  return clip([
    `File: ${path} (${file.language ?? "text"}, ${file.lines} lines). This ${symbol.kind} is lines ${symbol.line}–${symbol.end}.`,
    imports.length ? `The file imports:\n${imports.join("\n")}` : "",
    file.external?.length ? `Packages it uses: ${file.external.join(", ")}` : "",
    others.length ? `Other definitions in the file:\n${others.join("\n")}` : "",
    used.length ? `Files that import this file and mention ${symbol.name}:\n${used.join("\n")}` : "",
  ].filter(Boolean).join("\n\n"), 15_000);
}

export function fileContext(index: RepoIndex, path: string) {
  const position = index.byPath.get(path)!;
  const file = index.graph.files[position];
  const list = (positions: number[] | undefined) => (positions ?? []).slice(0, 40).map((other) => `- ${index.graph.files[other].path}`).join("\n");
  return clip([
    `File: ${path} (${file.language ?? "text"}, ${file.lines} lines) in ${repoLabel(index.graph)}.`,
    index.importsOf.get(position)?.length ? `It imports:\n${list(index.importsOf.get(position))}` : "",
    index.importedBy.get(position)?.length ? `Imported by:\n${list(index.importedBy.get(position))}` : "",
    file.external?.length ? `Packages it uses: ${file.external.join(", ")}` : "",
  ].filter(Boolean).join("\n\n"), 15_000);
}

/**
 * A folder or the whole repository, for an architecture overview: the
 * folder tree with sizes, the main definitions of each file, which parts
 * import which, and the README.
 */
export function folderOutline(index: RepoIndex, folder: string) {
  const lines: string[] = [];
  const walk = (path: string, depth: number) => {
    if (lines.length > 260) return;
    const entry = index.folders.get(path)!;
    if (path !== folder) lines.push(`${"  ".repeat(depth - 1)}${baseName(path)}/ (${entry.fileCount} files, ${entry.lines} lines)`);
    if (depth > 3) return;
    for (const child of entry.folders) walk(child, depth + 1);
    for (const file of entry.files.slice(0, depth > 2 ? 6 : 30)) {
      const item = index.graph.files[file];
      const names = item.symbols.filter((symbol) => symbol.exported && symbol.kind !== "method").slice(0, 6).map((symbol) => symbol.name);
      lines.push(`${"  ".repeat(depth)}${baseName(item.path)} (${item.lines} lines)${names.length ? `: ${names.join(", ")}` : ""}`);
    }
  };
  walk(folder, 0);
  const level = folderLevel(index, folder);
  const labels = new Map(level.nodes.map((node) => [node.id, node.label]));
  const links = level.edges.sort((a, b) => b.weight - a.weight).slice(0, 40).map((edge) => `- ${labels.get(edge.from)} → ${labels.get(edge.to)} (${edge.weight} imports)`);
  const packages = new Map<string, number>();
  for (const file of index.graph.files) if (!folder || file.path.startsWith(`${folder}/`)) for (const name of file.external ?? []) packages.set(name, (packages.get(name) ?? 0) + 1);
  const topPackages = [...packages].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([name]) => name);
  return clip([
    `${folder ? `Folder ${folder} of` : "Repository"} ${repoLabel(index.graph)}.`,
    `Tree:\n${lines.join("\n")}`,
    links.length ? `Imports between its parts:\n${links.join("\n")}` : "",
    topPackages.length ? `Packages used most: ${topPackages.join(", ")}` : "",
    !folder && index.graph.readme ? `README (start):\n${index.graph.readme.slice(0, 3500)}` : "",
  ].filter(Boolean).join("\n\n"), 15_500);
}

/* ---------- Saved per device: recent repositories and AI notes. ---------- */

export interface RepoNote { id: string; target: ExplainTarget; markdown: string; question: string; createdAt: string; style: "note" | "document" }
export interface RepoExplorerMemory { recent: Array<{ url: string; label: string; openedAt: string }>; notes: Record<string, RepoNote[]> }
export const REPO_EXPLORER_KEY = "margin-repo-explorer";

export function readRepoMemory(storage: Pick<Storage, "getItem"> | undefined): RepoExplorerMemory {
  try {
    const value = JSON.parse(storage?.getItem(REPO_EXPLORER_KEY) ?? "null");
    if (value && Array.isArray(value.recent) && value.notes && typeof value.notes === "object") return value;
  } catch { /* Falls back to empty. */ }
  return { recent: [], notes: {} };
}

export function rememberRepo(memory: RepoExplorerMemory, url: string, label: string, openedAt: string): RepoExplorerMemory {
  return { ...memory, recent: [{ url, label, openedAt }, ...memory.recent.filter((item) => item.label.toLowerCase() !== label.toLowerCase())].slice(0, 6) };
}

/** Notes per repository, newest last; old repositories' notes drop off to keep storage small. */
export function addRepoNote(memory: RepoExplorerMemory, repo: string, note: RepoNote): RepoExplorerMemory {
  const notes = { ...memory.notes, [repo]: [...(memory.notes[repo] ?? []), note].slice(-60) };
  const keep = new Set([repo, ...memory.recent.map((item) => item.label.split("/").slice(0, 2).join("/").toLowerCase())]);
  return { ...memory, notes: Object.fromEntries(Object.entries(notes).filter(([key]) => keep.has(key))) };
}

export const targetNodeId = (target: ExplainTarget) => target.kind === "symbol" ? symbolId(target.path, target.name ?? "") : target.kind === "file" ? fileId(target.path) : folderId(target.path);

/** A saved explanation as a vault note, with the code it explains. */
export function noteDocument(graph: RepoGraph, note: Pick<RepoNote, "target" | "markdown" | "question">, code: string, language: string | null) {
  const name = note.target.kind === "repo" ? repoLabel(graph) : note.target.name || note.target.path;
  const where = note.target.kind === "repo" ? graph.repo.url : githubUrl(graph, note.target.path);
  return {
    title: `${name} — explained`.slice(0, 100),
    content: [
      `Source: <${where}>`,
      `From ${repoLabel(graph)}${graph.repo.commit ? ` at ${graph.repo.commit.slice(0, 7)}` : ""}. AI explanation; check the code before relying on it.`,
      note.question ? `**Question:** ${note.question}` : "",
      note.markdown,
      code ? `## Code\n\n\`\`\`${language ?? ""}\n${code.replace(/```/gu, "`​``")}\n\`\`\`` : "",
    ].filter(Boolean).join("\n\n"),
  };
}
