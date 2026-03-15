export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

export function createStatusError(statusCode, message) {
  const error = new Error(message);
  error.name = "StatusError";
  error.statusCode = statusCode;
  return error;
}

export function hasStatusCode(error) {
  return Boolean(error && typeof error.statusCode === "number");
}
