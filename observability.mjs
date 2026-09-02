import { LangfuseSpanProcessor } from "@langfuse/otel";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";

import { config } from "./config.mjs";
import { logger } from "./logger.mjs";

function maskString(value) {
  return value
    .replace(/\bsk-lf-[A-Za-z0-9-]+\b/g, "sk-lf-[REDACTED]")
    .replace(/\b(?:Bearer\s+)?(?:or-|sk-)[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
}

function maskSensitiveData(value, seen = new WeakSet()) {
  if (typeof value === "string") return maskString(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => maskSensitiveData(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    /(?:secret|password|authorization|api[_-]?key)/i.test(key) ? "redacted" : key,
    /(?:secret|password|authorization|api[_-]?key)/i.test(key) ? "[REDACTED]" : maskSensitiveData(item, seen)
  ]));
}

export const langfuseSpanProcessor = config.tracing.configured
  ? new LangfuseSpanProcessor({
      publicKey: config.tracing.publicKey,
      secretKey: config.tracing.secretKey,
      baseUrl: config.tracing.baseUrl,
      environment: config.tracing.environment,
      release: config.tracing.release,
      flushAt: config.tracing.flushAt,
      flushInterval: config.tracing.flushIntervalSeconds,
      timeout: config.tracing.timeoutSeconds,
      exportMode: "batched",
      mediaUploadEnabled: false,
      mask: ({ data }) => maskSensitiveData(data)
    })
  : null;

export const telemetrySdk = langfuseSpanProcessor
  ? new NodeSDK({
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.tracing.sampleRate) }),
      resource: resourceFromAttributes({
        "service.name": config.service.name,
        "service.namespace": config.service.namespace,
        "service.version": config.service.version,
        "deployment.environment.name": config.tracing.environment
      }),
      spanProcessors: [langfuseSpanProcessor]
    })
  : null;

telemetrySdk?.start();

export async function flushTracing() {
  if (!langfuseSpanProcessor) return;
  try {
    await langfuseSpanProcessor.forceFlush();
  } catch (error) {
    logger.warn("Langfuse flush failed", { error });
  }
}

export async function shutdownTracing() {
  if (!telemetrySdk) return;
  try {
    await telemetrySdk.shutdown();
  } catch (error) {
    logger.warn("Langfuse shutdown failed", { error });
  }
}

export function tracingStatus() {
  return {
    configured: config.tracing.configured,
    destination: config.tracing.baseUrl,
    environment: config.tracing.environment,
    sampleRate: config.tracing.sampleRate,
    exportMode: "batched"
  };
}
