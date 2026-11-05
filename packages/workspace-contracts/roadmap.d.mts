import type { Conversation, Roadmap, RoadmapStatus } from "./types.mjs";

export const ROADMAP_NODE_TYPE: "roadmap";
export const ROADMAP_VERSION: 1;
export const ROADMAP_STATUSES: readonly RoadmapStatus[];
export function isRoadmapStatus(value: unknown): value is RoadmapStatus;
/** Valid stages and nodes in saved order; malformed entries are dropped, unknown versions return undefined. */
export function normalizeRoadmap(input: unknown): Roadmap | undefined;
export function createEmptyRoadmap(stageId?: string, title?: string): Roadmap;
export function isRoadmapDocument(conversation: Pick<Conversation, "nodeType"> | null | undefined): boolean;
