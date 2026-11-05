/**
 * A roadmap is an ordinary document with frontmatter `type: "roadmap"` whose
 * registry carries `roadmap: { version: 1, stages, nodes }`. Each node points at
 * vault content (a document, or one block of it) instead of copying it, so the
 * target stays the single source of its text. Per-node status lives here too,
 * so it syncs with the roadmap like other registry data: lists of objects with
 * an `id` merge item by item and field by field.
 *
 * Prerequisites come from two places: `depends-on` relations between target
 * documents (derived, shared with every view) and a node's own `dependsOn`
 * (for block targets). This module only validates the stored shape; graph
 * computations live with the view.
 */

export const ROADMAP_NODE_TYPE = "roadmap";
export const ROADMAP_VERSION = 1;
export const ROADMAP_STATUSES = Object.freeze(["not-started", "learning", "done", "skipped"]);
const MAX_STAGES = 200;
const MAX_NODES = 2_000;
const ID = /^[A-Za-z0-9_:.-]{1,200}$/;

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function oneLine(value, max) {
    if (typeof value !== "string") return undefined;
    const text = value.replace(/\s+/g, " ").trim();
    return text ? text.slice(0, max) : undefined;
}

export function isRoadmapStatus(value) {
    return typeof value === "string" && ROADMAP_STATUSES.includes(value);
}

/**
 * Keep every valid stage and node in its saved order; drop malformed entries
 * rather than the roadmap, since status must never block opening a document.
 * A node whose stage is unknown keeps its stage id; the view shows it unstaged.
 */
export function normalizeRoadmap(input) {
    if (!isRecord(input) || input.version !== ROADMAP_VERSION) return undefined;
    const stages = [];
    const stageIds = new Set();
    for (const stage of Array.isArray(input.stages) ? input.stages : []) {
        if (stages.length >= MAX_STAGES) break;
        if (!isRecord(stage) || typeof stage.id !== "string" || !ID.test(stage.id) || stageIds.has(stage.id)) continue;
        stageIds.add(stage.id);
        stages.push({ id: stage.id, title: oneLine(stage.title, 200) ?? "Untitled stage" });
    }
    const nodes = [];
    const nodeIds = new Set();
    for (const node of Array.isArray(input.nodes) ? input.nodes : []) {
        if (nodes.length >= MAX_NODES) break;
        if (!isRecord(node) || typeof node.id !== "string" || !ID.test(node.id) || nodeIds.has(node.id)) continue;
        const target = isRecord(node.target) ? node.target : null;
        if (!target || typeof target.docId !== "string" || !target.docId.trim()) continue;
        if (typeof node.stage !== "string" || !ID.test(node.stage)) continue;
        nodeIds.add(node.id);
        const title = oneLine(node.title, 200);
        const proof = oneLine(node.proof, 500);
        nodes.push({
            id: node.id,
            target: { docId: target.docId, ...(typeof target.blockId === "string" && ID.test(target.blockId) ? { blockId: target.blockId } : {}) },
            ...(title ? { title } : {}),
            stage: node.stage,
            order: Number.isFinite(node.order) ? node.order : nodes.length,
            ...(isRoadmapStatus(node.status) && node.status !== "not-started" ? { status: node.status } : {}),
            ...(proof ? { proof } : {}),
            ...(Array.isArray(node.dependsOn) ? { dependsOn: node.dependsOn } : {}),
        });
    }
    for (const node of nodes) {
        if (!node.dependsOn) continue;
        const dependsOn = [...new Set(node.dependsOn.filter((id) => typeof id === "string" && id !== node.id && nodeIds.has(id)))];
        if (dependsOn.length) node.dependsOn = dependsOn;
        else delete node.dependsOn;
    }
    return { version: ROADMAP_VERSION, stages, nodes };
}

export function createEmptyRoadmap(stageId = "stage-1", title = "Stage 1") {
    return { version: ROADMAP_VERSION, stages: [{ id: stageId, title }], nodes: [] };
}

export function isRoadmapDocument(conversation) {
    return conversation?.nodeType === ROADMAP_NODE_TYPE;
}
