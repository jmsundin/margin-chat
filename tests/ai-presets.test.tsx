import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import AIControls from "../client/src/components/AIControls";
import { createEmptyState } from "../client/src/initialState";
import {
  MAX_AI_PRESETS, addAIPreset, applyPresetSettings, formatUsageMicros, matchingPreset, parseAIPresets, presetFromConversation, type AIPreset,
} from "../client/src/lib/aiPresets";

const base = { serviceId: "backend-services", ai: { mode: "fast" as const, contextScope: "conversation" as const, selectedConversationIds: [] } };

describe("run presets", () => {
  test("a preset saves the model and settings but not which documents were picked", () => {
    const saved = presetFromConversation({ serviceId: "openai-api", modelId: "gpt-6-luna",
      ai: { mode: "thorough", contextScope: "selected", selectedConversationIds: ["a", "b"], agent: true, agentBudgetMicros: 500_000 } });
    expect(saved).toMatchObject({ serviceId: "openai-api", modelId: "gpt-6-luna", ai: { mode: "thorough", contextScope: "conversation", selectedConversationIds: [], agent: true } });
  });

  test("applying a preset keeps the documents this one already picked", () => {
    const preset: AIPreset = { id: "p", name: "Deep", ...presetFromConversation({ ...base, ai: { ...base.ai, mode: "thorough" } }) };
    const applied = applyPresetSettings(preset, { mode: "fast", contextScope: "selected", selectedConversationIds: ["a"] });
    expect(applied.mode).toBe("thorough");
    expect(applied.selectedConversationIds).toEqual(["a"]);
  });

  test("the current preset is found by its settings, and a changed setting stops matching", () => {
    const preset: AIPreset = { id: "p", name: "Quick", ...presetFromConversation(base) };
    expect(matchingPreset(base, [preset])?.id).toBe("p");
    expect(matchingPreset({ ...base, ai: { ...base.ai, mode: "thorough" } }, [preset])).toBeUndefined();
    expect(matchingPreset({ ...base, serviceId: "openai-api" }, [preset])).toBeUndefined();
  });

  test("saving under an existing name replaces it; the list is capped", () => {
    const first = addAIPreset([], " Quick ", presetFromConversation(base), "one");
    if (!first.ok) throw new Error(first.reason);
    expect(first.presets).toHaveLength(1);
    const replaced = addAIPreset(first.presets, "quick", presetFromConversation({ ...base, ai: { ...base.ai, mode: "thorough" } }), "two");
    if (!replaced.ok) throw new Error(replaced.reason);
    expect(replaced.presets).toHaveLength(1);
    expect(replaced.presets[0]).toMatchObject({ id: "one", name: "quick", ai: { mode: "thorough" } });
    expect(addAIPreset([], "   ", presetFromConversation(base), "x").ok).toBe(false);
    const full = Array.from({ length: MAX_AI_PRESETS }, (_, index) => ({ id: `p${index}`, name: `P${index}`, ...presetFromConversation(base) }));
    expect(addAIPreset(full, "One more", presetFromConversation(base), "x").ok).toBe(false);
  });

  test("a damaged saved value yields no presets, and bad entries are dropped", () => {
    expect(parseAIPresets("{not json")).toEqual([]);
    expect(parseAIPresets(JSON.stringify({ a: 1 }))).toEqual([]);
    const parsed = parseAIPresets(JSON.stringify([{ id: "a", name: "A", serviceId: "openai-api", ai: { mode: "nonsense" } }, { id: "a", name: "Dup", serviceId: "x" }, { name: "No id" }]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].ai.mode).toBe("balanced");
  });

  test("usage is shown in dollars, and a real amount under a cent isn't shown as zero", () => {
    expect(formatUsageMicros(0)).toBe("$0.00");
    expect(formatUsageMicros(4_000)).toBe("under $0.01");
    expect(formatUsageMicros(1_234_000)).toBe("$1.23");
  });
});

describe("AI controls", () => {
  const state = createEmptyState();
  const conversation = state.conversations[state.rootId];
  test("presets and usage appear only where the workspace offers them", () => {
    const plain = renderToStaticMarkup(<AIControls conversation={conversation} conversations={state.conversations} onChange={() => {}} />);
    expect(plain).not.toContain("Save as preset");
    expect(plain).not.toContain("Hosted AI this month");
    const full = renderToStaticMarkup(<AIControls conversation={conversation} conversations={state.conversations} onChange={() => {}} onApplyPreset={() => {}}
      usage={{ usedThisMonthMicros: 2_500_000, balanceMicros: 17_500_000 }} />);
    expect(full).toContain("Save as preset");
    expect(full).toContain("No presets yet");
    expect(full).toContain("<strong>$2.50</strong> used");
    expect(full).toContain("<strong>$17.50</strong> credit left");
  });
});
