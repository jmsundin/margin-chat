import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "../client/node_modules/react-dom/server";
import ConversationGraphView, {
  getGraphNodesInSelectionBounds,
  getGraphPinchZoomFactor,
} from "../client/src/components/ConversationGraphView";
import {
  buildConversationGraphNodeSpatialIndex,
  buildConversationForestGraphScene,
  buildConversationGraphScene,
  getConversationGraphViewportBounds,
  queryConversationGraphNodeSpatialIndex,
  type ConversationGraphNodePlacement,
} from "../client/src/lib/conversationGraph";
import type { Conversation } from "../client/src/types";

const createdAt = "2026-08-12T00:00:00.000Z";

function createConversation(
  partial: Partial<Conversation> & Pick<Conversation, "id" | "title">,
): Conversation {
  return {
    branchAnchor: null,
    childIds: [],
    createdAt,
    messages: [],
    modelId: "gpt-5",
    parentId: null,
    serviceId: "openai-api",
    updatedAt: createdAt,
    ...partial,
  };
}

const conversations: Record<string, Conversation> = {
  root: createConversation({
    childIds: ["runtime", "privacy"],
    id: "root",
    messages: [
      {
        content: "I need help choosing how to run a model locally.",
        createdAt,
        id: "root-user",
        role: "user",
      },
    ],
    title: "Local AI options",
  }),
  runtime: createConversation({
    branchAnchor: {
      createdAt,
      endOffset: 36,
      id: "runtime-anchor",
      prompt: "Which runtime should I use?",
      quote: "choose a runtime for the hardware you own",
      sourceConversationId: "root",
      sourceMessageId: "root-user",
      startOffset: 0,
    },
    childIds: ["mac"],
    id: "runtime",
    messages: [
      {
        content: "Which runtime fits my Mac?",
        createdAt,
        id: "runtime-user",
        role: "user",
      },
      {
        content: "MLX and Ollama are the most approachable options.",
        createdAt,
        id: "runtime-assistant",
        role: "assistant",
      },
    ],
    parentId: "root",
    title: "Choosing a runtime",
  }),
  privacy: createConversation({
    branchAnchor: {
      createdAt,
      endOffset: 20,
      id: "privacy-anchor",
      prompt: "What stays private?",
      quote: "run the model locally",
      sourceConversationId: "root",
      sourceMessageId: "root-user",
      startOffset: 0,
    },
    id: "privacy",
    parentId: "root",
    title: "Privacy trade-offs",
  }),
  mac: createConversation({
    branchAnchor: {
      createdAt,
      endOffset: 18,
      id: "mac-anchor",
      prompt: "Show me the setup.",
      quote: "Apple Silicon → MLX or Ollama",
      sourceConversationId: "runtime",
      sourceMessageId: "runtime-assistant",
      startOffset: 0,
    },
    id: "mac",
    parentId: "runtime",
    title: "Apple Silicon setup",
  }),
};

describe("conversation graph view", () => {
  test("selects every graph node touched by a marquee", () => {
    const placements = [
      { conversationId: "one", height: 80, width: 120, x: 100, y: 100 },
      { conversationId: "two", height: 80, width: 120, x: 280, y: 110 },
      { conversationId: "three", height: 80, width: 120, x: 520, y: 110 },
    ] as ConversationGraphNodePlacement[];

    expect(
      getGraphNodesInSelectionBounds(placements, {
        height: 100,
        width: 270,
        x: 160,
        y: 90,
      }),
    ).toEqual(["one", "two"]);
  });

  test("moves a root node independently from its tree layout origin", () => {
    const originalScene = buildConversationForestGraphScene({
      conversations,
      selectedConversationId: "root",
      treeLayouts: {
        root: { x: 120, y: 180 },
      },
    });
    const movedScene = buildConversationForestGraphScene({
      conversations,
      selectedConversationId: "root",
      treeLayouts: {
        root: {
          positioned: true,
          treeOriginX: 120,
          treeOriginY: 180,
          x: 740,
          y: 560,
        },
      },
    });
    const originalPrivacy = originalScene.nodes.find(
      (placement) => placement.conversationId === "privacy",
    );
    const movedPrivacy = movedScene.nodes.find(
      (placement) => placement.conversationId === "privacy",
    );
    const movedRoot = movedScene.nodes.find(
      (placement) => placement.conversationId === "root",
    );

    expect(movedRoot).toMatchObject({ x: 740, y: 560 });
    expect(movedPrivacy).toMatchObject({
      x: originalPrivacy?.x,
      y: originalPrivacy?.y,
    });
  });

  test("responds quickly to pinch zoom while limiting a single jump", () => {
    expect(getGraphPinchZoomFactor(-10)).toBeGreaterThan(1.08);
    expect(getGraphPinchZoomFactor(10)).toBeLessThan(0.93);
    expect(getGraphPinchZoomFactor(-1000)).toBe(1.28);
    expect(getGraphPinchZoomFactor(1000)).toBeCloseTo(1 / 1.28);
  });

  test("renders standalone notes as movable graph nodes without chat-only actions", () => {
    const note = createConversation({
      id: "note-root",
      kind: "note",
      notes: [
        {
          content: "# Research\n\nCompare layout approaches.",
          createdAt,
          endOffset: null,
          id: "note-body",
          kind: "standalone",
          quote: null,
          sourceMessageId: null,
          startOffset: null,
          updatedAt: createdAt,
        },
      ],
      title: "Layout research",
    });
    const markup = renderToStaticMarkup(
      <ConversationGraphView
        activeConversationId={note.id}
        conversations={{ [note.id]: note }}
        graphLayouts={{
          [note.id]: { height: 640, width: 520, x: 280, y: 220 },
        }}
        groups={{}}
        onActivateConversation={() => {}}
        onAssignGroup={() => {}}
        onCreateChildConversation={() => null}
        onOpenConversation={() => {}}
        onToggleGroup={() => {}}
        renderExpandedConversation={() => null}
      />,
    );

    expect(markup).toContain("conversation-graph-node is-note");
    expect(markup).toContain("Move Layout research");
    expect(markup).toContain("Standalone workspace note");
    expect(markup).not.toContain("Add child chat to Layout research");
  });

  test("places every root chat tree together using its saved coordinates", () => {
    const forestConversations: Record<string, Conversation> = {
      ...conversations,
      secondRoot: createConversation({
        childIds: ["secondChild"],
        createdAt: "2026-08-13T00:00:00.000Z",
        id: "secondRoot",
        title: "Second discussion",
      }),
      secondChild: createConversation({
        createdAt: "2026-08-13T01:00:00.000Z",
        id: "secondChild",
        parentId: "secondRoot",
        title: "Second child",
      }),
    };
    const scene = buildConversationForestGraphScene({
      conversations: forestConversations,
      selectedConversationId: "runtime",
      treeLayouts: {
        root: { x: 120, y: 180 },
        runtime: { positioned: true, x: 920, y: 420 },
        secondRoot: { x: 1600, y: 980 },
      },
    });
    const firstRoot = scene.nodes.find(
      (placement) => placement.conversationId === "root",
    );
    const secondRoot = scene.nodes.find(
      (placement) => placement.conversationId === "secondRoot",
    );
    const positionedChild = scene.nodes.find(
      (placement) => placement.conversationId === "runtime",
    );
    const positionedEdge = scene.edges.find(
      (edge) => edge.childConversationId === "runtime",
    );

    expect(scene.nodes).toHaveLength(6);
    expect(scene.edges).toHaveLength(4);
    expect(firstRoot).toMatchObject({ x: 120, y: 180 });
    expect(secondRoot).toMatchObject({ x: 1600, y: 980 });
    expect(positionedChild).toMatchObject({ x: 920, y: 420 });
    expect(positionedEdge).toMatchObject({ endX: 920, endY: 464 });
    expect(scene.width).toBeGreaterThan(1600);
    expect(scene.height).toBeGreaterThan(980);

    const markup = renderToStaticMarkup(
      <ConversationGraphView
        activeConversationId="runtime"
        conversations={forestConversations}
        graphLayouts={{
          root: { height: 640, width: 520, x: 120, y: 180 },
          secondRoot: { height: 640, width: 520, x: 1600, y: 980 },
        }}
        groups={{}}
        onActivateConversation={() => {}}
        onAssignGroup={() => {}}
        onCreateChildConversation={() => null}
        onOpenConversation={() => {}}
        onToggleGroup={() => {}}
      />,
    );

    expect(markup).toContain('data-scene-node-count="6"');
    expect(markup).toContain('data-conversation-id="root"');
    expect(markup).toContain('data-conversation-id="secondRoot"');
    expect(markup).toContain("Move Choosing a runtime");
    expect(markup).toContain("Auto-arrange graph with ELK");
  });

  test("queries only nodes inside the viewport overscan area", () => {
    const placements: ConversationGraphNodePlacement[] = [
      {
        conversationId: "far-left",
        depth: 0,
        height: 80,
        width: 180,
        x: 600,
        y: 500,
      },
      {
        conversationId: "just-outside",
        depth: 1,
        height: 80,
        width: 180,
        x: 850,
        y: 500,
      },
      {
        conversationId: "visible",
        depth: 2,
        height: 80,
        width: 180,
        x: 1200,
        y: 500,
      },
      {
        conversationId: "far-right",
        depth: 3,
        height: 80,
        width: 180,
        x: 2100,
        y: 500,
      },
    ];
    const bounds = getConversationGraphViewportBounds({
      overscan: 100,
      viewport: { scale: 1, x: -1000, y: 0 },
      viewportSize: { height: 600, width: 800 },
    });
    const visiblePlacements = queryConversationGraphNodeSpatialIndex(
      buildConversationGraphNodeSpatialIndex(placements, 200),
      bounds,
    );

    expect(visiblePlacements.map((placement) => placement.conversationId)).toEqual([
      "just-outside",
      "visible",
    ]);
  });

  test("keeps a large graph in the scene while mounting only nearby nodes", () => {
    const childIds = Array.from(
      { length: 1000 },
      (_, index) => `child-${index}`,
    );
    const largeConversations: Record<string, Conversation> = {
      root: createConversation({
        childIds,
        id: "root",
        title: "Large discussion",
      }),
    };

    for (const childId of childIds) {
      largeConversations[childId] = createConversation({
        id: childId,
        parentId: "root",
        title: childId,
      });
    }

    const markup = renderToStaticMarkup(
      <ConversationGraphView
        activeConversationId="root"
        conversations={largeConversations}
        groups={{}}
        onActivateConversation={() => {}}
        onAssignGroup={() => {}}
        onCreateChildConversation={() => null}
        onOpenConversation={() => {}}
        onToggleGroup={() => {}}
      />,
    );
    const renderedCount = Number(
      markup.match(/data-rendered-node-count="(\d+)"/)?.[1] ?? 0,
    );
    const renderedEdgeCount = Number(
      markup.match(/data-rendered-edge-count="(\d+)"/)?.[1] ?? 0,
    );

    expect(markup).toContain('data-scene-node-count="1001"');
    expect(renderedCount).toBeGreaterThan(0);
    expect(renderedCount).toBeLessThan(40);
    expect(renderedEdgeCount).toBeLessThanOrEqual(renderedCount);
    expect((markup.match(/data-conversation-id=/g) ?? []).length).toBe(
      renderedCount,
    );
    expect(
      (markup.match(/class="conversation-graph-minimap-node/g) ?? []).length,
    ).toBeLessThanOrEqual(281);
    expect(
      (markup.match(/class="conversation-graph-minimap-edge/g) ?? []).length,
    ).toBeLessThanOrEqual(320);
  });

  test("shows every ancestor of the active node as a clickable breadcrumb", () => {
    const deepConversations: Record<string, Conversation> = {
      ...conversations,
      mac: {
        ...conversations.mac,
        childIds: ["install"],
      },
      install: createConversation({
        id: "install",
        parentId: "mac",
        title: "Install the runtime",
      }),
    };
    const markup = renderToStaticMarkup(
      <ConversationGraphView
        activeConversationId="install"
        conversations={deepConversations}
        groups={{}}
        onActivateConversation={() => {}}
        onAssignGroup={() => {}}
        onCreateChildConversation={() => null}
        onOpenConversation={() => {}}
        onToggleGroup={() => {}}
      />,
    );
    const breadcrumbIds = ["root", "runtime", "mac", "install"];
    const positions = breadcrumbIds.map((conversationId) =>
      markup.indexOf(
        `data-breadcrumb-conversation-id="${conversationId}"`,
      ),
    );

    expect(markup).toContain('aria-label="Graph node hierarchy"');
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(markup).toContain('aria-current="page"');
  });

  test("starts as a complete overview without an explicit mode switch", () => {
    const markup = renderToStaticMarkup(
      <ConversationGraphView
        activeConversationId="runtime"
        conversations={conversations}
        groups={{}}
        onActivateConversation={() => {}}
        onAssignGroup={() => {}}
        onCreateChildConversation={() => null}
        onOpenConversation={() => {}}
        onToggleGroup={() => {}}
      />,
    );

    expect(markup).toContain("Click a chat for a preview");
    expect(markup).toContain('aria-label="Select multiple chats"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain("conversation-graph-header");
    expect(markup).not.toContain("conversation-graph-toolbar");
    expect(markup).not.toContain("conversation-graph-source-list");
    expect(markup).not.toContain("Focused neighborhood");
    expect(markup).not.toContain("Graph detail");
    expect(markup).toContain('data-conversation-id="root"');
    expect(markup).toContain('data-conversation-id="runtime"');
    expect(markup).toContain('data-conversation-id="privacy"');
    expect(markup).toContain('data-conversation-id="mac"');
    expect(markup).toContain("Apple Silicon → MLX or Ollama");
    expect(markup).toContain("Current main");
    expect(markup).toContain("choose a runtime for the hardware you own");
    expect(markup).toContain("Add child chat to Choosing a runtime");
    expect(markup).toContain("Dock Choosing a runtime in split view");
    expect(markup).toContain("Open Choosing a runtime in chat view");
  });

  test("grows a selected node progressively while edges stay on its outer edge", () => {
    const previewScene = buildConversationGraphScene({
      conversations,
      detailLevel: "preview",
      mode: "overview",
      selectedConversationId: "runtime",
    });
    const readerScene = buildConversationGraphScene({
      conversations,
      detailLevel: "reader",
      mode: "overview",
      selectedConversationId: "runtime",
    });
    const previewPlacement = previewScene.nodes.find(
      (node) => node.conversationId === "runtime",
    );
    const readerPlacement = readerScene.nodes.find(
      (node) => node.conversationId === "runtime",
    );
    const previewMacEdge = previewScene.edges.find(
      (edge) => edge.childConversationId === "mac",
    );
    const readerMacEdge = readerScene.edges.find(
      (edge) => edge.childConversationId === "mac",
    );

    expect(previewPlacement?.width).toBe(330);
    expect(readerPlacement?.width).toBe(430);
    expect(readerPlacement!.height).toBeGreaterThan(previewPlacement!.height);
    expect(previewMacEdge?.startX).toBe(
      previewPlacement!.x + previewPlacement!.width,
    );
    expect(previewMacEdge?.startY).toBe(
      previewPlacement!.y + previewPlacement!.height / 2,
    );
    expect(readerMacEdge?.startX).toBe(
      readerPlacement!.x + readerPlacement!.width,
    );
    expect(readerMacEdge?.startY).toBe(
      readerPlacement!.y + readerPlacement!.height / 2,
    );
  });

  test("keeps sibling branches in focus and the full thread in overview", () => {
    const focusScene = buildConversationGraphScene({
      conversations,
      mode: "focus",
      selectedConversationId: "runtime",
    });
    const overviewScene = buildConversationGraphScene({
      conversations,
      mode: "overview",
      selectedConversationId: "runtime",
    });

    expect(
      focusScene.nodes.map((node) => node.conversationId).sort(),
    ).toEqual(["mac", "privacy", "root", "runtime"]);
    expect(overviewScene.nodes).toHaveLength(4);
    expect(overviewScene.edges).toHaveLength(3);
    expect(
      overviewScene.nodes.every(
        (node) => node.height >= 96 && node.width >= 200,
      ),
    ).toBe(true);
  });

  test("uses semantic zoom dimensions and builds group territories", () => {
    const groups = {
      learning: {
        collapsed: false,
        color: "#4fbf9f",
        conversationIds: ["root", "runtime", "mac"],
        id: "learning",
        name: "Learning",
      },
    };
    const territoryScene = buildConversationGraphScene({
      conversations,
      groups,
      mode: "overview",
      selectedConversationId: "runtime",
      semanticLevel: "territory",
    });
    const detailScene = buildConversationGraphScene({
      conversations,
      groups,
      mode: "overview",
      selectedConversationId: "runtime",
      semanticLevel: "detail",
    });

    expect(territoryScene.groups).toHaveLength(1);
    expect(territoryScene.groups[0].conversationIds).toEqual([
      "root",
      "runtime",
      "mac",
    ]);
    expect(detailScene.nodes.find((node) => node.conversationId === "root")!.width)
      .toBeGreaterThan(
        territoryScene.nodes.find((node) => node.conversationId === "root")!
          .width,
      );
  });

  test("renders explicitly collapsed groups as aggregate graph nodes", () => {
    const markup = renderToStaticMarkup(
      <ConversationGraphView
        activeConversationId="runtime"
        conversations={conversations}
        groups={{
          learning: {
            collapsed: true,
            color: "#4fbf9f",
            conversationIds: ["root", "runtime", "mac"],
            id: "learning",
            name: "Learning",
          },
        }}
        onActivateConversation={() => {}}
        onAssignGroup={() => {}}
        onCreateChildConversation={() => null}
        onOpenConversation={() => {}}
        onToggleGroup={() => {}}
      />,
    );

    expect(markup).toContain("Group · 3 chats");
    expect(markup).toContain("Learning");
    expect(markup).not.toContain('data-conversation-id="root"');
    expect(markup).toContain('data-conversation-id="privacy"');
  });
});
