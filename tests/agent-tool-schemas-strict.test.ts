import { expect, test } from "bun:test";
import { AGENT_TOOL_DEFINITIONS } from "../server/chat/agent/tools.mjs";
import { VAULT_TOOL_DEFINITIONS } from "../server/chat/agent/vaultTools.mjs";
import { IMPORT_TOOL_DEFINITION, WEB_TOOL_DEFINITION } from "../server/chat/agent/webTools.mjs";
import { PROPOSAL_TOOL_DEFINITIONS } from "../server/chat/agent/proposalTools.mjs";
import { ASK_TOOL_DEFINITION } from "../server/chat/agent/askTool.mjs";

/**
 * OpenAI, xAI and Meta receive every tool with strict: true, which rejects a schema
 * unless each object lists every property in required and allows no others.
 * An optional field is written as required and nullable instead.
 */
function strictProblems(schema: any, path: string): string[] {
  if (!schema || typeof schema !== "object") return [];
  const problems: string[] = [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("object")) {
    const keys = Object.keys(schema.properties ?? {});
    const required = new Set(schema.required ?? []);
    for (const key of keys) if (!required.has(key)) problems.push(`${path}.${key} is not in required`);
    if (schema.additionalProperties !== false) problems.push(`${path} allows additional properties`);
    for (const key of keys) problems.push(...strictProblems(schema.properties[key], `${path}.${key}`));
  }
  if (schema.items) problems.push(...strictProblems(schema.items, `${path}[]`));
  for (const option of schema.anyOf ?? []) problems.push(...strictProblems(option, path));
  return problems;
}

test("every agent tool schema is valid for strict function calling", () => {
  const tools = [...AGENT_TOOL_DEFINITIONS, ...VAULT_TOOL_DEFINITIONS, WEB_TOOL_DEFINITION, IMPORT_TOOL_DEFINITION, ...PROPOSAL_TOOL_DEFINITIONS, ASK_TOOL_DEFINITION];
  expect(tools.flatMap((tool) => strictProblems(tool.parameters, tool.name))).toEqual([]);
});
