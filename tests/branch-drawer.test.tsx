import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "../client/node_modules/react-dom/server";
import BranchRail from "../client/src/components/BranchRail";
import type { Conversation } from "../client/src/types";

function createConversation(
  id: string,
  title: string,
  parentId: string | null,
): Conversation {
  const createdAt = "2026-08-11T00:00:00.000Z";

  return {
    branchAnchor: parentId
      ? {
          createdAt,
          endOffset: 12,
          id: `anchor-${id}`,
          prompt: `Explore ${title}`,
          quote: `Source for ${title}`,
          sourceConversationId: parentId,
          sourceMessageId: `message-${parentId}`,
          startOffset: 0,
        }
      : null,
    childIds: [],
    createdAt,
    id,
    messages: [],
    modelId: "gpt-5",
    parentId,
    serviceId: "openai-api",
    title,
    updatedAt: createdAt,
  };
}

describe("branch drawer", () => {
  const root = createConversation("root", "Launch planning", null);
  const child = createConversation("child", "Priority ordering", root.id);
  root.childIds = [child.id];
  const conversations = { [root.id]: root, [child.id]: child };

  test("renders no persistent rail when closed", () => {
    const markup = renderToStaticMarkup(
      <BranchRail
        activeConversationId={root.id}
        conversations={conversations}
        onClose={() => {}}
        onSelectConversation={() => {}}
        open={false}
        registerTabRef={() => {}}
        rootId={root.id}
      />,
    );

    expect(markup).toBe("");
  });

  test("renders a conversation mini-map with the full branch tree", () => {
    const markup = renderToStaticMarkup(
      <BranchRail
        activeConversationId={root.id}
        conversations={conversations}
        onClose={() => {}}
        onSelectConversation={() => {}}
        open
        registerTabRef={() => {}}
        rootId={root.id}
      />,
    );

    expect(markup).toContain('aria-label="Conversation map"');
    expect(markup).toContain('class="branch-map"');
    expect(markup).toContain("Launch planning");
    expect(markup).toContain("Priority ordering");
    expect(markup).not.toContain('role="dialog"');
  });
});
