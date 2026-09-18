export type Role = "system" | "user" | "assistant";

export type AutoMode = "balanced" | "fast" | "thorough";
export type AIProvider = "openai" | "gemini" | "huggingface" | "xai";
export interface AISettings {
  mode: AutoMode;
  contextScope: "conversation" | "selected" | "workspace";
  selectedConversationIds: string[];
  allowedProviders?: AIProvider[];
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
  startOffset: number;
  endOffset: number;
  quote: string;
  prompt: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  kind?: "chat" | "note";
  title: string;
  parentId: string | null;
  serviceId: BackendServiceId;
  modelId: string;
  ai?: AISettings;
  branchAnchor: BranchAnchor | null;
  childIds: string[];
  documents?: ConversationDocument[];
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
  graphLayouts: Record<string, GraphNodeLayout>;
  groups: Record<string, ConversationGroup>;
  conversations: Record<string, Conversation>;
}
