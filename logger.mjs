function serializeError(error) {
  if (!error) return undefined;
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    status: error.status,
    stack: process.env.NODE_ENV === "production" ? undefined : error.stack
  };
}

function emit(level, message, fields = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: config.service.name,
    message,
    ...fields
  };
  if (record.error instanceof Error) record.error = serializeError(record.error);
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = Object.freeze({
  info: (message, fields) => emit("info", message, fields),
  warn: (message, fields) => emit("warn", message, fields),
  error: (message, fields) => emit("error", message, fields)
});
import { config } from "./config.mjs";
