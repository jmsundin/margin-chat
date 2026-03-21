import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthService } from "./auth/index.mjs";
import { createBillingService } from "./billing/index.mjs";
import { createChatService } from "./chat/index.mjs";
import { loadProjectEnv } from "./config/env.mjs";
import { createRuntimeConfig } from "./config/runtime.mjs";
import { createAppDatabase } from "./db/index.mjs";
import { createApiHandler } from "./routes/api.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

let cachedAppContext = null;

function buildAppContext() {
  loadProjectEnv(projectRoot, process.env);

  const runtimeConfig = createRuntimeConfig(process.env);
  const database = createAppDatabase(process.env);
  const authService = createAuthService({
    database,
    runtimeConfig,
  });
  const billingService = createBillingService({
    database,
    env: process.env,
  });
  const chatService = createChatService({
    database,
    env: process.env,
    runtimeConfig,
  });
  const apiHandler = createApiHandler({
    authService,
    billingService,
    chatService,
    database,
    runtimeConfig,
  });

  return {
    apiHandler,
    authService,
    billingService,
    chatService,
    database,
    runtimeConfig,
  };
}

export function getAppContext() {
  if (!cachedAppContext) {
    cachedAppContext = buildAppContext();
  }

  return cachedAppContext;
}

export function getApiHandler() {
  return getAppContext().apiHandler;
}
