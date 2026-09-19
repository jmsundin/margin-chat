import { describe, expect, test } from "bun:test";
import { buildChatOutline, groupChatOutline } from "../client/src/lib/chatOutline";
import type { Conversation } from "../client/src/types";

function createConversation(): Conversation {
  const createdAt = "2026-08-12T00:00:00.000Z";

  return {
    branchAnchor: null,
    childIds: [],
    createdAt,
    id: "conversation",
    messages: [
      {
        content: "How should we launch the new workspace?",
        createdAt,
        id: "user-1",
        role: "user",
      },
      {
        content: "# Launch plan\nIntro.\n## First week\nDetails.",
        createdAt,
        id: "assistant-1",
        role: "assistant",
      },
    ],
    modelId: "gpt-5",
    parentId: null,
    serviceId: "openai-api",
    title: "Launch planning",
    updatedAt: createdAt,
  };
}

describe("chat outline", () => {
  test("uses user turns as sections and nests assistant headings", () => {
    expect(buildChatOutline(createConversation())).toEqual([
      {
        id: "message-user-1",
        kind: "prompt",
        label: "How should we launch the new workspace?",
        level: 0,
        messageId: "user-1",
      },
      {
        id: "message-assistant-1",
        kind: "response",
        label: "AI response 1",
        level: 0,
        messageId: "assistant-1",
      },
      {
        id: "heading-assistant-1-0",
        kind: "heading",
        label: "Launch plan",
        level: 1,
        messageId: "assistant-1",
      },
      {
        id: "heading-assistant-1-1",
        kind: "heading",
        label: "First week",
        level: 2,
        messageId: "assistant-1",
      },
    ]);
  });
});


test("every assistant response stays reachable, including heading-free replies and consecutive retries", () => {
  const conversation = createConversation();
  conversation.messages.push(
    { id: "assistant-2", role: "assistant", content: "A simpler alternative.", createdAt: conversation.createdAt },
    { id: "user-2", role: "user", content: "What should happen next?", createdAt: conversation.createdAt },
    { id: "assistant-3", role: "assistant", content: "", createdAt: conversation.createdAt },
  );
  const outline = buildChatOutline(conversation);
  expect(outline.filter((item) => item.kind === "response").map((item) => [item.id, item.label])).toEqual([
    ["message-assistant-1", "AI response 1"], ["message-assistant-2", "AI response 2"], ["message-assistant-3", "AI response 3"],
  ]);
  const sections = groupChatOutline(outline);
  expect(sections.map((section) => section.prompt?.messageId)).toEqual(["user-1", "user-2"]);
  expect(sections.map((section) => section.responses.map((response) => response.item.messageId))).toEqual([["assistant-1", "assistant-2"], ["assistant-3"]]);
  expect(sections[0].responses[0].headings.map((item) => item.id)).toEqual(["heading-assistant-1-0", "heading-assistant-1-1"]);
});

test("heading IDs follow rendered Markdown rather than code examples", () => {
  const conversation = createConversation();
  conversation.messages[1].content = "# Real heading\n\n```markdown\n## Not a heading\n```\n\nSetext heading\n--------------\n\n> ### Nested heading\n\n#### Omitted depth\n\n### Last heading";
  expect(buildChatOutline(conversation).filter((item) => item.kind === "heading").map(({ id, label, level }) => ({ id, label, level }))).toEqual([
    { id: "heading-assistant-1-0", label: "Real heading", level: 1 },
    { id: "heading-assistant-1-1", label: "Setext heading", level: 2 },
    { id: "heading-assistant-1-2", label: "Nested heading", level: 3 },
    { id: "heading-assistant-1-3", label: "Last heading", level: 3 },
  ]);
});

test("headings-only inputs and orphan responses keep their navigation targets", () => {
  const headings = buildChatOutline(createConversation()).filter((item) => item.kind === "heading");
  const legacy = groupChatOutline(headings);
  expect(legacy[0].prompt).toBeNull();
  expect(legacy[0].responses).toEqual([]);
  expect(legacy[0].headings).toEqual(headings);
  const conversation = createConversation();
  conversation.messages = conversation.messages.slice(1);
  const orphan = groupChatOutline(buildChatOutline(conversation));
  expect(orphan[0].prompt).toBeNull();
  expect(orphan[0].responses[0].headings).toEqual(headings);
});

test("grouped outline navigation and heading disclosure remain independent", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/chatOutlineHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Chat outline regression failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(4);
}, 15000);
