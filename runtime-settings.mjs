import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const RUNTIME_SETTING_KEYS = Object.freeze([
  "LLM_GATEWAY_API_KEY",
  "LLM_GATEWAY_BASE_URL",
  "LLM_GATEWAY_INTENTION_MODEL",
  "COPILOT_EVAL_JUDGE_MODEL",
  "WEB_SEARCH_API_KEY",
  "WEB_SEARCH_BASE_URL",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_TRACING_ENVIRONMENT"
]);

const CURRENT_SCHEMA_VERSION = "copilot-runtime-settings.v2";
const SUPPORTED_SCHEMA_VERSIONS = new Set(["copilot-runtime-settings.v1", CURRENT_SCHEMA_VERSION]);

function enabledValue(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function webRuntimeConfigurationEnabled(env = process.env) {
  if (String(env.COPILOT_ALLOW_WEB_CONFIGURATION || "").trim()) {
    return enabledValue(env.COPILOT_ALLOW_WEB_CONFIGURATION);
  }
  const production = env.NODE_ENV === "production";
  const authMode = String(env.COPILOT_AUTH_MODE || (production ? "trusted-header" : "local-username"));
  const automatedRun = Boolean(env.NODE_TEST_CONTEXT) || env.COPILOT_EVAL_ISOLATED === "true";
  return !production && authMode === "local-username" && !automatedRun;
}

export function resolveRuntimeSettingsPath({ appRoot, env = process.env }) {
  return resolve(env.COPILOT_RUNTIME_CONFIG_PATH || resolve(appRoot, ".data/runtime-settings.json"));
}

function normalizedDocument(path) {
  const resolvedPath = resolve(path);
  if (!existsSync(resolvedPath)) {
    return { path: resolvedPath, schemaVersion: CURRENT_SCHEMA_VERSION, updatedAt: null, values: {} };
  }
  const parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
  if (!SUPPORTED_SCHEMA_VERSIONS.has(parsed?.schemaVersion) || !parsed.values || typeof parsed.values !== "object") {
    throw new Error(`运行配置文件协议无效：${resolvedPath}`);
  }
  const values = {};
  for (const key of RUNTIME_SETTING_KEYS) {
    if (typeof parsed.values[key] === "string" && parsed.values[key]) values[key] = parsed.values[key];
  }
  return {
    path: resolvedPath,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    values
  };
}

export function applyStoredRuntimeSettings({ path, enabled }) {
  const document = normalizedDocument(path);
  if (!enabled) return { ...document, appliedKeys: [] };
  for (const [key, value] of Object.entries(document.values)) process.env[key] = value;
  return { ...document, appliedKeys: Object.keys(document.values) };
}

export function runtimeSettingsStatus(path) {
  const document = normalizedDocument(path);
  return {
    configured: Object.keys(document.values).length > 0,
    updatedAt: document.updatedAt,
    configuredKeys: Object.keys(document.values)
  };
}

export function persistRuntimeSettings({ path, updates }) {
  const document = normalizedDocument(path);
  const values = { ...document.values };
  for (const key of RUNTIME_SETTING_KEYS) {
    if (!Object.hasOwn(updates, key)) continue;
    const value = String(updates[key] || "").trim();
    if (value) values[key] = value;
  }
  const now = new Date().toISOString();
  const target = resolve(path);
  const temporary = `${target}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    updatedAt: now,
    values
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
  chmodSync(target, 0o600);
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return { configured: Object.keys(values).length > 0, updatedAt: now, configuredKeys: Object.keys(values) };
}
