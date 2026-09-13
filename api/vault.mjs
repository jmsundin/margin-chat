import { getApiHandler } from "../server/app.mjs";

export default function handler(request, response) {
  return getApiHandler()(request, response);
}
