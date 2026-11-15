import { createContext } from "react";
import type { CodeCellSibling } from "./languages";

/**
 * What a rendered piece of Markdown needs to know to show its code blocks as
 * runnable cells: the cells of the whole document (SQL cells build on the ones
 * above them; CSS styles the HTML above it), where this piece's cells start
 * among them, and how to save an edit. Without a scope, cells run but can't
 * be edited, as in chat answers.
 */
export interface CodeCellScope {
  cells: ReadonlyArray<CodeCellSibling>;
  /** Index in `cells` of the first code block in this piece of Markdown. */
  offset: number;
  /** Saves the `index`-th code block of this piece; false when it changed elsewhere and was left alone. */
  save?: (index: number, previous: string, next: string) => boolean;
}

export const CodeCellScopeContext = createContext<CodeCellScope | null>(null);

/** Code mode's Run all: every cell of the document whose id is `detail.documentId` runs, in page order. */
export const RUN_ALL_CELLS_EVENT = "margin-chat:run-code-cells";
