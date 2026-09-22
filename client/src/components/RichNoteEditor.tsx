import { useEffect, useRef, useState } from "react";
import type { DocumentBlock } from "@margin-chat/workspace-contracts";
import RichDocumentEditor from "./RichDocumentEditor";

interface RichNoteEditorProps {
  ariaLabel: string;
  autoFocus?: boolean;
  className?: string;
  onBlur?: () => void;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}

function noteBlock(content: string): DocumentBlock {
  const now = new Date().toISOString();
  return { id: `note-block-${crypto.randomUUID()}`, kind: "markdown", content, createdAt: now, updatedAt: now };
}

/** A private note uses the same formatted editing, without any AI invocation or network action. */
export default function RichNoteEditor(props: RichNoteEditorProps) {
  const [blocks, setBlocks] = useState(() => [noteBlock(props.value)]);
  const latest = useRef(blocks);
  latest.current = blocks;
  const emitted = useRef(props.value);
  const container = useRef<HTMLDivElement>(null);
  const identity = useRef(`private-note-${crypto.randomUUID()}`);
  useEffect(() => {
    if (props.value === emitted.current) return;
    emitted.current = props.value;
    setBlocks((current) => [{ ...current[0], content: props.value }]);
  }, [props.value]);
  useEffect(() => {
    if (!props.autoFocus) return;
    const timer = window.setTimeout(() => container.current?.querySelector<HTMLElement>("[contenteditable='true']")?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [props.autoFocus]);
  function save(next: DocumentBlock[]) {
    const safe = next.length ? next : [noteBlock("")];
    latest.current = safe;
    setBlocks(safe);
    const markdown = safe.map((block) => block.content.replace(/\n+$/, "")).join("\n\n");
    emitted.current = markdown;
    props.onChange(markdown);
  }
  return <div className={`rich-note-editor ${props.className ?? ""}`} ref={container} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) props.onBlur?.(); }}>
    {!props.value.trim() && props.placeholder ? <p className="rich-note-placeholder">{props.placeholder}</p> : null}
    <RichDocumentEditor conversationId={identity.current} blocks={blocks} ariaLabel={props.ariaLabel}
      onUpdateBlock={(id, content) => save(latest.current.map((block) => block.id === id ? { ...block, content } : block))}
      onSplitBlock={(id, before, after) => { const next = noteBlock(after); save(latest.current.flatMap((block) => block.id === id ? [{ ...block, content: before }, next] : [block])); return next.id; }}
      onInsertBlock={(afterId, content) => { const next = noteBlock(content); const blocks = [...latest.current]; const index = blocks.findIndex((block) => block.id === afterId); blocks.splice(index < 0 ? blocks.length : index + 1, 0, next); save(blocks); return next.id; }}
      onDeleteBlock={(id) => save(latest.current.filter((block) => block.id !== id))}
      onReorderBlock={(id, beforeId) => { const block = latest.current.find((block) => block.id === id); if (!block || id === beforeId) return; const blocks = latest.current.filter((block) => block.id !== id); const index = blocks.findIndex((block) => block.id === beforeId); blocks.splice(index < 0 ? blocks.length : index, 0, block); save(blocks); }} />
  </div>;
}
