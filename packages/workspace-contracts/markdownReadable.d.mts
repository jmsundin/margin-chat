/**
 * Writes provenance wrappers (one per run of lines by the same author) and header history while
 * preserving authored Markdown. Lines in `referencedBlockIds` get Obsidian block IDs (`^id`).
 */
export function encodeReadableMarkdown(source: string, options?: { referencedBlockIds?: ReadonlySet<string> }): string;
/** Reads legacy and version-4 to version-6 files into internal markers; malformed boundaries throw. */
export function decodeReadableMarkdown(source: string): string;
/** True only for the reserved top-level frontmatter field, never a mention in authored body text. */
export function isReadableMarkdown(source: string): boolean;
/** IDs of the lines a readable file already marks with Obsidian block IDs (`^id`). */
export function markedBlockIds(source: string): Set<string>;
