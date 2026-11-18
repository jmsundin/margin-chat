import { createHash, randomUUID } from "node:crypto";
import {
  ROADMAP_NODE_TYPE,
  ROADMAP_STATUSES,
  ROADMAP_VERSION,
  createMarkdownWorkspace,
  discoverMarkdownWorkspace,
  normalizeRoadmap,
  parseMarkdownWorkspace,
  renderFrontmatterEntry,
  setFrontmatterEntries,
} from "@margin-chat/workspace-contracts";
import { agentActor } from "./writeTools.mjs";

/**
 * Roadmaps from connected apps. An app (Claude in Chrome, Gemini, Muse) reads a course or
 * certification page and sends the outline it found: stages, and steps in each stage.
 * The roadmap is an ordinary app document marked as a roadmap, and each step gets its own
 * document under it holding the app's notes and a link back to the lesson, the same shape
 * Draft with AI makes. Files are rendered by the app's own Markdown codec, so the app opens
 * them exactly like its own. Agents only add: steps and stages are never removed or changed.
 */

const MAX_STAGES = 50;
const MAX_STEPS = 300;
const MAX_NOTES = 20_000;
const MAX_TOTAL = 200_000;
const TITLE = 200;
const ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DEFAULT_SERVICE_ID = "backend-services";
const DEFAULT_MODEL_ID = "smart-routing";

const STEP_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "The lesson or topic, as the page names it." },
    notes: { type: "string", description: "Optional study notes in Markdown: what the lesson covers, key points, terms to know. Leave out to have Margin Chat explain the step when it is opened." },
    source_url: { type: "string", description: "Optional link to this lesson on the original site." },
    key: { type: "string", description: "Optional short label for this step, unique in the call, so other steps can name it in needs." },
    needs: { type: "array", items: { type: "string" }, description: "Optional steps that must come first: keys of steps in this call, or step_id values from read_roadmap. Order within stages already reads as a sequence; use this only for real prerequisites." },
    optional: { type: "boolean", description: "True for an optional or bonus lesson." },
  },
  required: ["title"],
  additionalProperties: false,
};

export const ROADMAP_TOOL_DEFINITIONS = [
  {
    name: "create_roadmap",
    title: "Create roadmap",
    description: [
      "Create a study roadmap in the user's Margin Chat vault from a course, certification path, syllabus or any page you have read.",
      "Send the outline you found: stages (modules, sections) in order, and the steps (lessons, topics) in each, in order.",
      "Each step becomes its own document under the roadmap with your notes and a link back to the lesson; the user tracks progress in Margin Chat's Learn view.",
      "Write titles and notes in the page's language. Give source_url so the same page isn't made into a roadmap twice: if it already was, you get that roadmap's document_id to read with read_roadmap and extend with add_to_roadmap.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The roadmap's name, such as the course or certification title." },
        goal: { type: "string", description: "Optional Markdown for the roadmap's own page: what it prepares for, who offers it, how it is assessed." },
        source_url: { type: "string", description: "The page the outline came from." },
        parent_document_id: { type: "string", description: "Optional existing document_id (from search_vault) the roadmap is part of." },
        stages: {
          type: "array",
          description: "Stages in order, each with its steps in order.",
          items: {
            type: "object",
            properties: { title: { type: "string" }, steps: { type: "array", items: STEP_SCHEMA } },
            required: ["title", "steps"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "stages"],
      additionalProperties: false,
    },
    annotations: ADDITIVE,
  },
  {
    name: "read_roadmap",
    title: "Read roadmap",
    description: "Read a roadmap in the user's Margin Chat vault: its stages and steps in order, each step's step_id, document_id, progress (not-started, learning, done, skipped) and prerequisites. Also tells you whether a page already has a roadmap: give the page's link instead of an id.",
    inputSchema: {
      type: "object",
      properties: {
        roadmap: { type: "string", description: "The roadmap's document_id, or the link of the page it was made from with create_roadmap." },
      },
      required: ["roadmap"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "add_to_roadmap",
    title: "Add to roadmap",
    description: "Add steps or stages to an existing roadmap, for example lessons a course added since. Read it with read_roadmap first so you don't add steps it already has. A stage with stage_id adds to that existing stage; one without becomes a new stage at the end. Existing steps and their progress are never changed.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "The roadmap's document_id." },
        stages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              stage_id: { type: "string", description: "An existing stage's stage_id from read_roadmap, to add steps to it." },
              title: { type: "string", description: "A new stage's title (ignored when stage_id is given)." },
              steps: { type: "array", items: STEP_SCHEMA },
            },
            required: ["steps"],
            additionalProperties: false,
          },
        },
      },
      required: ["document_id", "stages"],
      additionalProperties: false,
    },
    annotations: ADDITIVE,
  },
];

export const ROADMAP_TOOL_NAMES = new Set(ROADMAP_TOOL_DEFINITIONS.map((tool) => tool.name));
/** Any token may read a roadmap; making and extending one needs a write token. */
export const ROADMAP_READ_DEFINITION = ROADMAP_TOOL_DEFINITIONS.find((tool) => tool.name === "read_roadmap");
export const ROADMAP_WRITE_DEFINITIONS = ROADMAP_TOOL_DEFINITIONS.filter((tool) => tool.name !== "read_roadmap");

const fail = (error) => ({ ok: false, error });
const line = (value, max = TITLE) => typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "";

/** A link the roadmap can be found by again: scheme and host lower-cased, no fragment or trailing slash. */
export function normalizeSourceUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/u, "")}${url.search}`;
  } catch {
    return null;
  }
}

/** One roadmap per page: its document id comes from the page's link. */
export function roadmapIdForSource(url) {
  return `mcp-roadmap-${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
}

function markdownLink(label, url) {
  return `[${label.replace(/[[\]]/gu, "")}](${url.replace(/[()\s]/gu, (char) => encodeURIComponent(char))})`;
}

/** Validated steps of one call: their text, plus the order needs resolve in. */
function readStages(input, { existingStages = null } = {}) {
  if (!Array.isArray(input) || !input.length) return fail("Send at least one stage with steps.");
  if (input.length > MAX_STAGES) return fail(`A roadmap call can carry at most ${MAX_STAGES} stages.`);
  const stages = [];
  const keys = new Set();
  let steps = 0;
  let characters = 0;
  for (const [index, stage] of input.entries()) {
    const stageId = typeof stage?.stage_id === "string" ? stage.stage_id : null;
    if (stageId && !existingStages?.has(stageId)) return fail(`The roadmap has no stage with stage_id ${stageId}. Read it with read_roadmap.`);
    const title = stageId ? existingStages.get(stageId) : line(stage?.title) || `Stage ${index + 1}`;
    const items = [];
    for (const step of Array.isArray(stage?.steps) ? stage.steps : []) {
      const stepTitle = line(step?.title);
      if (!stepTitle) return fail("Every step needs a title.");
      const notes = typeof step.notes === "string" ? step.notes.trim() : "";
      if (notes.length > MAX_NOTES) return fail(`Keep each step's notes under ${MAX_NOTES} characters.`);
      characters += notes.length + stepTitle.length;
      const key = typeof step.key === "string" && step.key.trim() ? step.key.trim() : null;
      if (key && keys.has(key)) return fail(`Two steps share the key "${key}". Keys must be unique.`);
      if (key) keys.add(key);
      const sourceUrl = step.source_url === undefined ? null : normalizeSourceUrl(step.source_url);
      if (step.source_url !== undefined && !sourceUrl) return fail(`"${stepTitle}" has a source_url that isn't a web link.`);
      items.push({ title: stepTitle, notes, sourceUrl, key, needs: Array.isArray(step.needs) ? step.needs.filter((need) => typeof need === "string") : [],
        optional: step.optional === true });
    }
    steps += items.length;
    if (items.length) stages.push({ stageId, title, steps: items });
  }
  if (!steps) return fail("Send at least one step.");
  if (steps > MAX_STEPS) return fail(`A roadmap call can carry at most ${MAX_STEPS} steps. Send the rest with add_to_roadmap.`);
  if (characters > MAX_TOTAL) return fail(`That outline is over ${MAX_TOTAL} characters. Send shorter notes, or the rest with add_to_roadmap.`);
  return { ok: true, stages };
}

function stepBody(step) {
  const parts = [step.notes || ""];
  if (step.sourceUrl) parts.push(`Source: ${markdownLink(step.title, step.sourceUrl)}`);
  return parts.filter(Boolean).join("\n\n") || step.title;
}

function aiDocument(blockId, content, at) {
  return { schemaVersion: 1, blocks: [{ id: blockId, kind: "markdown", content, createdAt: at, updatedAt: at, authorship: "ai" }], prompts: [], generations: [] };
}

function miniState(conversations, rootId, preferences) {
  return {
    rootId, activeConversationId: rootId,
    defaultServiceId: preferences.serviceId, defaultModelId: preferences.modelId,
    graphLayouts: {}, groups: {}, railOpen: false, pinnedThreadIds: [], conversations,
  };
}

export function createRoadmapTools({ userId, vault, agentName, agentId, quotaBytes, now = () => new Date(), createId = randomUUID }) {
  const actor = agentActor({ agentId, agentName });
  const entries = async () => (await vault.index(userId)).entries;
  const readText = async (entry) => (await vault.readFile({ userId, path: entry.path, revision: entry.revision })).bytes.toString("utf8");

  async function preferences() {
    try {
      const { bytes } = await vault.readFile({ userId, path: "workspace.json" });
      const prefs = JSON.parse(bytes.toString("utf8"))?.workspace?.preferences ?? {};
      return { serviceId: prefs.defaultServiceId || DEFAULT_SERVICE_ID, modelId: prefs.defaultModelId || DEFAULT_MODEL_ID };
    } catch {
      return { serviceId: DEFAULT_SERVICE_ID, modelId: DEFAULT_MODEL_ID };
    }
  }

  async function commit(changes) {
    try {
      const receipt = await vault.commit(userId, changes, { quotaBytes,
        authorship: { wait: true, actor, source: "mcp", authorFor: () => actor } });
      return { ...(receipt?.projection && receipt.projection.status !== "ready" ? { projection: "pending" } : {}) };
    } catch (error) {
      if (error?.statusCode === 409) return fail("The roadmap changed on another device just now. Read it again, then retry.");
      if (error?.statusCode === 413) return fail(error.message);
      throw error;
    }
  }

  /**
   * The roadmap with the documents its file links to (parent, children, notes, linked
   * documents), parsed by the app's codec: enough to re-render its file without losing a link.
   */
  async function loadRoadmap(id, listed) {
    const entry = listed.find((candidate) => candidate.id === id && candidate.type === "conversation");
    if (!entry || entry.hiddenFromAI) return { error: fail("No roadmap has that id.") };
    const near = listed.filter((candidate) => candidate.path === entry.parentPath || candidate.parentPath === entry.path
      || (entry.linkedPaths ?? []).includes(candidate.path));
    const files = {};
    for (const item of [entry, ...near]) files[item.path] = await readText(item);
    let workspace;
    let state;
    try {
      workspace = discoverMarkdownWorkspace(files);
      state = parseMarkdownWorkspace(workspace.manifest, workspace.files);
    } catch {
      state = null;
    }
    const conversation = state?.conversations?.[id];
    if (!conversation) return { error: fail("That roadmap couldn't be read.") };
    if (conversation.nodeType !== ROADMAP_NODE_TYPE || !normalizeRoadmap(conversation.roadmap)) {
      return { error: fail("That document isn't a roadmap. Create one with create_roadmap.") };
    }
    return { entry, files, workspace, state, conversation, roadmap: normalizeRoadmap(conversation.roadmap) };
  }

  function outline(conversation, roadmap, state, listed) {
    const titles = new Map(listed.map((entry) => [entry.id, entry.title]));
    const hidden = new Set(listed.filter((entry) => entry.hiddenFromAI).map((entry) => entry.id));
    const nodeByDoc = new Map(roadmap.nodes.map((node) => [node.target.docId, node.id]));
    return {
      document_id: conversation.id,
      title: conversation.title,
      stages: roadmap.stages.map((stage) => ({
        stage_id: stage.id, title: stage.title,
        steps: roadmap.nodes.filter((node) => node.stage === stage.id).sort((a, b) => a.order - b.order).map((node) => {
          const target = state.conversations[node.target.docId];
          // Whole-document prerequisites are depends-on relations on the step's document.
          const related = (target?.relations ?? []).filter((relation) => relation.type === "depends-on")
            .map((relation) => nodeByDoc.get(relation.targetConversationId)).filter(Boolean);
          return {
            step_id: node.id,
            title: hidden.has(node.target.docId) ? "Hidden document" : node.title ?? titles.get(node.target.docId) ?? "Untitled",
            document_id: node.target.docId,
            status: node.status ?? "not-started",
            ...(node.optional ? { optional: true } : {}),
            needs: [...new Set([...(node.dependsOn ?? []), ...related])],
          };
        }),
      })),
    };
  }

  /** New step documents under the roadmap, and roadmap nodes pointing at them, for parsed stages. */
  function buildSteps(stages, roadmap, roadmapId, prefs, at) {
    const conversations = {};
    const childIds = [];
    const nextStages = [...roadmap.stages];
    const nodes = [...roadmap.nodes];
    const existingNodeIds = new Set(roadmap.nodes.map((node) => node.id));
    const byKey = new Map();
    const pending = [];
    for (const stage of stages) {
      let stageId = stage.stageId;
      if (!stageId) {
        stageId = `stage-${createId()}`;
        nextStages.push({ id: stageId, title: stage.title });
      }
      let order = Math.max(-1, ...nodes.filter((node) => node.stage === stageId).map((node) => node.order)) + 1;
      for (const step of stage.steps) {
        const docId = `mcp-${createId()}`;
        const nodeId = `node-${createId()}`;
        conversations[docId] = {
          id: docId, kind: "chat", title: step.title, parentId: roadmapId,
          serviceId: prefs.serviceId, modelId: prefs.modelId, branchAnchor: null,
          childIds: [], documents: [], messages: [], notes: [], createdAt: at, updatedAt: at,
          document: aiDocument(`mcp-block-${createId()}`, stepBody(step), at),
        };
        childIds.push(docId);
        const node = { id: nodeId, target: { docId }, stage: stageId, order: order++, ...(step.optional ? { optional: true } : {}) };
        nodes.push(node);
        if (step.key) byKey.set(step.key, nodeId);
        pending.push({ node, needs: step.needs });
      }
    }
    const unknown = [];
    for (const { node, needs } of pending) {
      const dependsOn = [...new Set(needs.map((need) => byKey.get(need) ?? (existingNodeIds.has(need) ? need : (unknown.push(need), null)))
        .filter((id) => id && id !== node.id))];
      if (dependsOn.length) node.dependsOn = dependsOn;
    }
    const next = normalizeRoadmap({ version: ROADMAP_VERSION, stages: nextStages, nodes });
    return { conversations, childIds, roadmap: next, added: pending.length, ignoredNeeds: [...new Set(unknown)] };
  }

  /** Files the codec wrote that are new or changed, checked to read back as the roadmap with its steps. */
  function changesFor(rendered, previousFiles, roadmapId, stepIds, taken, revisions) {
    const parsed = parseMarkdownWorkspace(rendered.manifest, rendered.files);
    const roadmap = parsed?.conversations?.[roadmapId];
    if (!roadmap || roadmap.nodeType !== ROADMAP_NODE_TYPE || !stepIds.every((id) => parsed.conversations[id]?.parentId === roadmapId)) return null;
    const changes = [];
    for (const record of rendered.manifest.files) {
      const content = rendered.files[record.path];
      if (record.id !== roadmapId && !stepIds.includes(record.id)) continue;
      if (previousFiles[record.path] !== undefined) {
        if (previousFiles[record.path] !== content) changes.push({ path: record.path, content, baseRevision: revisions.get(record.path) });
      } else {
        if (taken.has(record.path.toLowerCase())) return null;
        changes.push({ path: record.path, content, baseRevision: null });
      }
    }
    return changes;
  }

  async function create(args) {
    const title = line(args.title);
    if (!title) return fail("Give the roadmap a title.");
    const sourceUrl = args.source_url === undefined ? null : normalizeSourceUrl(args.source_url);
    if (args.source_url !== undefined && !sourceUrl) return fail("source_url must be a web link.");
    const goal = typeof args.goal === "string" ? args.goal.trim() : "";
    if (goal.length > MAX_NOTES) return fail(`Keep the goal under ${MAX_NOTES} characters.`);
    const read = readStages(args.stages);
    if (!read.ok) return read;
    const listed = await entries();
    const roadmapId = sourceUrl ? roadmapIdForSource(sourceUrl) : `mcp-roadmap-${createId()}`;
    if (listed.some((entry) => entry.id === roadmapId)) {
      return { ok: false, code: "ROADMAP_EXISTS", document_id: roadmapId,
        error: "This page already has a roadmap. Read it with read_roadmap and add what's missing with add_to_roadmap." };
    }
    let parent = null;
    if (args.parent_document_id !== undefined) {
      parent = listed.find((entry) => entry.id === String(args.parent_document_id) && entry.type === "conversation" && !entry.hiddenFromAI);
      if (!parent) return fail(`No document has the id ${args.parent_document_id}.`);
    }
    const prefs = await preferences();
    const at = now().toISOString();
    const intro = [goal, sourceUrl ? `Source: ${markdownLink(title, sourceUrl)}` : ""].filter(Boolean).join("\n\n");
    const built = buildSteps(read.stages, { version: ROADMAP_VERSION, stages: [], nodes: [] }, roadmapId, prefs, at);
    const roadmap = {
      id: roadmapId, kind: "chat", title, parentId: null,
      serviceId: prefs.serviceId, modelId: prefs.modelId, branchAnchor: null,
      childIds: built.childIds, documents: [], messages: [], notes: [], createdAt: at, updatedAt: at,
      nodeType: ROADMAP_NODE_TYPE, roadmap: built.roadmap,
      document: aiDocument(`mcp-block-${createId()}`, intro || title, at),
    };
    let rendered = createMarkdownWorkspace(miniState({ [roadmapId]: roadmap, ...built.conversations }, roadmapId, prefs), at);
    if (parent) rendered = withParentLink(rendered, roadmapId, parent);
    const taken = new Set(listed.map((entry) => entry.path.toLowerCase()));
    const changes = rendered && changesFor(rendered, {}, roadmapId, built.childIds, taken, new Map());
    if (!changes) return fail("That roadmap couldn't be saved as Margin Chat documents.");
    const saved = await commit(changes);
    if (saved.ok === false) return saved;
    return { ok: true, document_id: roadmapId, title, stages: built.roadmap.stages.length, steps: built.added,
      path: rendered.manifest.files.find((record) => record.id === roadmapId)?.path,
      ...(built.ignoredNeeds.length ? { ignored_needs: built.ignoredNeeds } : {}), ...saved };
  }

  /** The roadmap rendered alone can't link a parent it didn't load; write the part-of link into its frontmatter. */
  function withParentLink(rendered, roadmapId, parent) {
    const record = rendered.manifest.files.find((item) => item.id === roadmapId);
    if (!record) return null;
    const link = `[[${parent.path.replace(/\.md$/iu, "")}|${parent.title.replace(/[[\]|]/gu, " ")}]]`;
    return { ...rendered, files: { ...rendered.files,
      [record.path]: setFrontmatterEntries(rendered.files[record.path], { "part-of": renderFrontmatterEntry("part-of", [link]) }) } };
  }

  async function readRoadmap(args) {
    const given = typeof args.roadmap === "string" ? args.roadmap.trim() : "";
    if (!given) return fail("Give the roadmap's document_id or the link of the page it was made from.");
    const url = /^https?:\/\//iu.test(given) ? normalizeSourceUrl(given) : null;
    const id = url ? roadmapIdForSource(url) : given;
    const listed = await entries();
    const loaded = await loadRoadmap(id, listed);
    if (loaded.error) return { ...loaded.error, found: false };
    return { ok: true, found: true, roadmap: outline(loaded.conversation, loaded.roadmap, loaded.state, listed), statuses: ROADMAP_STATUSES };
  }

  async function add(args) {
    const id = String(args.document_id ?? "");
    const listed = await entries();
    const loaded = await loadRoadmap(id, listed);
    if (loaded.error) return loaded.error;
    const read = readStages(args.stages, { existingStages: new Map(loaded.roadmap.stages.map((stage) => [stage.id, stage.title])) });
    if (!read.ok) return read;
    const prefs = await preferences();
    const at = now().toISOString();
    const built = buildSteps(read.stages, loaded.roadmap, id, prefs, at);
    const conversation = loaded.state.conversations[id];
    const state = { ...loaded.state, conversations: { ...loaded.state.conversations, ...built.conversations,
      [id]: { ...conversation, roadmap: built.roadmap, childIds: [...conversation.childIds, ...built.childIds], updatedAt: at } } };
    const rendered = createMarkdownWorkspace(state, at, { manifest: loaded.workspace.manifest, files: loaded.workspace.files }, { preservePaths: true });
    const revisions = new Map(listed.map((entry) => [entry.path, entry.revision]));
    const taken = new Set(listed.map((entry) => entry.path.toLowerCase()));
    const changes = changesFor(rendered, loaded.files, id, built.childIds, taken, revisions);
    if (!changes || !changes.some((change) => change.path === loaded.entry.path)) return fail("Those steps couldn't be added without damaging the roadmap.");
    const saved = await commit(changes);
    if (saved.ok === false) return saved;
    return { ok: true, document_id: id, title: conversation.title, added: built.added,
      ...(built.ignoredNeeds.length ? { ignored_needs: built.ignoredNeeds } : {}), ...saved };
  }

  const handlers = { create_roadmap: create, read_roadmap: readRoadmap, add_to_roadmap: add };
  return {
    has: (name) => Object.hasOwn(handlers, name),
    async run(name, args) {
      try {
        return await handlers[name](args);
      } catch (error) {
        console.error("MCP roadmap tool failed", error);
        return fail(name === "read_roadmap" ? "The roadmap couldn't be read just now." : "The vault couldn't be saved just now. Nothing was changed.");
      }
    },
  };
}
