import { describe, expect, test } from "bun:test";
import { createEmptyState } from "../client/src/initialState";
import {
  areWorkspaceStatesEqual,
  canSyncWorkspaceToCloud,
  createLocalWorkspaceRecord,
  isRecoverableCloudSyncError,
  parseLocalWorkspaceRecord,
} from "../client/src/lib/workspaceStorage";
import { ApiError } from "../client/src/lib/api";
import type {
  AuthenticatedUser,
  BillingAccessKind,
} from "../client/src/types";
import { canUseCloudWorkspaceStorage } from "../server/routes/api.mjs";

function user(
  accessKind: BillingAccessKind,
  role: AuthenticatedUser["role"] = "member",
): AuthenticatedUser {
  return {
    apiKeys: {
      byProvider: {
        gemini: { configured: false, hint: null },
        huggingface: { configured: false, hint: null },
        openai: { configured: false, hint: null },
        xai: { configured: false, hint: null },
      },
      hasAny: false,
    },
    billing: {
      accessKind,
      cancelAtPeriodEnd: false,
      creditBalanceMicros: 0,
      currentPeriodEnd: null,
      hasAccess: accessKind !== "none",
      hasCustomer: false,
      priceId: null,
      status: accessKind === "subscription" ? "active" : "inactive",
      trialCallsLimit: 100,
      trialCallsRemaining: accessKind === "trial" ? 100 : 0,
      trialCallsUsed: 0,
    },
    displayName: "Storage Test",
    email: "storage@example.test",
    id: "storage-user",
    role,
  };
}

describe("workspace storage policy", () => {
  test("allows cloud workspace copies only for paid plans and admins", () => {
    expect(canSyncWorkspaceToCloud(user("subscription"))).toBe(true);
    expect(canSyncWorkspaceToCloud(user("none", "admin"))).toBe(true);
    expect(canSyncWorkspaceToCloud(user("trial"))).toBe(false);
    expect(canSyncWorkspaceToCloud(user("credits"))).toBe(false);

    expect(canUseCloudWorkspaceStorage(user("subscription"))).toBe(true);
    expect(canUseCloudWorkspaceStorage(user("none", "admin"))).toBe(true);
    expect(canUseCloudWorkspaceStorage(user("trial"))).toBe(false);
  });

  test("compares cloud and local state without depending on object key order", () => {
    const state = createEmptyState();
    const reorderedState = {
      ...state,
      conversations: Object.fromEntries(
        Object.entries(state.conversations).reverse(),
      ),
    };

    expect(areWorkspaceStatesEqual(state, reorderedState)).toBe(true);
    expect(
      areWorkspaceStatesEqual(state, {
        ...reorderedState,
        railOpen: !reorderedState.railOpen,
      }),
    ).toBe(false);
  });

  test("round-trips the timestamped local directory record", () => {
    const state = createEmptyState();
    const savedAt = "2026-08-14T14:00:00.000Z";
    const record = createLocalWorkspaceRecord(state, savedAt);

    expect(parseLocalWorkspaceRecord(JSON.parse(JSON.stringify(record)))).toEqual(
      record,
    );
    expect(parseLocalWorkspaceRecord({ savedAt: "not-a-date", state })).toBeNull();
  });

  test("treats network and server outages as recoverable cloud failures", () => {
    expect(isRecoverableCloudSyncError(new TypeError("Failed to fetch"))).toBe(
      true,
    );
    expect(isRecoverableCloudSyncError(new ApiError(503, "Unavailable"))).toBe(
      true,
    );
    expect(isRecoverableCloudSyncError(new ApiError(400, "Invalid state"))).toBe(
      false,
    );
  });
});
