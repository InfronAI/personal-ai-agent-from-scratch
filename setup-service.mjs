import { performance } from "node:perf_hooks";

import { config } from "./config.mjs";
import { AppError } from "./errors.mjs";
import { loadEvalConfiguration } from "./evals/lib/eval-config.mjs";
import {
  claimSetupAdministration,
  completeOnboarding,
  onboardingStatus,
  setupAdministration
} from "./onboarding-store.mjs";
import { persistRuntimeSettings, runtimeSettingsStatus } from "./runtime-settings.mjs";

function effectiveValue(name, fallback = "") {
  return String(process.env[name] || fallback || "").trim();
}

function systemJudgeModel() {
  const evalEnvironment = {};
  if (process.env.COPILOT_EVAL_CONFIG?.trim()) {
    evalEnvironment.COPILOT_EVAL_CONFIG = process.env.COPILOT_EVAL_CONFIG.trim();
  }
  return loadEvalConfiguration({ profileName: "live-judged", env: evalEnvironment }).run.judge.model;
}

function validUrl(value, field) {
  let parsed;
  try { parsed = new URL(String(value || "").trim()); }
  catch {
    throw new AppError(`${field} 必须是绝对 URL`, { code: "invalid_setup_url", status: 400, expose: true });
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new AppError(`${field} 只能使用不含凭证的 HTTP(S) URL`, { code: "invalid_setup_url", status: 400, expose: true });
  }
  if (config.environment === "production" && parsed.protocol !== "https:") {
    throw new AppError(`${field} 在生产环境必须使用 HTTPS`, { code: "insecure_setup_url", status: 400, expose: true });
  }
  return parsed.toString().replace(/\/$/u, "");
}

function validModel(value, field) {
  const model = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(model)) {
    throw new AppError(`${field} 格式无效`, { code: "invalid_setup_model", status: 400, expose: true });
  }
  return model;
}

function validApiKey(value, field = "API Key") {
  const key = String(value || "").trim();
  if (key.length < 8 || key.length > 4096 || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new AppError(`${field} 格式无效`, { code: "invalid_setup_api_key", status: 400, expose: true });
  }
  return key;
}

function validLangfuseKey(value, field, prefix) {
  const key = String(value || "").trim();
  if (key.length < 8 || key.length > 4096 || /[\u0000-\u001f\u007f]/u.test(key) || !key.startsWith(prefix)) {
    throw new AppError(`${field} 格式无效`, { code: "invalid_langfuse_key", status: 400, expose: true });
  }
  return key;
}

function validEnvironment(value) {
  const environment = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(environment)) {
    throw new AppError("Langfuse Environment 格式无效", { code: "invalid_langfuse_environment", status: 400, expose: true });
  }
  return environment;
}

function configurationValues() {
  const judgeDefaultModel = systemJudgeModel();
  return {
    apiKey: effectiveValue("LLM_GATEWAY_API_KEY", config.llmGateway.apiKey),
    llmBaseUrl: effectiveValue("LLM_GATEWAY_BASE_URL", config.llmGateway.baseUrl),
    intentionModel: effectiveValue("LLM_GATEWAY_INTENTION_MODEL", "google/gemini-3.1-flash-lite"),
    judgeModel: effectiveValue("COPILOT_EVAL_JUDGE_MODEL", judgeDefaultModel),
    judgeDefaultModel,
    searchApiKey: effectiveValue("WEB_SEARCH_API_KEY", config.webSearch.apiKey),
    searchBaseUrl: effectiveValue("WEB_SEARCH_BASE_URL", config.webSearch.baseUrl),
    langfusePublicKey: effectiveValue("LANGFUSE_PUBLIC_KEY"),
    langfuseSecretKey: effectiveValue("LANGFUSE_SECRET_KEY"),
    langfuseBaseUrl: effectiveValue("LANGFUSE_BASE_URL", "https://cloud.langfuse.com"),
    langfuseEnvironment: effectiveValue("LANGFUSE_TRACING_ENVIRONMENT", config.environment)
  };
}

export function publicSetupState({ userId, authMode, tracing }) {
  const values = configurationValues();
  const stored = runtimeSettingsStatus(config.setup.runtimeSettingsPath);
  const runtimeKeys = new Set(stored.configuredKeys);
  const administration = setupAdministration({
    userId,
    authMode,
    webConfigurationEnabled: config.setup.webConfigurationEnabled
  });
  return {
    schemaVersion: "copilot-setup-state.v5",
    onboarding: onboardingStatus({ userId, onboardingVersion: config.setup.onboardingVersion }),
    administration,
    requiredReady: Boolean(values.apiKey),
    modelGateway: {
      configured: Boolean(values.apiKey),
      apiKeySource: runtimeKeys.has("LLM_GATEWAY_API_KEY") ? "web-runtime" : values.apiKey ? "environment" : "missing",
      baseUrl: values.llmBaseUrl,
      intentionModel: values.intentionModel
    },
    evaluationJudge: {
      configured: Boolean(values.judgeModel),
      model: values.judgeModel,
      systemDefaultModel: values.judgeDefaultModel,
      modelSource: runtimeKeys.has("COPILOT_EVAL_JUDGE_MODEL")
        ? "web-runtime"
        : process.env.COPILOT_EVAL_JUDGE_MODEL?.trim() ? "environment" : "system-default",
      credentialRef: "LLM_GATEWAY_API_KEY",
      baseUrl: values.llmBaseUrl
    },
    search: {
      configured: Boolean(values.searchApiKey && values.searchBaseUrl),
      apiKeySource: runtimeKeys.has("WEB_SEARCH_API_KEY") ? "web-runtime" : values.searchApiKey ? "environment" : "missing",
      apiKeyConfigured: Boolean(values.searchApiKey),
      baseUrl: values.searchBaseUrl,
      credentialRef: "WEB_SEARCH_API_KEY"
    },
    tracing: {
      configured: Boolean(values.langfusePublicKey && values.langfuseSecretKey),
      active: Boolean(tracing?.configured),
      credentialSource: runtimeKeys.has("LANGFUSE_PUBLIC_KEY") && runtimeKeys.has("LANGFUSE_SECRET_KEY")
        ? "web-runtime"
        : values.langfusePublicKey && values.langfuseSecretKey ? "environment" : "missing",
      publicKeyConfigured: Boolean(values.langfusePublicKey),
      secretKeyConfigured: Boolean(values.langfuseSecretKey),
      baseUrl: values.langfuseBaseUrl,
      destination: tracing?.configured ? tracing.destination : values.langfuseBaseUrl,
      environment: values.langfuseEnvironment,
      changesRequireRestart: true
    },
    runtimeConfiguration: {
      configured: stored.configured,
      updatedAt: stored.updatedAt
    }
  };
}

export function updateSetupConfiguration({ userId, authMode, body }) {
  const values = configurationValues();
  const searchApiKeyInput = String(body.searchApiKey || "").trim();
  const publicKeyInput = String(body.langfusePublicKey || "").trim();
  const secretKeyInput = String(body.langfuseSecretKey || "").trim();
  const effectivePublicKey = publicKeyInput || values.langfusePublicKey;
  const effectiveSecretKey = secretKeyInput || values.langfuseSecretKey;
  if (Boolean(effectivePublicKey) !== Boolean(effectiveSecretKey)) {
    throw new AppError("Langfuse Public Key 与 Secret Key 必须成对配置", { code: "incomplete_langfuse_credentials", status: 400, expose: true });
  }
  const updates = {
    LLM_GATEWAY_BASE_URL: validUrl(body.llmBaseUrl || values.llmBaseUrl, "LLM Gateway Base URL"),
    LLM_GATEWAY_INTENTION_MODEL: validModel(body.intentionModel || values.intentionModel, "Intention 模型"),
    COPILOT_EVAL_JUDGE_MODEL: validModel(body.judgeModel || values.judgeModel, "LLM-as-a-Judge 模型"),
    WEB_SEARCH_BASE_URL: validUrl(body.searchBaseUrl || values.searchBaseUrl, "Search Base URL"),
    LANGFUSE_BASE_URL: validUrl(body.langfuseBaseUrl || values.langfuseBaseUrl, "Langfuse Base URL"),
    LANGFUSE_TRACING_ENVIRONMENT: validEnvironment(body.langfuseEnvironment || values.langfuseEnvironment)
  };
  if (String(body.llmApiKey || "").trim()) updates.LLM_GATEWAY_API_KEY = validApiKey(body.llmApiKey, "LLM Gateway API Key");
  if (searchApiKeyInput) updates.WEB_SEARCH_API_KEY = validApiKey(searchApiKeyInput, "Search API Key");
  if (publicKeyInput) updates.LANGFUSE_PUBLIC_KEY = validLangfuseKey(publicKeyInput, "Langfuse Public Key", "pk-lf-");
  if (secretKeyInput) updates.LANGFUSE_SECRET_KEY = validLangfuseKey(secretKeyInput, "Langfuse Secret Key", "sk-lf-");
  claimSetupAdministration({
    userId,
    authMode,
    webConfigurationEnabled: config.setup.webConfigurationEnabled
  });
  return persistRuntimeSettings({ path: config.setup.runtimeSettingsPath, updates });
}

export async function verifyAndCompleteSetup({ userId, fetchImpl = globalThis.fetch }) {
  const values = configurationValues();
  if (!values.apiKey) {
    throw new AppError("请先配置 LLM Gateway API Key", { code: "llm_not_configured", status: 503, expose: true });
  }
  const started = performance.now();
  let response;
  try {
    response = await fetchImpl(`${validUrl(values.llmBaseUrl, "LLM Gateway Base URL")}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${values.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Connection": "close",
        "User-Agent": `Personal-Copilot-Setup/${config.service.version}`,
        "X-Request-Id": `setup-${String(userId).slice(0, 80)}-${Date.now()}`
      },
      body: JSON.stringify({
        model: validModel(values.intentionModel, "Intention 模型"),
        messages: [{ role: "user", content: "仅回复 OK" }],
        temperature: 0,
        max_tokens: 8,
        stream: false,
        provider: { allow_fallbacks: true, require_parameters: true }
      }),
      signal: AbortSignal.timeout(Math.min(config.llmGateway.timeoutMs, 30_000))
    });
  } catch (error) {
    throw new AppError("无法连接 LLM Gateway，请检查 Base URL 与网络", {
      code: "setup_gateway_unreachable",
      status: 502,
      retryable: true,
      expose: true,
      cause: error
    });
  }
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch { payload = {}; }
  if (!response.ok) {
    const known = {
      401: ["setup_gateway_unauthorized", "LLM Gateway 拒绝了 API Key"],
      402: ["setup_gateway_payment_required", "LLM Gateway 账户额度不足"],
      403: ["setup_gateway_forbidden", "当前模型或请求被 LLM Gateway 拒绝"],
      429: ["setup_gateway_rate_limited", "LLM Gateway 当前触发限流，请稍后重试"],
      503: ["setup_gateway_no_provider", "当前没有可用 Provider 满足模型请求"]
    }[response.status];
    const [code, message] = known || ["setup_gateway_rejected", `LLM Gateway 验证失败（HTTP ${response.status}）`];
    throw new AppError(message, {
      code,
      status: known ? response.status : 502,
      retryable: response.status === 429 || response.status >= 500,
      expose: true
    });
  }
  if (!payload.choices?.[0]?.message?.content) {
    throw new AppError("LLM Gateway 已响应，但没有返回可用 Completion", {
      code: "setup_gateway_empty_completion",
      status: 502,
      retryable: true,
      expose: true
    });
  }
  const onboarding = completeOnboarding({ userId, onboardingVersion: config.setup.onboardingVersion });
  return {
    onboarding,
    verification: {
      status: "passed",
      model: String(payload.model || values.intentionModel),
      latencyMs: Math.round(performance.now() - started)
    }
  };
}
