import type { DocumentBlock } from "@margin-chat/workspace-contracts";

/** Selection offsets refer to the block's saved Markdown, including its syntax. */
export interface DocumentEditFocus {
  blockId: string;
  from: number;
  to: number;
}

export interface DocumentEditOptions {
  group?: string;
  beforeFocus?: DocumentEditFocus;
  afterFocus?: DocumentEditFocus;
}

interface Edit {
  before: DocumentBlock[];
  after: DocumentBlock[];
  beforeFocus?: DocumentEditFocus;
  afterFocus?: DocumentEditFocus;
}

export interface DocumentEditResult {
  blocks: DocumentBlock[];
  focus?: DocumentEditFocus;
}

const HISTORY_LIMIT = 100;
const GROUP_DELAY = 500;
const copyBlocks = (blocks: DocumentBlock[]) => blocks.map((block) => ({ ...block }));
const copyFocus = (focus?: DocumentEditFocus) => focus ? { ...focus } : undefined;
const continuousFocus = (previous?: DocumentEditFocus, next?: DocumentEditFocus) => !previous || !next
  || previous.blockId === next.blockId && previous.from === next.from && previous.to === next.to;

function equalBlocks(first: DocumentBlock[], second: DocumentBlock[]) {
  return first.length === second.length && first.every((block, index) => {
    const other = second[index];
    return block.id === other.id && block.kind === other.kind && block.content === other.content
      && block.createdAt === other.createdAt && block.sourceMessageId === other.sourceMessageId
      && block.generationId === other.generationId;
  });
}

/** One chronological history for a document's independently mounted block editors. */
export class DocumentEditHistory {
  private current: DocumentBlock[];
  private past: Edit[] = [];
  private future: Edit[] = [];
  private group: { key: string; time: number } | undefined;

  constructor(blocks: DocumentBlock[]) {
    this.current = copyBlocks(blocks);
  }

  sync(blocks: DocumentBlock[]): void {
    // AI output, transfers, and other external edits must never be overwritten
    // by an older local snapshot. Timestamp-only refreshes retain the history.
    if (!equalBlocks(this.current, blocks)) {
      this.past = [];
      this.future = [];
      this.group = undefined;
    }
    this.current = copyBlocks(blocks);
  }

  record(before: DocumentBlock[], after: DocumentBlock[], options: DocumentEditOptions = {}, now = Date.now()): boolean {
    this.sync(before);
    if (equalBlocks(before, after)) return false;
    const previous = this.past.at(-1);
    if (previous && options.group && this.group?.key === options.group
      && now >= this.group.time && now - this.group.time <= GROUP_DELAY
      && continuousFocus(previous.afterFocus, options.beforeFocus)) {
      previous.after = copyBlocks(after);
      previous.afterFocus = copyFocus(options.afterFocus);
    } else {
      this.past.push({ before: copyBlocks(before), after: copyBlocks(after),
        beforeFocus: copyFocus(options.beforeFocus), afterFocus: copyFocus(options.afterFocus) });
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
    }
    this.future = [];
    this.current = copyBlocks(after);
    this.group = options.group ? { key: options.group, time: now } : undefined;
    return true;
  }

  undo(currentBlocks: DocumentBlock[]): DocumentEditResult | null {
    this.sync(currentBlocks);
    this.group = undefined;
    const edit = this.past.pop();
    if (!edit) return null;
    this.future.push(edit);
    this.current = copyBlocks(edit.before);
    return { blocks: copyBlocks(edit.before), focus: copyFocus(edit.beforeFocus) };
  }

  redo(currentBlocks: DocumentBlock[]): DocumentEditResult | null {
    this.sync(currentBlocks);
    this.group = undefined;
    const edit = this.future.pop();
    if (!edit) return null;
    this.past.push(edit);
    this.current = copyBlocks(edit.after);
    return { blocks: copyBlocks(edit.after), focus: copyFocus(edit.afterFocus) };
  }
}
