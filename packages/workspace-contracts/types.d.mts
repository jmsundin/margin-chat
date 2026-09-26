export type Role = "system" | "user" | "assistant";

export type AutoMode = "balanced" | "fast" | "thorough";
export type AIProvider = "openai" | "gemini" | "huggingface" | "xai";
export interface AISettings {
  mode: AutoMode;
  contextScope: "conversation" | "selected" | "workspace";
  selectedConversationIds: string[];
  allowedProviders?: AIProvider[];
  /** Explicit permission to send bounded context to TypeSafe for assistance. */
  jevEnabled?: boolean;
}
export interface AIContextSource {
  kind: "conversation" | "note" | "document";
  id: string;
  title: string;
  updatedAt?: string;
  excerpt?: string;
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
}

export type BackendServiceId =
  | "backend-services"
  | "openai-api"
  | "openai-agent"
  | "gemini-api"
  | "huggingface-api"
  | "xai-api";

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

export interface DocumentBlock {
  id: string;
  kind: "markdown";
  content: string;
  createdAt: string;
  updatedAt: string;
  sourceMessageId?: string;
  generationId?: string;
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
  replacement?: { blockId: string; offset: number; content: string };
}

export interface EditableDocument {
  schemaVersion: 1;
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
  /** Side documents retained as tabs while their panes are hidden. */
  minimizedIds: string[];
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
  branchAnchor: BranchAnchor | null;
  childIds: string[];
  documents?: ConversationDocument[];
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
  conversations: Record<string, Conversation>;
}
