/** Writes version-5 provenance wrappers and header history while preserving authored Markdown. */
export function encodeReadableMarkdown(source: string): string;
/** Reads legacy, version-4, and version-5 files into internal markers; malformed boundaries throw. */
export function decodeReadableMarkdown(source: string): string;
/** True only for the reserved top-level frontmatter field, never a mention in authored body text. */
export function isReadableMarkdown(source: string): boolean;
