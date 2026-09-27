import type { DocumentBlock, DocumentBlockAuthorship, EditableDocument, Message } from "./types.mjs";
/** Resolve block-level authorship, including legacy blocks with an assistant source. */
export function getDocumentBlockAuthorship(block: Pick<DocumentBlock, "authorship" | "generationId" | "sourceMessageId">, messages?: ReadonlyArray<Pick<Message, "id" | "role">>): DocumentBlockAuthorship;
/** Returns undefined for invalid documents, without truncating or dropping authored text. */
export function normalizeEditableDocument(input: unknown): EditableDocument | undefined;
