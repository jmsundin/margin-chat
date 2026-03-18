import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthService } from "./auth/index.mjs";
import { createChatService } from "./chat/index.mjs";
import { loadProjectEnv } from "./config/env.mjs";
import { createRuntimeConfig } from "./config/runtime.mjs";
import { createAppDatabase } from "./db/index.mjs";
import { createApiHandler } from "./routes/api.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

loadProjectEnv(projectRoot, process.env);

const runtimeConfig = createRuntimeConfig(process.env);
const database = createAppDatabase(process.env);
const authService = createAuthService({
  database,
  runtimeConfig,
});
const chatService = createChatService({
  env: process.env,
  runtimeConfig,
});

createServer(
  createApiHandler({
    authService,
    chatService,
    database,
    runtimeConfig,
  }),
).listen(runtimeConfig.port, runtimeConfig.host, () => {
  const huggingFaceConfigured = Boolean(
    process.env.HUGGINGFACE_API_KEY ?? process.env.HF_TOKEN,
  );

  console.log(
    `API server listening on http://${runtimeConfig.host}:${runtimeConfig.port} (OpenAI: ${
      process.env.OPENAI_API_KEY ? "configured" : "missing"
    }, Gemini: ${process.env.GEMINI_API_KEY ? "configured" : "missing"}, Hugging Face: ${
      huggingFaceConfigured ? "configured" : "missing"
    })`,
  );

  void database.ready().catch((error) => {
    console.warn(`Postgres storage unavailable: ${error.message}`);
  });
});
