import { lazy, Suspense, useSyncExternalStore } from "react";
import type { RichDocumentEditorProps } from "./RichDocumentEditor";
import { readDocumentEditorKind, subscribeDocumentEditorPreference } from "../lib/documentEditorPreference";
import "./LazyRichDocumentEditor.css";

/** Each editor and its libraries load in their own chunk. */
export const loadClassicDocumentEditor = () => import("./RichDocumentEditor");
export const loadLiveDocumentEditor = () => import("./LiveDocumentEditor");
/** Loads whichever document editor this device uses. */
export const loadRichDocumentEditor = () => readDocumentEditorKind() === "classic" ? loadClassicDocumentEditor() : loadLiveDocumentEditor();
const ClassicDocumentEditor = lazy(loadClassicDocumentEditor);
const LiveDocumentEditor = lazy(loadLiveDocumentEditor);

/** Plain block text keeps a document readable and close to its final height until the editor mounts. */
export function RichDocumentPlaceholder({ blocks, className }: Pick<RichDocumentEditorProps, "blocks" | "className">) {
  return <div className={`rich-document-editor-loading ${className ?? ""}`} aria-busy="true">
    {blocks.map((block) => <div key={block.id} className="rich-document-loading-block">{block.content}</div>)}
  </div>;
}

export default function LazyRichDocumentEditor(props: RichDocumentEditorProps) {
  const kind = useSyncExternalStore(subscribeDocumentEditorPreference, readDocumentEditorKind, () => "live" as const);
  const Editor = kind === "classic" ? ClassicDocumentEditor : LiveDocumentEditor;
  return <Suspense fallback={<RichDocumentPlaceholder blocks={props.blocks} className={props.className} />}>
    <Editor {...props} />
  </Suspense>;
}
