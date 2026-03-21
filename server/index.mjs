import { createServer } from "node:http";
import { getAppContext } from "./app.mjs";

const { apiHandler, database, runtimeConfig } = getAppContext();

createServer(
  apiHandler,
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
