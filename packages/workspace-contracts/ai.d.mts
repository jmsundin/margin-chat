import type { AgentRunStep, AIExecutionRecord, AIProvider, AISettings, AutoMode } from "./types.mjs";
export const AI_MODES: readonly AutoMode[];
export const AI_PROVIDERS: readonly AIProvider[];
export function normalizeAISettings(input?: unknown): AISettings;
export function normalizeAIExecution(input?: unknown): AIExecutionRecord | undefined;
export const AGENT_BUDGET_CHOICES_MICROS: readonly number[];
export const DEFAULT_AGENT_BUDGET_MICROS: number;
export function normalizeAgentStep(input?: unknown): AgentRunStep | undefined;
