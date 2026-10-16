import { useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import ConversationGraphView from "../ConversationGraphView";
import DocumentPanel from "../DocumentPanel";
import { getAnchorsByMessageId } from "../../lib/documentAnchorLinks";
import { normalizeGraphLayouts } from "../../lib/graphLayout";
import { assignConversationToGroup } from "../../lib/conversationGroups";
import { addChildConversation } from "../../lib/workspaceCommands";
import { addDemoSideDocument, DEMO_MAIN_DOCUMENT_ID } from "../../lib/demoVault";
import type { AppState, Conversation, SelectionDraft } from "../../types";
import "../../document-workspace.css";
import "../KnowledgeGraphWorkspace.css";
import "./LivePreviews.css";

export interface LivePreviewProps {
  vault: AppState;
  setVault: Dispatch<SetStateAction<AppState>>;
}

let demoIdCounter = 0;
const demoId = (prefix: string) => `demo-${prefix}-${Date.now().toString(36)}-${(demoIdCounter += 1)}`;

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function updateConversation(setVault: LivePreviewProps["setVault"], id: string, change: (conversation: Conversation) => Conversation) {
  setVault((state) => {
    const conversation = state.conversations[id];
    return conversation ? { ...state, conversations: { ...state.conversations, [id]: change(conversation) } } : state;
  });
}

const ignore = () => {};

/** A real document panel over the sample vault. AI requests, uploads and model changes are off in the preview. */
function DemoDocument({ vault, setVault, id, isActive, onSelection, onClearSelection, onOpenBranch, onSubmit, error }: LivePreviewProps & {
  id: string;
  isActive: boolean;
  onSelection?: (selection: SelectionDraft) => void;
  onClearSelection?: () => void;
  onOpenBranch: (id: string) => void;
  onSubmit: () => void;
  error?: string;
}) {
  const conversation = vault.conversations[id];
  const anchors = useMemo(() => Object.values(getAnchorsByMessageId(vault.conversations, id)).flat(), [vault.conversations, id]);
  if (!conversation) return null;
  return (
    <DocumentPanel
      conversation={conversation}
      isActive={isActive}
      isSubmitting={false}
      aiControls={null}
      recentModelSelections={[]}
      anchors={anchors}
      theme={currentTheme()}
      error={error}
      onChange={(document) => updateConversation(setVault, id, (current) => ({ ...current, document, updatedAt: new Date().toISOString() }))}
      onRename={(title) => updateConversation(setVault, id, (current) => ({ ...current, title }))}
      onSubmit={onSubmit}
      onStop={ignore}
      onSelection={onSelection ?? ignore}
      onClearSelection={onClearSelection}
      onOpenBranch={onOpenBranch}
      onOpenNote={onOpenBranch}
      onModelChange={ignore}
      onUpload={ignore}
      onRemoveAttachment={ignore}
      onAcceptVersion={ignore}
      onUndoInsertion={ignore}
      registerPanelRef={ignore}
      registerAnchorRef={ignore}
      registerBranchOriginRef={ignore}
    />
  );
}

const AI_PREVIEW_MESSAGE = "Ask AI works once you sign in. This preview runs only in your browser.";

export function LiveMapPreview({ vault, setVault }: LivePreviewProps) {
  const [focusRequest, setFocusRequest] = useState<{ conversationId: string; requestId: number; openReader?: boolean } | null>(null);
  const [aiMessage, setAiMessage] = useState<string>();
  const requests = useRef(0);
  const graphLayouts = useMemo(() => normalizeGraphLayouts(vault.conversations, vault.graphLayouts), [vault.conversations, vault.graphLayouts]);
  const activeConversationId = vault.conversations[vault.activeConversationId] ? vault.activeConversationId : DEMO_MAIN_DOCUMENT_ID;
  const open = (conversationId: string) => {
    setVault((state) => ({ ...state, activeConversationId: conversationId }));
    setFocusRequest({ conversationId, requestId: (requests.current += 1), openReader: true });
  };

  return (
    <div className="mk-live-frame mk-live-map">
      <ConversationGraphView
        isVisible
        workspaceKey="landing-demo"
        activeConversationId={activeConversationId}
        conversations={vault.conversations}
        graphLayouts={graphLayouts}
        groups={vault.groups}
        focusRequest={focusRequest}
        onFocusRequestHandled={(requestId) => setFocusRequest((current) => (current?.requestId === requestId ? null : current))}
        onActivateConversation={(conversationId) => setVault((state) => ({ ...state, activeConversationId: conversationId }))}
        onOpenConversation={open}
        onZoomIntoConversation={open}
        onAssignGroup={(conversationId, groupId) => setVault((state) => ({ ...state, groups: assignConversationToGroup(state.groups, conversationId, groupId) }))}
        onToggleGroup={(groupId) => setVault((state) => {
          const group = state.groups[groupId];
          return group ? { ...state, groups: { ...state.groups, [groupId]: { ...group, collapsed: !group.collapsed } } } : state;
        })}
        onCreateChildConversation={(parentId) => {
          const parent = vault.conversations[parentId];
          if (!parent) return null;
          const now = new Date().toISOString();
          const id = demoId("note");
          const child: Conversation = {
            id, kind: "note", title: "New note", parentId, childIds: [], branchAnchor: null, messages: [], notes: [],
            serviceId: parent.serviceId, modelId: parent.modelId, createdAt: now, updatedAt: now,
            document: { schemaVersion: 1, blocks: [{ id: `${id}-block-1`, kind: "markdown", content: "", createdAt: now, updatedAt: now, authorship: "user" }], prompts: [], generations: [] },
          };
          setVault((state) => addChildConversation(state, child, { activate: true }));
          return id;
        }}
        onUpdateGraphNodeLayouts={(next) => setVault((state) => {
          const merged = { ...state.graphLayouts };
          for (const [id, layout] of Object.entries(next)) merged[id] = { ...graphLayouts[id], ...merged[id], ...layout };
          return { ...state, graphLayouts: merged };
        })}
        onConnectConversation={(sourceId, targetId) => updateConversation(setVault, sourceId, (current) => ({
          ...current, linkedConversationIds: [...new Set([...(current.linkedConversationIds ?? []), targetId])],
        }))}
        onRemoveConnection={(sourceId, targetId) => {
          for (const [from, to] of [[sourceId, targetId], [targetId, sourceId]]) updateConversation(setVault, from, (current) => ({
            ...current, linkedConversationIds: current.linkedConversationIds?.filter((id) => id !== to),
          }));
        }}
        renderDockedConversation={(conversationId) => (
          <DemoDocument vault={vault} setVault={setVault} id={conversationId} isActive onOpenBranch={open}
            onSubmit={() => setAiMessage(AI_PREVIEW_MESSAGE)} error={aiMessage} />
        )}
      />
    </div>
  );
}

interface ComposerPosition { left: number; top: number }

export function LiveSideDocumentPreview({ vault, setVault }: LivePreviewProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<SelectionDraft | null>(null);
  const [position, setPosition] = useState<ComposerPosition | null>(null);
  const [text, setText] = useState("");
  const [sideId, setSideId] = useState<string | null>(null);
  const [aiMessage, setAiMessage] = useState<string>();
  const side = sideId ? vault.conversations[sideId] : undefined;

  // The selection rectangle is in viewport coordinates; the composer sits below it inside the frame.
  useEffect(() => {
    const frame = frameRef.current;
    if (!selection || !frame) { setPosition(null); return; }
    const bounds = frame.getBoundingClientRect();
    const width = Math.min(340, bounds.width - 24);
    const left = Math.min(Math.max(12, selection.rect.left - bounds.left + selection.rect.width / 2 - width / 2), bounds.width - width - 12);
    setPosition({ left, top: selection.rect.top - bounds.top + selection.rect.height + 10 });
  }, [selection]);

  function closeComposer() {
    setSelection(null);
    setText("");
  }

  function createSideDocument(event: FormEvent) {
    event.preventDefault();
    if (!selection) return;
    const id = demoId("side");
    setVault((state) => addDemoSideDocument(state, selection, text, id, new Date().toISOString()));
    setSideId(id);
    closeComposer();
    window.getSelection()?.removeAllRanges();
  }

  return (
    <div className="mk-live-frame mk-live-docs" ref={frameRef}>
      <div className="mk-live-docs-pane">
        <DemoDocument vault={vault} setVault={setVault} id={DEMO_MAIN_DOCUMENT_ID} isActive={!side}
          onSelection={(draft) => { setSelection(draft); setText(""); }}
          onClearSelection={() => { if (!text) setSelection(null); }}
          onOpenBranch={(id) => setSideId(id)}
          onSubmit={() => setAiMessage(AI_PREVIEW_MESSAGE)} error={side ? undefined : aiMessage} />
      </div>
      <div className="mk-live-docs-pane is-side" aria-live="polite">
        {side ? (
          <DemoDocument vault={vault} setVault={setVault} id={side.id} isActive onOpenBranch={(id) => setSideId(id)}
            onSubmit={() => setAiMessage(AI_PREVIEW_MESSAGE)} error={aiMessage} />
        ) : (
          <div className="mk-live-hint">
            <strong>Try it</strong>
            <p>Select a sentence in the document, then choose <em>Create side document</em>. It opens here, linked to the passage you highlighted, and shows up on the map below.</p>
          </div>
        )}
      </div>
      {selection && position ? (
        <form className="selection-tooltip mk-live-composer" style={{ left: position.left, top: position.top }} onSubmit={createSideDocument}
          onMouseDown={(event) => event.stopPropagation()}>
          <div className="selection-tooltip-head">
            <p className="eyebrow">New side document</p>
            <button aria-label="Cancel side document" className="selection-close" onClick={closeComposer} type="button">×</button>
          </div>
          <p className="selection-tooltip-quote">“{selection.quote.length > 132 ? `${selection.quote.slice(0, 131)}…` : selection.quote}”</p>
          <label className="mk-live-composer-field">
            <span>Your note (optional)</span>
            <input autoFocus value={text} onChange={(event) => setText(event.target.value)} placeholder="Why does this matter?" type="text" />
          </label>
          <button className="mk-btn mk-btn-primary mk-live-composer-submit" type="submit">Create side document</button>
        </form>
      ) : null}
    </div>
  );
}
