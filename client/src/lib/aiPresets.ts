import { normalizeAISettings } from "@margin-chat/workspace-contracts";
import type { AISettings, Conversation } from "../types";
import { onSyncedSettingChange, writeSyncedSetting } from "./interfaceSettings";

/**
 * Run presets: a named combination of model and AI settings, saved once and applied to any document.
 * They are kept on the account with the other interface settings, so every device offers the same ones.
 */
export interface AIPreset {
  id: string;
  name: string;
  serviceId: string;
  modelId?: string;
  /** Everything in the AI controls except which documents were picked: that choice belongs to one document. */
  ai: AISettings;
}

export const AI_PRESETS_KEY = "margin-chat:ai-presets";
export const MAX_AI_PRESETS = 10;
export const MAX_PRESET_NAME = 40;
/** Interface settings hold at most this many characters each. */
const MAX_SETTING_LENGTH = 4000;

function presetSettings(ai: unknown): AISettings {
  const settings = normalizeAISettings(ai as AISettings | undefined);
  return { ...settings, selectedConversationIds: [], contextScope: settings.contextScope === "selected" ? "conversation" : settings.contextScope,
    ...(settings.agentScope === "selected" ? { agentScope: "workspace" as const } : {}) };
}

export function parseAIPresets(raw: string | null): AIPreset[] {
  let value: unknown = null;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const presets: AIPreset[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { id, name, serviceId, modelId, ai } = item as Record<string, unknown>;
    if (typeof id !== "string" || !id || seen.has(id) || typeof name !== "string" || !name.trim() || typeof serviceId !== "string" || !serviceId) continue;
    seen.add(id);
    presets.push({ id, name: name.trim().slice(0, MAX_PRESET_NAME), serviceId, ...(typeof modelId === "string" && modelId ? { modelId } : {}), ai: presetSettings(ai) });
    if (presets.length === MAX_AI_PRESETS) break;
  }
  return presets;
}

/** What a preset would save from this document, without a name yet. */
export function presetFromConversation(conversation: Pick<Conversation, "serviceId" | "modelId" | "ai">): Omit<AIPreset, "id" | "name"> {
  return { serviceId: conversation.serviceId, ...(conversation.modelId ? { modelId: conversation.modelId } : {}), ai: presetSettings(conversation.ai) };
}

const sameSettings = (left: Omit<AIPreset, "id" | "name">, right: Omit<AIPreset, "id" | "name">) =>
  left.serviceId === right.serviceId && (left.modelId ?? "") === (right.modelId ?? "") && JSON.stringify(sortKeys(left.ai)) === JSON.stringify(sortKeys(right.ai));
const sortKeys = (value: object) => Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));

/** The preset this document is set to right now, if any. Picking other documents as context doesn't count as a change. */
export function matchingPreset(conversation: Pick<Conversation, "serviceId" | "modelId" | "ai">, presets: readonly AIPreset[]): AIPreset | undefined {
  const current = presetFromConversation(conversation);
  const scope = normalizeAISettings(conversation.ai).contextScope;
  return presets.find((preset) => sameSettings(scope === "selected" ? { ...current, ai: { ...current.ai, contextScope: preset.ai.contextScope } } : current, preset));
}

/** A preset's settings for a document, keeping the documents that one already picked as context. */
export function applyPresetSettings(preset: AIPreset, current: AISettings | undefined): AISettings {
  return normalizeAISettings({ ...preset.ai, selectedConversationIds: normalizeAISettings(current).selectedConversationIds });
}

export type PresetChange = { ok: true; presets: AIPreset[] } | { ok: false; reason: string };

/** Adds a preset, or replaces the one with the same name (compared without case). */
export function addAIPreset(presets: readonly AIPreset[], name: string, settings: Omit<AIPreset, "id" | "name">, id: string): PresetChange {
  const trimmed = name.trim().slice(0, MAX_PRESET_NAME);
  if (!trimmed) return { ok: false, reason: "Give the preset a name." };
  const existing = presets.find((preset) => preset.name.toLowerCase() === trimmed.toLowerCase());
  if (!existing && presets.length >= MAX_AI_PRESETS) return { ok: false, reason: `You can keep ${MAX_AI_PRESETS} presets. Delete one to add another.` };
  const next = existing ? presets.map((preset) => preset === existing ? { ...settings, id: existing.id, name: trimmed } : preset) : [...presets, { ...settings, id, name: trimmed }];
  if (JSON.stringify(next).length > MAX_SETTING_LENGTH) return { ok: false, reason: "These presets are too large to save. Delete one to add another." };
  return { ok: true, presets: next };
}

const listeners = new Set<() => void>();
let cached: { raw: string | null; presets: AIPreset[] } | null = null;

function readRaw(): string | null {
  try { return localStorage.getItem(AI_PRESETS_KEY); } catch { return cached?.raw ?? null; }
}

/** The same array until the saved value changes, as useSyncExternalStore needs. */
export function readAIPresets(): AIPreset[] {
  const raw = readRaw();
  if (!cached || cached.raw !== raw) cached = { raw, presets: parseAIPresets(raw) };
  return cached.presets;
}

export function saveAIPresets(presets: readonly AIPreset[]) {
  const raw = JSON.stringify(presets);
  writeSyncedSetting(AI_PRESETS_KEY, raw);
  cached = { raw, presets: parseAIPresets(raw) };
  listeners.forEach((listener) => listener());
}

export function subscribeAIPresets(listener: () => void): () => void {
  listeners.add(listener);
  const stop = onSyncedSettingChange([AI_PRESETS_KEY], listener);
  return () => { listeners.delete(listener); stop(); };
}

/** "$1.20" for whole cents and up; "under $0.01" for a real amount smaller than a cent. */
export function formatUsageMicros(micros: number): string {
  if (!(micros > 0)) return "$0.00";
  if (micros < 10_000) return "under $0.01";
  return `$${(micros / 1_000_000).toFixed(2)}`;
}
