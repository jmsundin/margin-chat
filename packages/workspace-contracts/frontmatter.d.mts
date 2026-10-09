export interface FrontmatterEntry { key: string; start: number; end: number; raw: string }
export interface Frontmatter { start: number; end: number; after: number; text: string; newline: string; entries: FrontmatterEntry[] }
export type FrontmatterValue = null | boolean | number | string | FrontmatterValue[] | { [key: string]: FrontmatterValue };

export function readFrontmatter(source: string): Frontmatter | null;
export function frontmatterEntries(text: string, base?: number): FrontmatterEntry[];
export function frontmatterEntry(source: string, key: string): FrontmatterEntry | undefined;
export function readFrontmatterValue(source: string, key: string): FrontmatterValue | undefined;
export function readFrontmatterValues(source: string): Record<string, FrontmatterValue>;
export function parseFrontmatterEntryValue(raw: string): FrontmatterValue | undefined;
export function renderFrontmatterEntry(key: string, value: unknown): string;
export function setFrontmatterEntries(source: string, updates: Record<string, string | undefined>): string;
