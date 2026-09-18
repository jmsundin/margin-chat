import { getApiHandler } from "../server/app.mjs";
import { createDeploymentHandler } from "../server/routes/deployment.mjs";

export default createDeploymentHandler(getApiHandler);
