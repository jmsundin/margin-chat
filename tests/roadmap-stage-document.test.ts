import { describe, expect, test } from "bun:test";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { applyRoadmapChange } from "../client/src/lib/roadmap";
import { buildMapPath, createMapPath } from "../client/src/lib/mapPaths";
import { isStageDocumentId, missingLessonLines, stageDocumentId, stageDocumentMarkdown } from "../client/src/lib/roadmapStageDocument";
import { searchLocalVault } from "../client/src/lib/vaultSearch";

const at = "2026-11-17T23:00:00.000Z";

function course() {
  let state = createEmptyState();
  for (const [title, text] of [["Python Basics", "# Python Basics\n\nVariables, loops and functions."], ["Web Concepts", ""], ["Docker", "Containers package an app."]]) {
    const id = title.toLowerCase().replace(/\W+/g, "-");
    const note = createStandaloneNoteConversation({ createdAt: at, id, noteId: `${id}-note` });
    note.title = title;
    note.notes![0].content = text;
    state.conversations[id] = note;
  }
  state = createMapPath(state, { id: "path", noteId: "path-note", title: "FastAPI", createdAt: at, stageId: "s1", stageTitle: "Start here",
    docIds: ["python-basics", "web-concepts"], nodeIds: ["n1", "n2"] });
  state = applyRoadmapChange(state, "path", { kind: "add-stage", title: "Ship it", stageId: "s2" }, at).state;
  state = applyRoadmapChange(state, "path", { kind: "add-node", stageId: "s2", target: { docId: "docker" }, nodeId: "n3" }, at).state;
  return state;
}

describe("a roadmap stage opens as a document", () => {
  test("its index says where the stage sits and links every lesson, with what each covers", () => {
    const state = course();
    const path = buildMapPath(state.conversations.path, state.conversations);
    expect(stageDocumentMarkdown(path, "s1", state.conversations)).toBe([
      "Stage 1 of 2 in [[FastAPI]] · 0 of 2 done",
      "",
      "- [[Python Basics]]: Variables, loops and functions.",
      "- [[Web Concepts]]",
      "",
    ].join("\n"));
    expect(stageDocumentMarkdown(path, "s2", state.conversations)).toContain("Stage 2 of 2");
  });

  test("the same stage always has the same document, which can be told apart", () => {
    expect(stageDocumentId("path", "s1")).toBe(stageDocumentId("path", "s1"));
    expect(stageDocumentId("path", "s1")).not.toBe(stageDocumentId("path", "s2"));
    expect(isStageDocumentId(stageDocumentId("path", "s1"))).toBe(true);
    expect(isStageDocumentId("note-conversation-1")).toBe(false);
  });

  test("lessons added to the stage later are the only lines added", () => {
    const state = course();
    const path = buildMapPath(state.conversations.path, state.conversations);
    const written = "My own intro.\n\n- [[Python Basics]]: my words\n";
    expect(missingLessonLines(path, "s1", written, state.conversations)).toEqual(["- [[Web Concepts]]"]);
    expect(missingLessonLines(path, "s1", stageDocumentMarkdown(path, "s1", state.conversations), state.conversations)).toEqual([]);
  });
});

describe("the Roadmaps search filter", () => {
  test("finds roadmaps, their lessons and their stage documents, and nothing else", () => {
    const state = course();
    const outside = createStandaloneNoteConversation({ createdAt: at, id: "other", noteId: "other-note" });
    outside.title = "Docker at home";
    state.conversations.other = outside;
    const stage = createStandaloneNoteConversation({ createdAt: at, id: stageDocumentId("path", "s2"), noteId: "stage-note" });
    stage.title = "Ship it";
    stage.parentId = "path";
    state.conversations[stage.id] = stage;
    const ids = (query: string) => searchLocalVault({ query, scope: "roadmaps" }, { conversations: state.conversations })
      .documents.map((hit) => hit.target.kind === "loaded" ? hit.target.conversationId : hit.target.path).sort();
    expect(ids("docker")).toEqual(["docker"]);
    expect(ids("ship")).toEqual([stageDocumentId("path", "s2")]);
    expect(ids("fastapi")).toEqual(["path"]);
    expect(searchLocalVault({ query: "docker", scope: "all" }, { conversations: state.conversations }).documents.length).toBe(2);
  });
});
