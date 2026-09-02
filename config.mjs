import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import {
  applyStoredRuntimeSettings,
  resolveRuntimeSettingsPath,
  webRuntimeConfigurationEnabled
} from "./runtime-settings.mjs";

export const appRoot = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(appRoot, ".env"), quiet: true });
dotenv.config({ path: resolve(appRoot, "../../.env"), override: false, quiet: true });

function integer(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function decimal(name, fallback, min, max) {
  const parsed = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function boolean(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function url(name, fallback) {
  const value = String(process.env[name] || fallback).trim().replace(/\/$/, "");
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

const webConfigurationEnabled = webRuntimeConfigurationEnabled();
const runtimeSettingsPath = resolveRuntimeSettingsPath({ appRoot });
const appliedRuntimeSettings = applyStoredRuntimeSettings({ path: runtimeSettingsPath, enabled: webConfigurationEnabled });

const product = JSON.parse(readFileSync(resolve(appRoot, "config/product.config.json"), "utf8"));
if (product.schemaVersion !== "personal-copilot-product.v1") throw new Error("产品配置协议必须是 personal-copilot-product.v1");

const environment = process.env.NODE_ENV === "production" ? "production" : "development";
const authMode = String(process.env.COPILOT_AUTH_MODE || (environment === "production" ? "trusted-header" : "local-username"));
if (!["local-username", "trusted-header"].includes(authMode)) {
  throw new Error("COPILOT_AUTH_MODE must be local-username or trusted-header");
}

const configuredSessionSecret = String(process.env.COPILOT_SESSION_SECRET || "");
if (environment === "production" && configuredSessionSecret.length < 32) {
  throw new Error("COPILOT_SESSION_SECRET must contain at least 32 characters in production");
}

function localSessionSecret() {
  const path = resolve(appRoot, ".data/copilot-session.secret");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  mkdirSync(resolve(appRoot, ".data"), { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    writeFileSync(path, generated, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return generated;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return readFileSync(path, "utf8").trim();
  }
}

const databasePath = resolve(
  process.env.COPILOT_DATABASE_PATH
  || process.env.COPILOT_MEMORY_DB
  || resolve(appRoot, ".data/copilot.sqlite")
);

export const config = Object.freeze({
  environment,
  product: Object.freeze({ ...product }),
  service: Object.freeze({
    name: product.serviceName,
    namespace: product.serviceNamespace,
    version: process.env.COPILOT_RELEASE || "3.0.0",
    host: process.env.HOST || (environment === "production" ? "0.0.0.0" : "127.0.0.1"),
    port: integer("PORT", 9093, 1, 65535),
    shutdownTimeoutMs: integer("COPILOT_SHUTDOWN_TIMEOUT_MS", 15_000, 1_000, 60_000)
  }),
  http: Object.freeze({
    maxBodyBytes: integer("COPILOT_MAX_BODY_BYTES", 96 * 1024, 1024, 1024 * 1024),
    maxPromptCharacters: integer("COPILOT_MAX_PROMPT_CHARACTERS", 6000, 100, 100_000),
    requestTimeoutMs: integer("COPILOT_REQUEST_TIMEOUT_MS", 120_000, 5_000, 300_000),
    requestsPerMinute: integer("COPILOT_REQUESTS_PER_MINUTE", 30, 1, 1000),
    maxConcurrentPerUser: integer("COPILOT_MAX_CONCURRENT_PER_USER", 2, 1, 20),
    allowedOrigins: String(process.env.COPILOT_ALLOWED_ORIGINS || "").split(",").map(item => item.trim()).filter(Boolean)
  }),
  auth: Object.freeze({
    mode: authMode,
    sessionSecret: configuredSessionSecret || localSessionSecret(),
    cookieName: "copilot_identity",
    cookieTtlSeconds: integer("COPILOT_IDENTITY_TTL_SECONDS", 30 * 24 * 60 * 60, 3600, 365 * 24 * 60 * 60),
    trustedUserHeader: String(process.env.COPILOT_TRUSTED_USER_HEADER || "x-authenticated-user").toLowerCase(),
    trustedTenantHeader: String(process.env.COPILOT_TRUSTED_TENANT_HEADER || "x-authenticated-tenant").toLowerCase()
  }),
  setup: Object.freeze({
    onboardingVersion: "core-configuration.v4",
    webConfigurationEnabled,
    runtimeSettingsPath,
    judgeModelEnvironmentKey: "COPILOT_EVAL_JUDGE_MODEL",
    appliedRuntimeSettingKeys: Object.freeze([...appliedRuntimeSettings.appliedKeys])
  }),
  database: Object.freeze({
    path: databasePath,
    historyTurns: integer("COPILOT_HISTORY_TURNS", 12, 1, 50),
    memoryCandidateLimit: integer("COPILOT_MEMORY_CANDIDATES", 250, 10, 2000),
    memoryResultLimit: integer("COPILOT_MEMORY_RESULTS", 5, 1, 10),
    memoryRetentionDays: integer("COPILOT_MEMORY_RETENTION_DAYS", 365, 1, 3650),
    memoryProfileRetentionDays: integer("COPILOT_MEMORY_PROFILE_RETENTION_DAYS", 730, 1, 3650),
    memoryContextBudgetCharacters: integer("COPILOT_MEMORY_CONTEXT_CHARACTERS", 4000, 500, 20_000),
    memoryRecencyHalfLifeDays: integer("COPILOT_MEMORY_RECENCY_HALF_LIFE_DAYS", 90, 1, 3650),
    memoryMinimumScore: decimal("COPILOT_MEMORY_MINIMUM_SCORE", 0.16, 0, 1)
  }),
  artifacts: Object.freeze({
    directory: resolve(process.env.COPILOT_ARTIFACT_DIRECTORY || resolve(appRoot, ".data/artifacts")),
    maxArtifactBytes: integer("COPILOT_MAX_ARTIFACT_BYTES", 20 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    maxTurnAttachmentBytes: integer("COPILOT_MAX_TURN_ATTACHMENT_BYTES", 30 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    maxSourceCharacters: integer("COPILOT_MAX_ARTIFACT_SOURCE_CHARACTERS", 120_000, 1000, 1_000_000),
    listLimit: integer("COPILOT_ARTIFACT_LIST_LIMIT", 50, 1, 200)
  }),
  agent: Object.freeze({
    rootMaxIterations: integer("COPILOT_ROOT_MAX_ITERATIONS", 3, 1, 8),
    specialistMaxIterations: integer("COPILOT_SPECIALIST_MAX_ITERATIONS", 4, 1, 8),
    maxToolCallsPerTurn: integer("COPILOT_MAX_TOOL_CALLS", 12, 1, 50),
    maxNoProgressIterations: integer("COPILOT_MAX_NO_PROGRESS_ITERATIONS", 2, 1, 6),
    deadlineMs: integer("COPILOT_AGENT_DEADLINE_MS", 110_000, 1_000, 300_000)
  }),
  llmGateway: Object.freeze({
    apiKey: process.env.LLM_GATEWAY_API_KEY || "",
    baseUrl: url("LLM_GATEWAY_BASE_URL", "https://llm.onerouter.pro/v1"),
    timeoutMs: integer("LLM_GATEWAY_TIMEOUT_MS", 60_000, 5_000, 180_000),
    retries: integer("LLM_GATEWAY_MAX_RETRIES", 2, 0, 5),
    completionRetries: integer(
      "LLM_GATEWAY_COMPLETION_RETRIES",
      integer("LLM_GATEWAY_EMPTY_RESPONSE_RETRIES", 2, 0, 4),
      0,
      4
    ),
    maxCompletionTokens: integer("LLM_GATEWAY_MAX_COMPLETION_TOKENS", 4800, 1200, 16384)
  }),
  webSearch: Object.freeze({
    apiKey: process.env.WEB_SEARCH_API_KEY || "",
    baseUrl: url("WEB_SEARCH_BASE_URL", "https://search.onerouter.pro/v1/tavily"),
    timeoutMs: integer("WEB_SEARCH_TIMEOUT_MS", 15_000, 1_000, 60_000),
    retries: integer("WEB_SEARCH_MAX_RETRIES", 2, 0, 5)
  }),
  tracing: Object.freeze({
    configured: Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
    publicKey: process.env.LANGFUSE_PUBLIC_KEY || "",
    secretKey: process.env.LANGFUSE_SECRET_KEY || "",
    baseUrl: url("LANGFUSE_BASE_URL", "https://cloud.langfuse.com"),
    environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || environment,
    release: process.env.LANGFUSE_RELEASE || `${product.serviceName}@${process.env.COPILOT_RELEASE || "3.0.0"}`,
    sampleRate: decimal("LANGFUSE_SAMPLE_RATE", 1, 0, 1),
    flushAt: integer("LANGFUSE_FLUSH_AT", 20, 1, 1000),
    flushIntervalSeconds: integer("LANGFUSE_FLUSH_INTERVAL", 5, 1, 60),
    timeoutSeconds: integer("LANGFUSE_TIMEOUT", 10, 1, 60)
  }),
  traceApi: Object.freeze({
    baseUrl: url("COPILOT_TRACE_API_BASE_URL", "http://127.0.0.1:9092/api/v1"),
    teamId: process.env.COPILOT_TRACE_TEAM_ID || "clickhouse:3680",
    keyId: process.env.COPILOT_TRACE_KEY_ID || "dataset:c3ecf97e78e452b908d5083c",
    allowUnowned: boolean("COPILOT_ALLOW_UNOWNED_TRACES", false)
  })
});

export function readiness() {
  const llmGatewayConfigured = Boolean(process.env.LLM_GATEWAY_API_KEY || config.llmGateway.apiKey);
  const webSearchConfigured = Boolean(process.env.WEB_SEARCH_API_KEY || config.webSearch.apiKey);
  return {
    ready: llmGatewayConfigured,
    dependencies: {
      llm_gateway: llmGatewayConfigured,
      web_search: webSearchConfigured,
      langfuse: config.tracing.configured,
      database: true
    }
  };
}
