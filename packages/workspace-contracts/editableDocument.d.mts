import type { EditableDocument } from "./types.mjs";
/** Returns undefined for invalid documents, without truncating or dropping authored text. */
export function normalizeEditableDocument(input: unknown): EditableDocument | undefined;
