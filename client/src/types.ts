export type Role = "system" | "user" | "assistant";
export type UserRole = "member" | "admin";
export type MainViewMode = "chat" | "tiles" | "graph";
export type BackendServiceId =
  | "backend-services"
  | "openai-api"
  | "gemini-api"
  | "huggingface-api"
  | "xai-api";
export type ThreadCategoryId =
  | "coding"
  | "research"
  | "writing"
  | "planning"
  | "design"
  | "data"
  | "personal"
  | "general";

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
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
  title: string;
  parentId: string | null;
  serviceId: BackendServiceId;
  modelId: string;
  branchAnchor: BranchAnchor | null;
  childIds: string[];
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

export interface GraphNodeLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AppState {
  rootId: string;
  activeConversationId: string;
  defaultServiceId: BackendServiceId;
  defaultModelId: string;
  railOpen: boolean;
  pinnedThreadIds: string[];
  graphLayouts: Record<string, GraphNodeLayout>;
  conversations: Record<string, Conversation>;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
}

export interface ThreadSummary {
  categoryId: ThreadCategoryId;
  categoryLabel: string;
  conversationCount: number;
  id: string;
  preview: string;
  title: string;
  updatedAt: string;
  updatedLabel: string;
}

export interface SelectionDraft {
  conversationId: string;
  messageId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
  prompt: string;
  rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

export interface ConnectionLine {
  id: string;
  start: {
    x: number;
    y: number;
  };
  end: {
    x: number;
    y: number;
  };
  active: boolean;
  variant?: "curve" | "straight";
}

export interface ConnectorOcclusionRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
}

export interface MessageAnchorLink {
  branchConversationId: string;
  title: string;
  anchor: BranchAnchor;
}
