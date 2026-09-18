import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthService } from "./auth/index.mjs";
import { createApiKeyService } from "./apiKeys/index.mjs";
import { createBillingService } from "./billing/index.mjs";
import { createChatService } from "./chat/index.mjs";
import { loadProjectEnv } from "./config/env.mjs";
import { createRuntimeConfig } from "./config/runtime.mjs";
import { createAppDatabase } from "./db/index.mjs";
import { createDocumentService } from "./documents/index.mjs";
import { createApiHandler } from "./routes/api.mjs";
import { createCaptureService } from "./captures/index.mjs";
import { createVaultService } from "./vault/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

let cachedAppContext = null;

export function createAppContext(env = process.env) {
  const runtimeConfig = createRuntimeConfig(env);
  const database = createAppDatabase(env);
  const apiKeyService = createApiKeyService({
    database,
    env,
  });
  const authService = createAuthService({
    apiKeyService,
    database,
    env,
    runtimeConfig,
  });
  const billingService = createBillingService({
    database,
    env,
  });
  const vaultService = createVaultService({ database, env });
  const documentService = createDocumentService({
    database,
    env,
    vaultService,
  });
  const chatService = createChatService({
    apiKeyService,
    database,
    documentService,
    env,
    runtimeConfig,
  });
  const apiHandler = createApiHandler({
    captureService: createCaptureService({ database }),
    apiKeyService,
    authService,
    billingService,
    chatService,
    database,
    documentService,
    runtimeConfig,
    vaultService,
  });

  return {
    apiHandler,
    apiKeyService,
    authService,
    billingService,
    chatService,
    database,
    documentService,
    runtimeConfig,
    vaultService,
  };
}

export function getAppContext() {
  if (!cachedAppContext) {
    loadProjectEnv(projectRoot, process.env);
    cachedAppContext = createAppContext(process.env);
  }

  return cachedAppContext;
}

export function getApiHandler() {
  return getAppContext().apiHandler;
}
