import { getApiHandler } from "../../server/app.mjs";

const apiHandler = getApiHandler();

export default async function handler(request, response) {
  return apiHandler(request, response);
}
