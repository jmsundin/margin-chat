import { describe, expect, test } from "bun:test";
import {
  fromWorkspaceEntityId,
  toWorkspaceEntityId,
} from "../server/db/repository.mjs";

describe("cloud workspace entity IDs", () => {
  test("scopes identical client IDs to their workspace", () => {
    const first = toWorkspaceEntityId("workspace-user-a", "conversation-root");
    const second = toWorkspaceEntityId("workspace-user-b", "conversation-root");

    expect(first).not.toBe(second);
    expect(fromWorkspaceEntityId("workspace-user-a", first)).toBe(
      "conversation-root",
    );
    expect(fromWorkspaceEntityId("workspace-user-b", second)).toBe(
      "conversation-root",
    );
  });

  test("keeps legacy unscoped IDs readable until the next save", () => {
    expect(
      fromWorkspaceEntityId("workspace-user-a", "legacy-conversation"),
    ).toBe("legacy-conversation");
  });
});
