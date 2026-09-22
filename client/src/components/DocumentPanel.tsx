import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Conversation, MessageAnchorLink, SelectionDraft } from "../types";
import { getEditableDocument } from "../lib/editableDocument";
import type { DocumentAIRequest } from "../lib/documentAI";
import { getBackendServiceModel, type RecentBackendServiceSelection } from "../lib/services";
import RichDocumentEditor, { type RichDocumentInvocation, type RichDocumentDecoration } from "./RichDocumentEditor";
import ServicePickerModal from "./ServicePickerModal";
import AnnotationPreview from "./AnnotationPreview";
import MarkdownMessage from "./MarkdownMessage";
import AIResponseDetails from "./AIResponseDetails";
import "./DocumentPanel.css";

type DocumentValue = NonNullable<Conversation["document"]>;
type Block = DocumentValue["blocks"][number];

export interface DocumentPanelProps {
  conversation: Conversation;
  isActive: boolean;
  isSubmitting: boolean;
  aiControls: ReactNode;
  groupControl: ReactNode;
  recentModelSelections: RecentBackendServiceSelection[];
  anchors: MessageAnchorLink[];
  theme: "light" | "dark";
  error?: string;
  onChange: (document: DocumentValue) => void;
  onRename: (title: string) => void;
  onSubmit: (request: DocumentAIRequest) => void;
  onStop: () => void;
  onSelection: (selection: SelectionDraft) => void;
  onClearSelection?: () => void;
  onVisibleOutlineChange?: (conversationId: string, outlineItemId: string) => void;
  onOpenBranch: (id: string) => void;
  onOpenNote: (id: string) => void;
  onModelChange: (serviceId: Conversation["serviceId"], modelId: string) => void;
  onUpload: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  uploading?: boolean;
  onAcceptVersion: (generationId: string) => void;
  onUndoInsertion: (generationId: string) => void;
  registerPanelRef: (element: HTMLElement | null) => void;
  registerAnchorRef: (id: string, element: HTMLSpanElement | null) => void;
  registerBranchOriginRef: (element: HTMLElement | null) => void;
}

function freshBlock(content = ""): Block {
  const now = new Date().toISOString();
  return { id: `block-${crypto.randomUUID()}`, kind: "markdown", content, createdAt: now, updatedAt: now };
}

export default function DocumentPanel(props: DocumentPanelProps) {
  const { conversation } = props;
  const document = useMemo(() => getEditableDocument(conversation), [conversation]);
  const latestDocument = useRef(document);
  latestDocument.current = document;
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [invocation, setInvocation] = useState<RichDocumentInvocation | null>(null);
  const [prompt, setPrompt] = useState("");
  const [destination, setDestination] = useState<"inline" | "side">("inline");
  const [replaceSelection, setReplaceSelection] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [openPromptId, setOpenPromptId] = useState<string | null>(null);
  const [title, setTitle] = useState(conversation.title);
  const [rerunText, setRerunText] = useState("");
  const [hiddenVersions, setHiddenVersions] = useState<string[]>([]);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setTitle(conversation.title), [conversation.title]);
  useEffect(() => { if (invocation) promptRef.current?.focus(); }, [invocation]);
  useEffect(() => {
    if (!invocation || document.blocks.some((block) => block.id === invocation.blockId)) return;
    setInvocation(null);
  }, [document.blocks, invocation]);

  function change(next: DocumentValue) { latestDocument.current = next; props.onChange(next); }
  function updateBlock(id: string, content: string) {
    const current = latestDocument.current;
    change({ ...current, blocks: current.blocks.map((block) => block.id === id ? { ...block, content, updatedAt: new Date().toISOString() } : block) });
  }
  function insertBlock(afterId: string | null, content: string) {
    const current = latestDocument.current;
    const block = freshBlock(content);
    const blocks = [...current.blocks];
    const index = blocks.findIndex((item) => item.id === afterId);
    blocks.splice(index < 0 ? blocks.length : index + 1, 0, block);
    change({ ...current, blocks });
    return block.id;
  }
  function splitBlock(id: string, before: string, after: string) {
    const current = latestDocument.current;
    const source = current.blocks.find((block) => block.id === id);
    if (!source) return "";
    const block = { ...freshBlock(after), sourceMessageId: source.sourceMessageId, generationId: source.generationId };
    const blocks = current.blocks.flatMap((item) => item.id === id ? [{ ...item, content: before, updatedAt: new Date().toISOString() }, block] : [item]);
    change({ ...current, blocks });
    return block.id;
  }
  function dismissAI(restoreSpaces = true) {
    const previous = invocation;
    setInvocation(null);
    setPrompt("");
    previous?.restoreFocus({ restoreSpaces });
  }
  function submit() {
    if (!invocation || !prompt.trim() || props.isSubmitting) return;
    props.onSubmit({ blockId: invocation.blockId, from: invocation.selection?.startOffset ?? invocation.offset,
      to: invocation.selection?.endOffset ?? invocation.offset, quote: invocation.selection?.quote,
      prompt, destination, replaceSelection, sourceContent: invocation.markdown });
    setInvocation(null);
    setPrompt("");
  }
  const streamingIds = document.generations.filter((generation) => generation.status === "streaming" && props.isSubmitting).flatMap((generation) => generation.blockIds);
  function currentVersion(original: DocumentValue["generations"][number] | undefined) {
    return original && ([...document.generations].reverse().find((generation)=>(generation.id===original.id || generation.alternativeOf===original.id) && generation.acceptedAt && generation.blockIds.some((id)=>document.blocks.some((block)=>block.id===id))) ?? original);
  }
  const promptBlockIds = new Map(document.prompts.map((item) => {
    const generation = currentVersion(document.generations.find((candidate) => candidate.promptId === item.id && !candidate.alternativeOf));
    return [item.id, generation?.blockIds.find((id) => document.blocks.some((block) => block.id === id)) ?? document.blocks.at(-1)?.id];
  }));
  const modelLabel = conversation.serviceId === "backend-services" ? "Auto" : getBackendServiceModel(conversation.serviceId, conversation.modelId)?.label ?? conversation.modelId;
  const decorations: Record<string, RichDocumentDecoration[]> = {};
  const sourceOffsets = new Map<string, number>();
  for (const block of document.blocks) {
    const sourceId = block.sourceMessageId ?? `document:${block.id}`;
    const base = sourceOffsets.get(sourceId) ?? 0;
    sourceOffsets.set(sourceId, base + block.content.length);
    function addRange(anchor: {sourceMessageId: string | null; sourceBlockId?: string; startOffset: number | null; endOffset: number | null; quote: string | null}, ids: Pick<RichDocumentDecoration,"branchIds"|"noteIds">) {
      if (anchor.sourceBlockId ? anchor.sourceBlockId !== block.id : anchor.sourceMessageId !== sourceId) return;
      if (anchor.startOffset === null || anchor.endOffset === null) return;
      let from = anchor.startOffset - (anchor.sourceBlockId ? 0 : base);
      let to = anchor.endOffset - (anchor.sourceBlockId ? 0 : base);
      const quote = anchor.quote ?? "";
      // Legacy highlights used rendered-text offsets. Recover an exact quote
      // when possible; an edited-away passage must not highlight another phrase.
      if (quote && block.content.slice(from,to) !== quote) {
        if (anchor.sourceBlockId) return;
        const found = block.content.indexOf(quote);
        if (found < 0 || block.content.indexOf(quote, found + 1) >= 0) return;
        from = found; to = found + quote.length;
      }
      if (from < 0 || to > block.content.length || to <= from) return;
      (decorations[block.id] ??= []).push({from,to,...ids});
    }
    props.anchors.forEach((anchor) => addRange(anchor.anchor,{branchIds:[anchor.branchConversationId]}));
    conversation.notes?.forEach((note) => addRange(note,{noteIds:[note.id]}));
  }
  useEffect(() => {
    const ids: string[] = [];
    const frame=window.requestAnimationFrame(() => {
      bodyRef.current?.querySelectorAll<HTMLSpanElement>("[data-annotation-branches]").forEach((element)=>{
        try { for(const id of JSON.parse(element.dataset.annotationBranches ?? "[]")) {if(typeof id === "string") {props.registerAnchorRef(id,element);ids.push(id);}} } catch { /* A stale decoration is ignored. */ }
      });
    });
    return () => {window.cancelAnimationFrame(frame);ids.forEach((id)=>props.registerAnchorRef(id,null));};
  },[document,props.anchors]);
  function reportVisibleOutline() {
    const panel = bodyRef.current;
    if (!panel || !props.onVisibleOutlineChange) return;
    const readingLine = panel.getBoundingClientRect().top + 32;
    const targets = Array.from(panel.querySelectorAll<HTMLElement>("[data-chat-outline-id]"));
    let visibleId = targets[0]?.dataset.chatOutlineId;
    let closestTop = -Infinity;
    for (const target of targets) {
      const top = target.getBoundingClientRect().top;
      if (top <= readingLine && top >= closestTop) {
        closestTop = top;
        visibleId = target.dataset.chatOutlineId;
      }
    }
    if (visibleId) props.onVisibleOutlineChange(conversation.id, visibleId);
  }

  function openHighlight(target: EventTarget | null) {
    const mark=target instanceof Element ? target.closest<HTMLElement>("[data-annotation-branches]") : null;
    if(!mark || !window.getSelection()?.isCollapsed)return;
    try { const id=JSON.parse(mark.dataset.annotationBranches ?? "[]")[0];if(typeof id === "string")props.onOpenBranch(id); } catch { /* Ignore malformed saved decorations. */ }
  }

  function renderPrompt(item: DocumentValue["prompts"][number]) {
    const generations = document.generations.filter((generation) => generation.promptId === item.id);
    const original = generations.find((generation) => !generation.alternativeOf) ?? generations[0];
    const active = currentVersion(original);
    const activePrompt = document.prompts.find((prompt) => prompt.id === active?.promptId) ?? item;
    const alternatives = document.generations.filter((generation) => generation.alternativeOf === original?.id && !generation.acceptedAt && !hiddenVersions.includes(generation.id));
    const receipt = conversation.messages.find((message) => message.id === active?.messageId)?.execution;
    return <div className="document-prompt-marker" key={item.id} data-chat-outline-id={`message-${item.sourceMessageId ?? `document-prompt:${item.id}`}`}>
      <button className="document-prompt-icon" aria-label={`Show AI prompt: ${item.content.slice(0,70)}`} aria-expanded={openPromptId === item.id} type="button"
        title="AI prompt and versions" onClick={() => { setOpenPromptId(openPromptId === item.id ? null : item.id); setRerunText(activePrompt.content); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-6 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M8 8h8M8 12h5"/></svg>
      </button>
      {openPromptId === item.id ? <section className="document-prompt-history" aria-label="AI prompt and versions" onKeyDown={(event) => { if(event.key === "Escape") {event.stopPropagation();setOpenPromptId(null);} }}>
        <header><strong>AI prompt</strong><button aria-label="Close prompt history" type="button" onClick={() => setOpenPromptId(null)}>×</button></header>
        <textarea aria-label="Saved AI prompt" value={rerunText} onChange={(event) => setRerunText(event.target.value)} rows={3}/>
        <small>{activePrompt.modelId || "Auto"} · {new Date(activePrompt.createdAt).toLocaleDateString()}</small>
        <div className="document-version-actions"><button type="button" disabled={props.isSubmitting || !rerunText.trim()} onClick={() => {
          props.onSubmit({ blockId: active?.blockIds[0] ?? document.blocks[0]?.id ?? "", from:0,to:0,prompt:rerunText,destination:"inline",rerunGenerationId:original?.id });
        }}>↻ Try another version</button>
          {active && active.blockIds.some((id) => document.blocks.some((block) => block.id === id)) ? <button disabled={props.isSubmitting} type="button" onClick={() => props.onUndoInsertion(active.id)}>Undo insertion</button> : null}
        </div>
        {receipt ? <AIResponseDetails execution={receipt} isStreaming={props.isSubmitting} onOpenSource={props.onOpenBranch}/> : null}
        {alternatives.map((alternative) => <section className="document-alternative" key={alternative.id}>
          <strong>{alternative.status === "streaming" && props.isSubmitting ? "Writing another version…" : "Alternative version"}</strong>
          <MarkdownMessage anchors={[]} content={conversation.messages.find((message) => message.id === alternative.messageId)?.content ?? ""} conversationId={conversation.id} messageId={alternative.messageId} notes={[]} onOpenBranch={props.onOpenBranch} pendingSelection={null} registerAnchorRef={() => {}} registerNoteAnchorRef={() => {}} enableMermaidRendering theme={props.theme}/>
          {alternative.status !== "streaming" || !props.isSubmitting ? <div className="document-version-actions"><button type="button" disabled={alternative.status === "failed" || (alternative.status === "streaming" && props.isSubmitting) || !conversation.messages.find((message)=>message.id===alternative.messageId)?.content.trim()} onClick={() => props.onAcceptVersion(alternative.id)}>Use this version</button><button type="button" onClick={() => setHiddenVersions((current) => [...current, alternative.id])}>Keep current</button></div> : null}
        </section>)}
      </section> : null}
    </div>;
  }

  return <article className={`chat-panel document-panel${props.isActive ? " is-active" : ""}`} ref={props.registerPanelRef}>
    <div className="panel-body document-body" ref={bodyRef} onScroll={reportVisibleOutline} onClickCapture={(event)=>openHighlight(event.target)} onKeyDownCapture={(event)=>{if(event.key === "Enter" && (event.target as Element).closest?.("[data-annotation-branches]")){event.preventDefault();openHighlight(event.target);}}}>
      {props.groupControl ? <div className="document-header-details">{props.groupControl}</div> : null}
      {conversation.branchAnchor ? <div className="document-origin" ref={props.registerBranchOriginRef}><button type="button" onClick={() => props.onOpenBranch(conversation.parentId!)}>← Source document</button><span title={conversation.branchAnchor.quote}>{conversation.branchAnchor.quote}</span></div> : null}
      <header className="document-header">
        <input aria-label="Document title" value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => { const value=title.trim() || "Untitled document";setTitle(value);if(value!==conversation.title)props.onRename(value); }} onKeyDown={(event) => {if(event.key === "Enter")event.currentTarget.blur();}}/>
      </header>
      <RichDocumentEditor conversationId={conversation.id} blocks={document.blocks} readOnlyBlockIds={streamingIds} decorations={decorations}
        onUpdateBlock={updateBlock} onInsertBlock={insertBlock} onSplitBlock={splitBlock}
        onDeleteBlock={(id) => {const current=latestDocument.current;const blocks=current.blocks.filter((block)=>block.id!==id);change({...current,blocks:blocks.length?blocks:[freshBlock()]});}}
        onReorderBlock={(id,beforeId) => {const current=latestDocument.current;const block=current.blocks.find((item)=>item.id===id);if(!block||id===beforeId)return;const blocks=current.blocks.filter((item)=>item.id!==id);const index=blocks.findIndex((item)=>item.id===beforeId);blocks.splice(index<0?blocks.length:index,0,block);change({...current,blocks});}}
        onInvokeAI={(next) => {props.onClearSelection?.();setInvocation(next);setReplaceSelection(false);setOpenPromptId(null);}}
        onSelectionChange={(selection) => { if(selection)props.onSelection({...selection,prompt:"",sourceKind:"message",sourceContent:document.blocks.find((block)=>block.id===selection.sourceBlockId)?.content}); else props.onClearSelection?.(); }}
        renderBlockPreview={(block)=><MarkdownMessage anchors={[]} content={block.content} conversationId={conversation.id} messageId={block.sourceMessageId ?? `document:${block.id}`} notes={[]} onOpenBranch={props.onOpenBranch} pendingSelection={null} registerAnchorRef={props.registerAnchorRef} registerNoteAnchorRef={()=>{}} enableMermaidRendering theme={props.theme}/>}
        renderAfterBlock={(block) => <>
          {document.prompts.filter((item) => promptBlockIds.get(item.id) === block.id && !document.generations.some((generation) => generation.promptId === item.id && generation.alternativeOf)).map(renderPrompt)}
          {invocation?.blockId === block.id ? <form className="document-ai-composer" onSubmit={(event) => {event.preventDefault();submit();}} onKeyDown={(event)=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();dismissAI();}}}>
            <div className="document-ai-heading"><strong>✦ Ask AI</strong><button type="button" aria-label="Close AI prompt" onClick={()=>dismissAI()}>×</button></div>
            {invocation.selection?.quote ? <blockquote>{invocation.selection.quote}</blockquote> : null}
            <textarea aria-label="AI prompt" placeholder="What would you like to write or explore?" value={prompt} onChange={(event)=>setPrompt(event.target.value)} ref={promptRef} rows={2} onKeyDown={(event)=>{if(event.key==="Enter"&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();submit();}}}/>
            <div className="document-ai-options"><div role="group" aria-label="Response destination"><button aria-pressed={destination==="inline"} onClick={()=>setDestination("inline")} type="button">In this document</button><button aria-pressed={destination==="side"} onClick={()=>setDestination("side")} type="button">Side document ↗</button></div>
              {invocation.selection && destination==="inline" ? <label><input type="checkbox" checked={replaceSelection} onChange={(event)=>setReplaceSelection(event.target.checked)}/>Replace selection</label> : null}</div>
            <div className="document-ai-toolbar"><button type="button" aria-label="Attach documents" onClick={()=>fileRef.current?.click()}>＋ Attach</button>{props.groupControl}<button type="button" aria-label="Choose AI model" onClick={()=>setModelOpen(true)}>{modelLabel}⌄</button><button className="document-ai-send" type="submit" disabled={!prompt.trim()||props.isSubmitting}>Generate ↑</button></div>
            <small>Uses this document{invocation.selection?.quote ? " and the selected passage" : ""} · Enter to send</small>
          </form> : null}
        </>}/>
      {props.isSubmitting ? <div className="document-writing-status" role="status">Writing… You can keep editing other blocks.<button type="button" onClick={props.onStop}>Stop</button></div> : null}
      {props.error ? <p className="document-error" role="alert">{props.error}</p> : null}
      {conversation.documents?.length || props.uploading ? <div className="document-attachments" aria-label="Attached documents">{conversation.documents?.map((attachment)=><span key={attachment.id}>{attachment.filename}<button type="button" aria-label={`Remove ${attachment.filename}`} onClick={()=>props.onRemoveAttachment(attachment.id)}>×</button></span>)}{props.uploading ? <span>Uploading…</span>:null}</div>:null}
      <input hidden multiple type="file" ref={fileRef} onChange={(event)=>{const files=Array.from(event.target.files??[]);event.target.value="";if(files.length)props.onUpload(files);}}/>
    </div>
    <AnnotationPreview containerRef={bodyRef} anchors={props.anchors} notes={conversation.notes??[]} onOpenBranch={props.onOpenBranch} onOpenNote={props.onOpenNote}/>
    <ServicePickerModal contextControls={props.aiControls} currentModelId={conversation.modelId} currentServiceId={conversation.serviceId} isOpen={modelOpen} onClose={()=>setModelOpen(false)} onSelectModel={props.onModelChange} recentSelections={props.recentModelSelections}/>
  </article>;
}
