import type { AppState, Conversation, DocumentGeneration, DocumentInsertion } from "@margin-chat/workspace-contracts";
import { remapDocumentAnchor, type DocumentAnchorRange } from "./documentAnchors";
import { getDocumentSourceText, getEditableDocument, remapDocumentRange } from "./editableDocument";
import { remapDocumentReplacement } from "./documentVersions";
import { createMarkdownWorkspace, parseMarkdownWorkspace } from "./workspaceMarkdown";
import { workspaceFromVault } from "./vaultWorkspace";
import type { VaultFile } from "./vaultTypes";

type Files = Record<string, VaultFile>;
type Origin<T> = { value: T; source: Conversation };
const rangeKey = (anchor: DocumentAnchorRange) => JSON.stringify([
  anchor.sourceMessageId, anchor.sourceBlockId ?? null, anchor.startOffset, anchor.endOffset, anchor.quote,
]);
const positionKey = (value: unknown) => JSON.stringify(value);

function occurrences(content: string | undefined, quote: string): number {
  if (!content || !quote) return 0;
  let count = 0;
  for (let offset = content.indexOf(quote); offset !== -1; offset = content.indexOf(quote, offset + 1)) count += 1;
  return count;
}

function missingBlockId(prefix: string, id: string, conversation?: Conversation): string {
  const ids = new Set(conversation ? getEditableDocument(conversation).blocks.map((block) => block.id) : []);
  const base = `${prefix}:${id.slice(0, 900)}`;
  let result = base;
  for (let index = 2; ids.has(result); index += 1) result = `${base}:${index}`;
  return result;
}

function detached<T extends DocumentAnchorRange>(anchor: T, id: string, after?: Conversation): T {
  if (anchor.sourceBlockId?.startsWith("detached:")) return anchor;
  return { ...anchor, sourceBlockId: missingBlockId("detached", anchor.sourceBlockId ?? id, after) };
}

/** Prefer the ancestor when metadata is unchanged: external editors can move the
 * text without updating any anchor offsets. Otherwise require agreeing origins. */
function selectOrigins<T>(selected: T, origins: Array<Origin<T> | undefined>, key: (value: T) => string): Origin<T>[] {
  if (origins[0] && key(origins[0].value) === key(selected)) return [origins[0]];
  return origins.slice(1).filter((origin): origin is Origin<T> => Boolean(origin && key(origin.value) === key(selected)));
}

function remapAnchor<T extends DocumentAnchorRange>(anchor: T, id: string, origins: Array<Origin<T> | undefined>,
  sources: Array<Conversation | undefined>, after?: Conversation): T {
  if (!anchor.sourceMessageId || anchor.startOffset === null || anchor.endOffset === null
    || anchor.sourceBlockId?.startsWith("detached:")) return anchor;
  if (!after) return sources.some(Boolean) ? detached(anchor, id) : anchor;
  const sourceText = (source: Conversation) => getDocumentSourceText(source, anchor.sourceMessageId!, anchor.sourceBlockId);
  // A metadata-only merge must not rewrite otherwise unchanged references.
  if (sources.filter((source): source is Conversation => Boolean(source)).every((source) => sourceText(source) === sourceText(after))) return anchor;
  const chosen = selectOrigins(anchor, origins, rangeKey);
  if (!chosen.length) {
    // Repeating this pass over a result already rebased must be a no-op.
    if (origins.some((origin) => origin && rangeKey(remapDocumentAnchor(origin.value, origin.source, after)) === rangeKey(anchor))) return anchor;
    return detached(anchor, id, after);
  }
  if (!anchor.sourceBlockId && anchor.quote && chosen.some((origin) => {
    const beforeCount = occurrences(sourceText(origin.source), anchor.quote!);
    return beforeCount > 1 && occurrences(sourceText(after), anchor.quote!) < beforeCount;
  })) return detached(anchor, id, after);
  const mapped = chosen.map((origin) => remapDocumentAnchor(anchor, origin.source, after));
  if (!mapped.every((value) => rangeKey(value) === rangeKey(mapped[0]))) return detached(anchor, id, after);
  const candidate = mapped[0];
  // The shared helper retains ambiguous legacy message references as history.
  // Give them a detached block identity too so readers cannot borrow another quote.
  const content = getDocumentSourceText(after, candidate.sourceMessageId!, candidate.sourceBlockId);
  if (!candidate.sourceBlockId && (!candidate.quote || content?.slice(candidate.startOffset!, candidate.endOffset!) !== candidate.quote)) {
    return detached(candidate, id, after);
  }
  return rangeKey(candidate) === rangeKey(anchor) ? anchor : candidate;
}

function remapGeneration(generation: DocumentGeneration, origins: Array<Origin<DocumentGeneration> | undefined>, after: Conversation): DocumentGeneration {
  const afterBlocks = getEditableDocument(after).blocks;
  let result = generation;
  const replacement = generation.replacement;
  if (replacement && afterBlocks.some((block) => block.id === replacement.blockId)) {
    const matches = selectOrigins(generation, origins, (value) => positionKey(value.replacement));
    const mapped = matches.map((origin) => remapDocumentReplacement(generation, getEditableDocument(origin.source).blocks, afterBlocks).replacement!);
    const unchanged = origins.filter(Boolean).every((origin) =>
      getEditableDocument(origin!.source).blocks.find((block) => block.id === replacement.blockId)?.content
      === afterBlocks.find((block) => block.id === replacement.blockId)?.content);
    if (!unchanged) {
      const alreadyMapped = !mapped.length && origins.some((origin) => origin
        && positionKey(remapDocumentReplacement(origin.value, getEditableDocument(origin.source).blocks, afterBlocks).replacement) === positionKey(replacement));
      if (!alreadyMapped) {
        let selected = mapped.length && mapped.every((value) => positionKey(value) === positionKey(mapped[0])) ? mapped[0]
          : { ...replacement, blockId: missingBlockId("restore", generation.id, after), offset: 0 };
        if (selected.blockId !== replacement.blockId && afterBlocks.some((block) => block.id === selected.blockId)) {
          selected = { ...selected, blockId: missingBlockId("restore", generation.id, after) };
        }
        result = { ...result, replacement: selected };
      }
    }
  }
  const insertion = generation.insertion;
  // Accepted insertions and prompt selections describe history; only a pending
  // candidate's insertion can still replace current text.
  if (!insertion?.blockId || generation.acceptedAt || !afterBlocks.some((block) => block.id === insertion.blockId)) return result;
  const currentInsertion: DocumentInsertion = insertion;
  const afterBlock = afterBlocks.find((block) => block.id === insertion.blockId)!;
  const matches = selectOrigins(generation, origins, (value) => positionKey(value.insertion));
  function rebase(origin: Origin<DocumentGeneration>, selected: DocumentInsertion = currentInsertion): DocumentInsertion | null {
    const beforeBlock = getEditableDocument(origin.source).blocks.find((block) => block.id === selected.blockId);
    if (!beforeBlock) return null;
    if (beforeBlock.content === afterBlock.content) return selected;
    const end = selected.replaceTo ?? selected.offset;
    if (end > selected.offset) {
      const quote = beforeBlock.content.slice(selected.offset, end);
      const anchor = remapDocumentAnchor({ sourceMessageId: beforeBlock.sourceMessageId ?? `document:${beforeBlock.id}`,
        sourceBlockId: beforeBlock.id, startOffset: selected.offset, endOffset: end, quote }, origin.source, after);
      if (anchor.sourceBlockId?.startsWith("detached:") || anchor.startOffset === null || anchor.endOffset === null) return null;
      return { ...selected, blockId: anchor.sourceBlockId!, offset: anchor.startOffset, replaceTo: anchor.endOffset };
    }
    const range = remapDocumentRange(beforeBlock.content, afterBlock.content, selected.offset, end);
    return range ? { ...selected, offset: range.from, ...(selected.replaceTo !== undefined ? { replaceTo: range.to } : {}) } : null;
  }
  const mapped = matches.map((origin) => rebase(origin));
  if (!matches.length && origins.some((origin) => origin?.value.insertion
    && positionKey(rebase(origin, origin.value.insertion)) === positionKey(insertion))) return result;
  if (mapped.length && mapped[0] && mapped.every((value) => positionKey(value) === positionKey(mapped[0]))) {
    return positionKey(mapped[0]) === positionKey(insertion) ? result : { ...result, insertion: mapped[0] };
  }
  return { ...result, insertion: { ...insertion, blockId: missingBlockId("stale-insertion", generation.id, after) } };
}

/** Rebase only actionable metadata after a file merge, retaining raw Markdown
 * bytes through the shared codec. Incomplete inputs remain the caller's validation concern. */
export function remapVaultMergeAnchors(baseFiles: Files, localFiles: Files, remoteFiles: Files, mergedFiles: Files): Files {
  try {
    const workspaces = [baseFiles, localFiles, remoteFiles, mergedFiles].map((files) => workspaceFromVault(files));
    const states = workspaces.map((workspace) => parseMarkdownWorkspace(workspace.manifest, workspace.files));
    if (states.some((state) => !state)) return mergedFiles;
    const [base, local, remote, merged] = states as AppState[];
    const originals = [base, local, remote];
    const conversations = { ...merged.conversations };
    let changed = false;
    for (const [id, conversation] of Object.entries(merged.conversations)) {
      let next = conversation;
      const sourceOrigins = originals.map((state) => state.conversations[id]);
      function mapOwn<T extends DocumentAnchorRange>(anchor: T, anchorId: string, read: (source: Conversation) => T | undefined): T {
        const origins = sourceOrigins.map((source) => {
          const value = source && read(source);
          return source && value ? { value, source } : undefined;
        });
        return remapAnchor(anchor, anchorId, origins, sourceOrigins, conversation);
      }
      if (conversation.document?.links?.length) {
        const links = conversation.document.links.map((link) => mapOwn(link, link.id,
          (source) => source.document?.links?.find((value) => value.id === link.id)));
        if (links.some((link, index) => link !== conversation.document!.links![index])) next = { ...next, document: { ...next.document!, links } };
      }
      if (conversation.notes?.length) {
        const notes = conversation.notes.map((note) => mapOwn(note, note.id, (source) => source.notes?.find((value) => value.id === note.id)));
        if (notes.some((note, index) => note !== conversation.notes![index])) next = { ...next, notes };
      }
      if (conversation.branchAnchor) {
        const anchor = conversation.branchAnchor;
        const sources = originals.map((state) => state.conversations[anchor.sourceConversationId]);
        const origins = originals.map((state, index) => {
          const value = state.conversations[id]?.branchAnchor;
          const source = sources[index];
          return value && value.sourceConversationId === anchor.sourceConversationId && source ? { value, source } : undefined;
        });
        const mapped = remapAnchor(anchor, anchor.id, origins, sources, merged.conversations[anchor.sourceConversationId]);
        if (mapped !== anchor) next = { ...next, branchAnchor: mapped };
      }
      if (conversation.document?.generations.length) {
        const generations = conversation.document.generations.map((generation) => remapGeneration(generation,
          sourceOrigins.map((source) => {
            const value = source?.document?.generations.find((item) => item.id === generation.id);
            return source && value ? { value, source } : undefined;
          }), conversation));
        if (generations.some((value, index) => positionKey(value) !== positionKey(conversation.document!.generations[index]))) {
          next = { ...next, document: { ...next.document!, generations } };
        }
      }
      if (next !== conversation) { conversations[id] = next; changed = true; }
    }
    if (!changed) return mergedFiles;
    const rendered = createMarkdownWorkspace({ ...merged, conversations }, workspaces[3].manifest.savedAt, workspaces[3], { preservePaths: true });
    const result = { ...mergedFiles };
    for (const [path, content] of Object.entries(rendered.files)) {
      if (mergedFiles[path] && content !== mergedFiles[path].content) result[path] = { ...mergedFiles[path], content };
    }
    return result;
  } catch { return mergedFiles; }
}
