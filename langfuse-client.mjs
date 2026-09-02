import { LangfuseClient } from "@langfuse/client";

import { config } from "./config.mjs";

export const langfuseClient = config.tracing.configured
  ? new LangfuseClient({
      publicKey: config.tracing.publicKey,
      secretKey: config.tracing.secretKey,
      baseUrl: config.tracing.baseUrl,
      timeout: config.tracing.timeoutSeconds,
      additionalHeaders: {
        "User-Agent": `Personal Copilot/${config.service.version}`,
        "Accept": "application/json",
        "Connection": "keep-alive"
      }
    })
  : null;

export async function exportTraceScore({ id, traceId, name, value, dataType, comment = null, metadata = {} }) {
  if (!langfuseClient) return { configured: false, exported: false };
  langfuseClient.score.create({ id, traceId, name, value, dataType, comment: comment || undefined, metadata });
  await langfuseClient.score.flush();
  return { configured: true, exported: true };
}

export async function shutdownLangfuseClient() {
  if (!langfuseClient) return;
  await langfuseClient.shutdown();
}
