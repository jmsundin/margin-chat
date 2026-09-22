import { normalizeAISettings } from "./ai.mjs";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024;
const string = (value) => typeof value === "string";
const offset = (value) => Number.isSafeInteger(value) && value >= 0;
const services = new Set(["backend-services", "openai-api", "openai-agent", "gemini-api", "huggingface-api", "xai-api"]);
const statuses = new Set(["streaming", "complete", "stopped", "failed"]);
const optionalId = (value) => value === undefined || id(value);
const dated = (value) => string(value) && Number.isFinite(Date.parse(value));
const unique = (values) => new Set(values.map((value) => value.id)).size === values.length;
const settings = (value) => ({ serviceId: value.serviceId, modelId: value.modelId,
  ...(value.ai ? { ai: { ...normalizeAISettings(value.ai), ...(value.ai.jevEnabled === false ? { jevEnabled: false } : {}) } } : {}) });
const validSettings = (value) => services.has(value.serviceId) && id(value.modelId);
const validBlock = (block) => record(block) && id(block.id) && block.kind === "markdown" &&
  string(block.content) && dated(block.createdAt) && dated(block.updatedAt) &&
  optionalId(block.sourceMessageId) && optionalId(block.generationId);
const normalizeBlock = (block) => ({ id: block.id, kind: "markdown", content: block.content,
  createdAt: block.createdAt, updatedAt: block.updatedAt,
  ...(block.sourceMessageId ? { sourceMessageId: block.sourceMessageId } : {}),
  ...(block.generationId ? { generationId: block.generationId } : {}) });

/** Reject malformed authored documents as a whole; never truncate or silently lose text. */
export function normalizeEditableDocument(input) {
  if (!record(input) || input.schemaVersion !== 1 || !Array.isArray(input.blocks) ||
      !Array.isArray(input.prompts) || !Array.isArray(input.generations)) return undefined;
  if (!input.blocks.every(validBlock) || !unique(input.blocks)) return undefined;
  if (!input.prompts.every((prompt) => record(prompt) && id(prompt.id) && string(prompt.content) &&
      dated(prompt.createdAt) && optionalId(prompt.sourceMessageId) && validSettings(prompt) &&
      (prompt.selection === undefined || record(prompt.selection) && id(prompt.selection.blockId) &&
        offset(prompt.selection.from) && offset(prompt.selection.to) && prompt.selection.to >= prompt.selection.from && string(prompt.selection.quote))) || !unique(input.prompts)) return undefined;
  const promptIds = new Set(input.prompts.map((prompt) => prompt.id));
  if (!input.generations.every((generation) => record(generation) && id(generation.id) &&
      promptIds.has(generation.promptId) && id(generation.messageId) && dated(generation.createdAt) &&
      validSettings(generation) && statuses.has(generation.status) && optionalId(generation.alternativeOf) &&
      Array.isArray(generation.blockIds) && generation.blockIds.every(id) &&
      new Set(generation.blockIds).size === generation.blockIds.length &&
      (generation.acceptedAt === undefined || dated(generation.acceptedAt)) &&
      (generation.previousBlocks === undefined || Array.isArray(generation.previousBlocks) &&
        generation.previousBlocks.every(validBlock) && unique(generation.previousBlocks)) &&
      (generation.insertion === undefined || record(generation.insertion) &&
        (generation.insertion.blockId === null || id(generation.insertion.blockId)) && offset(generation.insertion.offset) &&
        (generation.insertion.replaceTo === undefined || offset(generation.insertion.replaceTo) && generation.insertion.replaceTo >= generation.insertion.offset)) &&
      (generation.replacement === undefined || record(generation.replacement) && id(generation.replacement.blockId) &&
        offset(generation.replacement.offset) && string(generation.replacement.content))) || !unique(input.generations)) return undefined;
  // References to removed blocks and older generations deliberately remain valid history.
  return {
    schemaVersion: 1,
    blocks: input.blocks.map(normalizeBlock),
    prompts: input.prompts.map((prompt) => ({ id: prompt.id, content: prompt.content, createdAt: prompt.createdAt,
      ...settings(prompt), ...(prompt.sourceMessageId ? { sourceMessageId: prompt.sourceMessageId } : {}),
      ...(prompt.selection ? { selection: { blockId: prompt.selection.blockId, from: prompt.selection.from, to: prompt.selection.to, quote: prompt.selection.quote } } : {}) })),
    generations: input.generations.map((generation) => ({ id: generation.id, promptId: generation.promptId,
      messageId: generation.messageId, createdAt: generation.createdAt, ...settings(generation), status: generation.status,
      blockIds: [...generation.blockIds], ...(generation.alternativeOf ? { alternativeOf: generation.alternativeOf } : {}),
      ...(generation.acceptedAt ? { acceptedAt: generation.acceptedAt } : {}),
      ...(generation.previousBlocks ? { previousBlocks: generation.previousBlocks.map(normalizeBlock) } : {}),
      ...(generation.insertion ? { insertion: { blockId: generation.insertion.blockId, offset: generation.insertion.offset,
        ...(generation.insertion.replaceTo !== undefined ? { replaceTo: generation.insertion.replaceTo } : {}) } } : {}),
      ...(generation.replacement ? { replacement: { blockId: generation.replacement.blockId, offset: generation.replacement.offset, content: generation.replacement.content } } : {}) })),
  };
}
