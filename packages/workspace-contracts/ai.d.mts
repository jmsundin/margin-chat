import type { AIExecutionRecord, AIProvider, AISettings, AutoMode } from "./types.mjs";
export const AI_MODES: readonly AutoMode[];
export const AI_PROVIDERS: readonly AIProvider[];
export function normalizeAISettings(input?: unknown): AISettings;
export function normalizeAIExecution(input?: unknown): AIExecutionRecord | undefined;
