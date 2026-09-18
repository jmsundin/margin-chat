export const API_DEPLOYMENT_PATH = "/api/handler";
export const API_DEPLOYMENT_QUERY = "__margin_api_path";

// Vercel's generic Node builder treats [...path] as one segment. An explicit
// rewrite reaches this adapter for every depth. Preserve the original URL when
// supplied by the runtime, or reconstruct it from the rewrite's private field.
// The body stream is untouched, including webhook signatures and file uploads.
export function createDeploymentHandler(getHandler) {
  return function handleDeploymentRequest(request, response) {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === API_DEPLOYMENT_PATH && url.searchParams.has(API_DEPLOYMENT_QUERY)) {
      const path = url.searchParams.get(API_DEPLOYMENT_QUERY);
      url.searchParams.delete(API_DEPLOYMENT_QUERY);
      request.url = `/api/${path}${url.search}`;
    }
    return getHandler()(request, response);
  };
}
