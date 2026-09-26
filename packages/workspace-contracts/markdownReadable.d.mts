/** Moves legacy structured metadata into frontmatter while preserving authored Markdown. */
export function encodeReadableMarkdown(source: string): string;
/** Reconstructs legacy internal markers; malformed readable metadata throws without changing input. */
export function decodeReadableMarkdown(source: string): string;
/** True only for the reserved top-level frontmatter field, never a mention in authored body text. */
export function isReadableMarkdown(source: string): boolean;
