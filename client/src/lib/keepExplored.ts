import type { AppState } from "../types";
import { addMapChildNote, createMapNote, setPersonalMapConnection } from "./graphWorkspaceEdits";
import { connectPublicTopics, findSavedPublicTopic, savePublicTopic } from "./publicTopicWorkspace";
import { saveUrlMapNode, urlMapConversationId, type UrlMapNode } from "./urlMap";
import type { ExploredItem, MapExploration } from "./mapExploration";

/**
 * The previews to keep, with the preview parents that lead to them, parents
 * first. Keeping a preview brings along the chain that connects it to the map.
 */
export function keepOrder(exploration: MapExploration, ids: Iterable<string>): ExploredItem[] {
  const ordered: ExploredItem[] = [];
  const added = new Set<string>();
  const visit = (id: string, path: Set<string>) => {
    const item = exploration.items[id];
    if (!item || added.has(id) || path.has(id)) return;
    path.add(id);
    if (item.parent?.kind === "item") visit(item.parent.id, path);
    added.add(id);
    ordered.push(item);
  };
  for (const id of ids) visit(id, new Set());
  return ordered;
}

/** The workspace document an explored item already became, if any. */
export function savedConversationFor(state: Pick<AppState, "conversations">, item: ExploredItem): string | null {
  if (item.source.kind === "topic") return findSavedPublicTopic(state.conversations, item.source.topic)?.id ?? null;
  if (item.source.kind === "page") {
    const id = urlMapConversationId({ id: item.source.nodeId } as UrlMapNode);
    return state.conversations[id] ? id : null;
  }
  return null;
}

export const answerNoteContent = (question: string, answer: string) =>
  `> AI answer to “${question.replace(/\s+/g, " ")}”. Review before relying on it.\n\n${answer}`;

/**
 * Puts explored items into the workspace as notes, each connected to the
 * document or kept preview it hangs off. Returns the new state and the note
 * each item became. Applying it twice to the same state gives the same notes.
 */
export function keepExploredItems(state: AppState, exploration: MapExploration, ids: Iterable<string>, options: {
  createdAt: string;
  /** Identities for notes made from AI answers. */
  newNote(itemId: string): { id: string; noteId: string };
  /** Items kept on their own, without connecting them to the document they came from. */
  detached?: Iterable<string>;
}): { state: AppState; kept: Record<string, string> } {
  const kept: Record<string, string> = {};
  const detached = new Set(options.detached);
  let next = state;
  for (const item of keepOrder(exploration, ids)) {
    const parentId = detached.has(item.id) ? null
      : item.parent?.kind === "document" ? (next.conversations[item.parent.id] ? item.parent.id : null)
      : item.parent?.kind === "item" ? kept[item.parent.id] ?? savedConversationForParent(next, exploration, item.parent.id) : null;
    const fromAnswer = item.parent?.kind === "item" && exploration.items[item.parent.id]?.source.kind === "answer";
    const source = item.source;
    if (source.kind === "topic") {
      if (parentId) {
        next = connectPublicTopics(next, parentId, [{ topic: source.topic, kind: item.connection?.kind ?? "related", note: item.connection?.label }],
          { createdAt: options.createdAt, origin: fromAnswer ? "ai" : "import" }).state;
      } else {
        try { next = savePublicTopic(next, source.topic).state; } catch { continue; }
      }
      const id = findSavedPublicTopic(next.conversations, source.topic)?.id;
      if (id) kept[item.id] = id;
    } else if (source.kind === "page") {
      const graph = exploration.pages[source.url];
      const node = graph?.nodes.find((candidate) => candidate.id === source.nodeId);
      if (!graph || !node) continue;
      next = saveUrlMapNode(next, graph, node.id);
      const id = urlMapConversationId(node);
      if (!next.conversations[id]) continue;
      if (parentId) next = setPersonalMapConnection(next, parentId, id, true, options.createdAt);
      kept[item.id] = id;
    } else {
      const { id, noteId } = options.newNote(item.id);
      if (next.conversations[id]) { kept[item.id] = id; continue; }
      const note = { id, noteId, createdAt: options.createdAt, title: source.answer.question.slice(0, 100), content: answerNoteContent(source.answer.question, source.answer.answer) };
      next = parentId ? addMapChildNote(next, { ...note, parentId, activate: false }) : createMapNote(next, note);
      if (next.conversations[id]) kept[item.id] = id;
    }
  }
  return { state: next, kept };
}

function savedConversationForParent(state: AppState, exploration: MapExploration, itemId: string) {
  const parent = exploration.items[itemId];
  return parent ? savedConversationFor(state, parent) : null;
}
