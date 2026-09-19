import { getApiHandler } from "../server/app.mjs";
import { createDeploymentHandler } from "../server/routes/deployment.mjs";

// Existing vaults can have manifests larger than the buffered response limit.
// Keep their JSON API readable while new writes enforce the manifest budget.
export const config = { supportsResponseStreaming: true };

export default createDeploymentHandler(getApiHandler);
