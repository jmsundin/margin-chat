export const VALID_MESSAGE_ROLES = new Set(["assistant", "system", "user"]);

export const VALID_SERVICE_IDS = new Set([
  "backend-services",
  "gemini-api",
  "huggingface-api",
  "openai-api",
  "openai-agent",
  "xai-api",
]);

export function getWorkspaceSessionId(userId) {
  return `workspace-${userId}`;
}
