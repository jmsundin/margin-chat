import type { BranchAnchor } from "@margin-chat/workspace-contracts";
export type {
  AISettings,
  AIProvider,
  AutoMode,
  AIExecutionRecord,
  AIContextSource,
  Role,
  BackendServiceId,
  Message,
  ConversationDocument,
  ConversationNote,
  BranchAnchor,
  Conversation,
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
  user?: AuthenticatedUser;
}

export interface CheckoutConfirmation {
  confirmed: boolean;
  status: string;
  purchaseKind: "subscription" | "hosted_credits";
  user?: AuthenticatedUser;
}

export interface BillingNotice {
  kind: "error" | "info" | "success";
  message: string;
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
  preview?: {
    kind: "chat" | "note";
    prompt?: string;
    content: string;
    messageCount?: number;
  };
}
