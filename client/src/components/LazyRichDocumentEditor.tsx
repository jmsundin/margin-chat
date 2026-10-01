import { lazy, Suspense } from "react";
import type { RichDocumentEditorProps } from "./RichDocumentEditor";
import "./LazyRichDocumentEditor.css";

/** Tiptap, ProseMirror, and code highlighting load in the editor's own chunk. */
export const loadRichDocumentEditor = () => import("./RichDocumentEditor");
const RichDocumentEditor = lazy(loadRichDocumentEditor);

/** Plain block text keeps a document readable and close to its final height until the editor mounts. */
export function RichDocumentPlaceholder({ blocks, className }: Pick<RichDocumentEditorProps, "blocks" | "className">) {
  return <div className={`rich-document-editor-loading ${className ?? ""}`} aria-busy="true">
    {blocks.map((block) => <div key={block.id} className="rich-document-loading-block">{block.content}</div>)}
  </div>;
}

export default function LazyRichDocumentEditor(props: RichDocumentEditorProps) {
  return <Suspense fallback={<RichDocumentPlaceholder blocks={props.blocks} className={props.className} />}>
    <RichDocumentEditor {...props} />
  </Suspense>;
}
