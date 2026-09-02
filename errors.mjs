export class AppError extends Error {
  constructor(message, { code = "internal_error", status = 500, retryable = false, expose = false, cause } = {}) {
    super(message, { cause });
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.expose = expose;
  }
}

export function publicError(error, requestId) {
  const known = error instanceof AppError;
  return {
    error: known && error.expose ? error.message : "Personal Copilot could not complete this request",
    code: known ? error.code : "internal_error",
    retryable: known ? error.retryable : false,
    requestId
  };
}
