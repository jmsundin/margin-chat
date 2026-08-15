export type Role = "system" | "user" | "assistant";
export type UserRole = "member" | "admin";
export type BillingStatus =
  | "active"
  | "canceled"
  | "inactive"
  | "incomplete"
  | "incomplete_expired"
  | "past_due"
  | "paused"
  | "trialing"
  | "unpaid";
export type BillingAccessKind =
  | "admin"
  | "credits"
  | "subscription"
  | "trial"
  | "none";
export type ApiKeyProvider = "openai" | "gemini" | "huggingface" | "xai";
export type ApiKeySettings = {
  byProvider: Record<
    ApiKeyProvider,
    { configured: boolean; hint: string | null }
  >;
  hasAny: boolean;
};
export type MainViewMode = "chat" | "tiles" | "graph";
export type BackendServiceId =
  | "backend-services"
  | "openai-api"
  | "openai-agent"
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
  branchAnchor: BranchAnchor | null;
  childIds: string[];
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

export interface AuthenticatedUser {
  apiKeys: ApiKeySettings;
  billing: UserBilling;
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
}

export interface UserBilling {
  accessKind: BillingAccessKind;
  cancelAtPeriodEnd: boolean;
  creditBalanceMicros: number;
  currentPeriodEnd: string | null;
  hasAccess: boolean;
  hasCustomer: boolean;
  priceId: string | null;
  status: BillingStatus;
  trialCallsLimit: number;
  trialCallsRemaining: number;
  trialCallsUsed: number;
}

export interface ThreadSummary {
  categoryId: ThreadCategoryId;
  categoryLabel: string;
  conversationCount: number;
  id: string;
  kind?: "chat" | "note";
  groupId?: string | null;
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
  sourceKind?: "message" | "standalone-note";
  sourceNoteId?: string;
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
