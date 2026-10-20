export type Role = "system" | "user" | "assistant";

export type AutoMode = "balanced" | "fast" | "thorough";
export type AIProvider = "openai" | "anthropic" | "gemini" | "huggingface" | "xai" | "meta";
export interface AISettings {
  mode: AutoMode;
  contextScope: "conversation" | "selected" | "workspace";
  selectedConversationIds: string[];
  allowedProviders?: AIProvider[];
  /** Explicit permission to send bounded context to TypeSafe for assistance. */
  jevEnabled?: boolean;
  /** Agent mode: the model may call workspace tools over several steps. */
  agent?: boolean;
  /** Spending cap for one agent run, in micro-dollars (one of the offered choices). */
  agentBudgetMicros?: number;
  /** What Agent mode may search in the saved vault: all of it unless the user limits it. */
  agentScope?: "conversation" | "selected" | "workspace";
  /** False when the user stopped Agent mode from turning itself on for prompts that need looking things up. */
  agentAuto?: false;
}
export interface AgentRunStep {
  /** tool: a tool it ran; note: text it wrote between tool calls; thinking: its summarized reasoning for one model call. */
  kind: "tool" | "note" | "thinking";
  label: string;
  tool?: string;
  detail?: string;
  ok: boolean;
}
export interface AgentRunRecord {
  steps: AgentRunStep[];
  /** "question": the run stopped to ask the user something; their next message answers it. */
  stopReason: "answered" | "budget" | "round-limit" | "time-limit" | "question";
  /** Whether the model shared any of its thinking during the run; absent on runs saved before it was recorded. */
  reasoning?: "shared" | "not-shared";
  modelCalls?: number;
  spentMicros?: number;
  budgetMicros?: number;
  /** Why Agent mode turned itself on for this reply ("it includes a web link to read"); absent when the user turned it on. */
  automatic?: string;
  /** Web pages the answer cites, from the model's built-in web search. */
  webSources?: AgentWebSource[];
  /** The clarifying question a run stopped with, and the answers it suggested. */
  question?: { text: string; options: string[] };
  /** Changes the agent drafted for the user to approve. */
  proposals?: AgentProposal[];
}
interface AgentProposalBase {
  id: string;
  summary: string;
  /** Absent while the user hasn't decided. */
  status?: "approved" | "dismissed";
}
/** Replace `find` (exact text; empty adds at the end) with `replace` in a document. */
export interface AgentEditProposal extends AgentProposalBase {
  kind: "edit";
  documentId: string;
  documentTitle: string;
  find: string;
  replace: string;
}
/** A new document under `parentId`; `createdId` is the document approving it made. */
export interface AgentDocumentProposal extends AgentProposalBase {
  kind: "create";
  parentId: string;
  parentTitle: string;
  title: string;
  content: string;
  createdId?: string;
}
export type AgentProposal = AgentEditProposal | AgentDocumentProposal;
export interface AgentWebSource {
  url: string;
  title: string;
}
export interface AIContextSource {
  kind: "conversation" | "note" | "document";
  id: string;
  title: string;
  updatedAt?: string;
  excerpt?: string;
}
/** One passage the vault search found for a reply. */
export interface AIRetrievalPassage {
  /** How the reply was told to cite it, such as "Vault 1"; absent in Agent mode. */
  label?: string;
  /** The document, note or chat; for an uploaded file, the file's own ID; for a vault PDF, its document's ID. */
  id: string;
  kind: "document" | "note" | "chat" | "file";
  title: string;
  /** The headings it sits under, or a file's page. */
  heading?: string;
  /** Found by the same words, by meaning only, or both. */
  matched: "both" | "keyword" | "meaning";
  /** Cosine similarity to the question, when search by meaning ran. */
  similarity?: number;
  excerpt?: string;
  blockId?: string;
  /** The document or chat to open: the source itself, or the one a file is attached to. */
  openId?: string;
  /** The reply cites it. */
  cited?: boolean;
}
/** What the vault search contributed to a reply. */
export interface AIRetrievalRecord {
  /** used: passages went into the request; none-found: nothing matched well enough; not-searched: the AI context didn't include the workspace; failed: the search broke. */
  status: "used" | "none-found" | "not-searched" | "failed";
  /** Agent mode ran its own searches; `queries` lists them. */
  agent?: boolean;
  queries?: string[];
  /** Search by meaning took part, not only exact words. */
  meaning: boolean;
  /** Why search by meaning didn't take part, or why nothing was searched. */
  note?: string;
  /** Matches left out because the request already held those documents in full. */
  alreadyIncluded?: number;
  passages: AIRetrievalPassage[];
}
export interface AIExecutionRecord {
  schemaVersion: 1;
  model: string;
  provider: string;
  mode: AutoMode;
  task: string;
  reason: string;
  profileVersion: string;
  /** Selection provenance; model may identify a different model after fallback. */
  routing?: {
    method: "astra" | "astra-task" | "jev" | "jev-task" | "rules" | "manual";
    selectedModel: string;
  };
  sources: AIContextSource[];
  truncated: boolean;
  fallbacks: Array<{ provider: string; model: string; reason: string }>;
  warnings: string[];
  durationMs?: number;
  completedAt?: string;
  status?: "streaming" | "complete" | "stopped" | "failed";
  agent?: AgentRunRecord;
  retrieval?: AIRetrievalRecord;
}

export type BackendServiceId =
  | "backend-services"
  | "openai-api"
  | "openai-agent"
  | "anthropic-api"
  | "gemini-api"
  | "huggingface-api"
  | "xai-api"
  | "meta-api";

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  execution?: AIExecutionRecord;
}

export interface ConversationDocument {
  createdAt: string;
  error: string | null;
  filename: string;
  id: string;
  mimeType: string;
  sizeBytes: number;
  status: "processing" | "ready" | "failed";
}

export interface VaultFileReference {
  /** The file's path in the vault, such as `Papers/Attention.pdf`. */
  path: string;
  kind: "pdf" | "image";
}

export interface ConversationNote {
  id: string;
  content: string;
  kind?: "comment" | "side-chat" | "standalone";
  sourceMessageId: string | null;
  sourceBlockId?: string;
  startOffset: number | null;
  endOffset: number | null;
  quote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BranchAnchor {
  id: string;
  sourceConversationId: string;
  sourceMessageId: string;
  sourceBlockId?: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  prompt: string;
  createdAt: string;
}

/** Markdown offsets are UTF-16 string offsets, matching JavaScript/editor selections. */
export interface DocumentSelection {
  blockId: string;
  from: number;
  to: number;
  quote: string;
}

export interface DocumentInsertion {
  blockId: string | null;
  offset: number;
  /** An explicit replacement ends here; omitted inserts without deleting text. */
  replaceTo?: number;
}

export type DocumentBlockAuthorship = "ai" | "user" | "mixed";

export interface DocumentBlock {
  id: string;
  kind: "markdown";
  content: string;
  createdAt: string;
  updatedAt: string;
  sourceMessageId?: string;
  generationId?: string;
  /** Block-level origin; human edits retain AI origin as mixed authorship. */
  authorship?: DocumentBlockAuthorship;
}

/** A user-authored passage link; it does not change either document's ancestry. */
export interface DocumentLink {
  id: string;
  sourceMessageId: string;
  sourceBlockId?: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  targetConversationId: string;
  targetBlockId?: string;
  createdAt: string;
}

export interface DocumentPrompt {
  id: string;
  content: string;
  createdAt: string;
  sourceMessageId?: string;
  serviceId: BackendServiceId;
  modelId: string;
  ai?: AISettings;
  selection?: DocumentSelection;
}

export interface DocumentGeneration {
  id: string;
  promptId: string;
  /** Original output remains in messages, even after its visible blocks are edited. */
  messageId: string;
  createdAt: string;
  serviceId: BackendServiceId;
  modelId: string;
  ai?: AISettings;
  status: "streaming" | "complete" | "stopped" | "failed";
  alternativeOf?: string;
  blockIds: string[];
  insertion?: DocumentInsertion;
  /** Candidates do not have acceptedAt and never enter the document by projection. */
  acceptedAt?: string;
  /** Authored blocks replaced when accepting a rerun, retained for an exact undo. */
  previousBlocks?: DocumentBlock[];
  replacement?: { blockId: string; offset: number; content: string; authorship?: DocumentBlockAuthorship };
}

export interface EditableDocument {
  schemaVersion: 1;
  /** Presentation only: margin notes retain the complete document editor and data model. */
  marginNote?: {
    display: "compact" | "full";
    /** Remember the compact frame size independently of the full document layout. */
    size?: { width: number; height: number };
    /** Migration identity and original reference, retained even if the passage is gone. */
    legacyNoteId?: string;
    source?: Pick<ConversationNote, "sourceMessageId" | "sourceBlockId" | "startOffset" | "endOffset" | "quote">;
  };
  blocks: DocumentBlock[];
  prompts: DocumentPrompt[];
  generations: DocumentGeneration[];
  /** Source passages remain historical references if their block or target is removed. */
  links?: DocumentLink[];
}

export interface PublicTopicSource {
  /** Canonical Wikidata item ID; aliases contain redirected item IDs, not labels. */
  id: string;
  aliases: string[];
  label: string;
  description: string;
  wikidataUrl: string;
  wikipediaUrl?: string;
  retrievedAt: string;
  revision?: number;
}

export interface DocumentLayout {
  /** Horizontal document positions within this root's family; ancestry is unchanged. */
  order: string[];
  /** Documents retained as tabs while their panes are hidden. */
  minimizedIds: string[];
  /** Documents hidden from both panes and tabs, available to reopen without deletion. */
  closedIds?: string[];
  /** User-selected widths in CSS pixels, keyed by document in this root's family. */
  widthsById?: Record<string, number>;
}

export type DocumentDockNode =
  | { type: "pane"; documentId: string; scope?: "workspace" | "family" }
  | { type: "split"; id: string; direction: "horizontal" | "vertical"; ratio: number;
      first: DocumentDockNode; second: DocumentDockNode };

export type DocumentDockPosition = "left" | "right" | "top" | "bottom";

export interface DocumentDockLayout {
  /** A pane may remain visible across the workspace or only within its document family. */
  tree: DocumentDockNode | null;
  /** Fraction of the document workspace reserved for pinned panes. */
  width: number;
  /** Side of the scrolling workspace occupied by pinned panes; omitted means left. */
  position?: DocumentDockPosition;
}

/** A named working space shown as a top tab, like a tmux session. A document may belong to several. */
export interface WorkspaceSession {
  id: string;
  name: string;
  /** "auto" names follow the session's documents; a rename makes it "user". */
  nameSource: "auto" | "user";
  /** The documents an automatic name was written for, so it is only renamed when they change. */
  nameKey?: string;
  color: string;
  /** Documents that joined the session, oldest first. */
  documentIds: string[];
  /** The document that was focused when the session was last left. */
  activeDocumentId?: string;
  /** Pinned panes as they were when the session was last left. */
  documentDock?: DocumentDockLayout;
  createdAt: string;
  lastOpenedAt: string;
}

export interface WorkspaceSessions {
  items: Record<string, WorkspaceSession>;
  /** Sessions shown in the tab bar, left to right. Others live only in the Sessions panel. */
  tabIds: string[];
  activeId: string | null;
}

export type DocumentRelationTypeId =
  | "supports" | "contradicts" | "cites" | "elaborates" | "example-of" | "part-of" | "depends-on" | "same-as";
export type DocumentRelationOrigin = "user" | "ai" | "import";

/** A typed, directed edge saved in the source document's frontmatter. */
export interface DocumentRelation {
  type: DocumentRelationTypeId;
  targetConversationId?: string;
  /** The original link text when the target is not in this vault (yet), so the link survives a save. */
  target?: string;
  /** An Obsidian block reference (`[[Doc#^id]]`) to a passage of the target. */
  targetBlockId?: string;
  /** The passage of this document the relation comes from. */
  sourceBlockId?: string;
  /** Strength from 0 to 1. */
  weight?: number;
  /** Who asserted it. */
  origin?: DocumentRelationOrigin;
  note?: string;
  createdAt?: string;
}

export interface Conversation {
  id: string;
  grouping?: "manual" | "automatic";
  kind?: "chat" | "note";
  title: string;
  parentId: string | null;
  serviceId: BackendServiceId;
  modelId: string;
  ai?: AISettings;
  publicTopic?: PublicTopicSource;
  /** User-authored connections, independent of the parent/child tree. */
  linkedConversationIds?: string[];
  /** Typed edges, written as frontmatter properties holding wiki links. */
  relations?: DocumentRelation[];
  /** A short node type from frontmatter `type:` (question, claim, source…). */
  nodeType?: string;
  /** The document's own tags from frontmatter, without Margin Chat's reserved tags. */
  tags?: string[];
  /** The user keeps this document out of AI context, Agent tools, search by
   * meaning and connected apps. Written as frontmatter `hide-from-ai: true`. */
  hiddenFromAI?: boolean;
  branchAnchor: BranchAnchor | null;
  childIds: string[];
  documents?: ConversationDocument[];
  /** A PDF or image in the vault that this document shows. Its notes and AI
   * conversation live here; the file itself is never changed. */
  vaultFile?: VaultFileReference;
  document?: EditableDocument;
  /** Saved on the family root, independent of which document is currently focused. */
  documentLayout?: DocumentLayout;
  messages: Message[];
  notes?: ConversationNote[];
  createdAt: string;
  updatedAt: string;
}

export interface GraphNodeLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  positioned?: boolean;
  treeOriginX?: number;
  treeOriginY?: number;
}

export interface ConversationGroup {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
  conversationIds: string[];
}

export interface AppState {
  rootId: string;
  activeConversationId: string;
  defaultServiceId: BackendServiceId;
  defaultModelId: string;
  railOpen: boolean;
  pinnedThreadIds: string[];
  documentDock?: DocumentDockLayout;
  graphLayouts: Record<string, GraphNodeLayout>;
  groups: Record<string, ConversationGroup>;
  /** Named workspaces shown as top tabs; absent until the first session is made. */
  sessions?: WorkspaceSessions;
  conversations: Record<string, Conversation>;
}
