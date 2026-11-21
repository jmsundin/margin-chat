import type { BranchAnchor } from "@margin-chat/workspace-contracts";
export type {
  AISettings,
  AIProvider,
  AutoMode,
  AIExecutionRecord,
  AgentRunRecord,
  AgentRunStep,
  AgentWebSource,
  AgentProposal,
  AgentEditProposal,
  AgentDocumentProposal,
  AgentRoadmapProposal,
  AIContextSource,
  AIRetrievalPassage,
  AIRetrievalRecord,
  Role,
  BackendServiceId,
  Message,
  ConversationDocument,
  ConversationNote,
  VaultFileReference,
  PublicTopicSource,
  DocumentRelation,
  DocumentRelationOrigin,
  DocumentRelationTypeId,
  BranchAnchor,
  Conversation,
  Roadmap,
  RoadmapNode,
  RoadmapStage,
  RoadmapStatus,
  DocumentDockNode,
  DocumentDockLayout,
  WorkspaceSession,
  WorkspaceSessions,
  DocumentDockPosition,
  GraphNodeLayout,
  ConversationGroup,
  AppState,
} from "@margin-chat/workspace-contracts";

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
/** Cloud ($10) is storage and sync with your own AI keys; Plus ($20) adds $20 of hosted AI credit. */
export type BillingPlan = "cloud" | "plus";

export type BillingAccessKind =
  | "admin"
  | "credits"
  | "subscription"
  | "trial"
  | "none"
  /** The desktop app running on its own, with no account (docs/desktop-local-mode.md). */
  | "local";
/** Keys for AI models. */
export type AIKeyProvider = "openai" | "anthropic" | "gemini" | "huggingface" | "xai" | "meta";
/** Keys for web search, translation and read-aloud voices. */
export type ServiceKeyProvider = "tavily" | "deepl" | "google_translate" | "azure_speech";
export type ApiKeyProvider = AIKeyProvider | ServiceKeyProvider;
export type ApiKeySettings = {
  byProvider: Record<
    ApiKeyProvider,
    { configured: boolean; hint: string | null }
  >;
  hasAny: boolean;
};
export type MainViewMode = "chat" | "tiles" | "graph";
export type ThreadCategoryId =
  | "coding"
  | "research"
  | "writing"
  | "planning"
  | "design"
  | "data"
  | "personal"
  | "general";

export interface AuthenticatedUser {
  apiKeys: ApiKeySettings;
  billing: UserBilling;
  id: string;
  email: string;
  /** Whether the account's address was confirmed from the emailed link; missing on older servers. */
  emailVerified?: boolean;
  displayName: string;
  /** Features not ready for everyone that this account may use (server OWNER_ONLY_FEATURE_EMAILS); missing on older servers. */
  ownerFeatures?: string[];
  role: UserRole;
}

export interface UserBilling {
  accessKind: BillingAccessKind;
  cancelAtPeriodEnd: boolean;
  creditBalanceMicros: number;
  currentPeriodEnd: string | null;
  hasAccess: boolean;
  hasCustomer: boolean;
  /** The plan the stored subscription price belongs to; null without a subscription. */
  plan?: BillingPlan | null;
  priceId: string | null;
  status: BillingStatus;
  /** An account made on the website that has no plan yet: it picks one (a free trial with a card) before the website opens. */
  planRequired?: boolean;
  /** Days free before the first charge if this account starts a plan now; 0 once it has had one. */
  freeTrialDays?: number;
  /** Whether the server sells the Cloud plan (its Stripe price is set). */
  cloudPlanAvailable?: boolean;
  trialCallsLimit: number;
  trialCallsRemaining: number;
  trialCallsUsed: number;
}

export interface BillingTransaction {
  id: string;
  amountMicros: number;
  type: string;
  createdAt: string;
  description: string;
  receiptUrl: string | null;
  metadata?: Record<string, unknown>;
}

export interface BillingDashboardData {
  /** Spendable balance; in-flight reservations have already been deducted. */
  balanceMicros: number;
  reservedMicros?: number;
  usageThisMonthMicros: number;
  totalPurchasedMicros: number;
  transactions: BillingTransaction[];
  subscription: Pick<UserBilling, "status" | "cancelAtPeriodEnd" | "currentPeriodEnd">;
  plan: { monthlyAmountMicros: number; currency: "usd"; rollover: boolean };
  /** Present when the server offers the Cloud plan. */
  cloudPlan?: { monthlyPriceCents: number; currency: "usd"; includesCreditMicros: number } | null;
  user?: AuthenticatedUser;
}

export interface CheckoutConfirmation {
  confirmed: boolean;
  status: string;
  purchaseKind: "subscription" | "hosted_credits";
  plan?: BillingPlan;
  /** The plan started with a free trial: nothing has been charged yet. */
  trial?: boolean;
  credited?: boolean;
  amountMicros?: number;
  user?: AuthenticatedUser;
}

export interface BillingNotice {
  kind: "error" | "info" | "success";
  message: string;
}

export interface ThreadSummary {
  createdAt?: string;
  createdLabel?: string;
  categoryId: ThreadCategoryId;
  categoryLabel: string;
  conversationCount: number;
  id: string;
  kind?: "chat" | "note";
  /** Set when the document shows a PDF or image from the vault. */
  fileKind?: "pdf" | "image" | "html";
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
  sourceBlockId?: string;
  sourceContent?: string;
  /** Lines after sourceBlockId that the passage continues into; they join it before the passage is saved. */
  joinBlockIds?: string[];
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
  continuation?: {
    title: string;
    direction: "up" | "down" | "left" | "right" | "open";
    relation: "source" | "target";
    target: ConnectorNavigationTarget;
    left: number;
    top: number;
    width: number;
    marginSide: "left" | "right";
  };
}

export interface ConnectorNavigationTarget {
  conversationId: string;
  anchorId?: string;
  blockId?: string;
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
  kind?: "document-link";
  targetBlockId?: string;
  preview?: {
    kind: "chat" | "note";
    prompt?: string;
    content: string;
    messageCount?: number;
  };
}
