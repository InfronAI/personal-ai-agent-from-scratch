import { config } from "./config.mjs";
import { AppError } from "./errors.mjs";
import { fetchWithRetry } from "./http-client.mjs";

function usageDetails(payload) {
  const usage = payload.usage || {};
  return {
    input: Number(usage.prompt_tokens || 0),
    output: Number(usage.completion_tokens || 0),
    total: Number(usage.total_tokens || 0),
    cachedInput: Number(usage.prompt_tokens_details?.cached_tokens || 0),
    reasoning: Number(usage.completion_tokens_details?.reasoning_tokens || 0)
  };
}

function messageContent(value) {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.map(item => typeof item === "string" ? item : item?.text || "").join("").trim();
}

export function completionBudgets(initial, retries, maximum) {
  const first = Math.max(1, Number(initial) || 1);
  const cap = Math.max(first, Number(maximum) || first);
  return Array.from({ length: Math.max(0, Number(retries) || 0) + 1 }, (_, attempt) => (
    Math.min(cap, first * (2 ** attempt))
  ));
}

export async function requestCompletion({
  messages,
  model,
  temperature = 0,
  maxTokens = 900,
  responseFormat = null,
  tools = [],
  signal,
  requestId,
  connection = null
}) {
  const requestedModel = String(model || "").trim();
  if (!requestedModel) {
    throw new AppError("Model Router 没有提供具体模型", { code: "model_route_unavailable", status: 503, expose: true });
  }
  const gateway = {
    apiKey: connection?.apiKey || process.env.LLM_GATEWAY_API_KEY || config.llmGateway.apiKey,
    baseUrl: String(connection?.baseUrl || process.env.LLM_GATEWAY_BASE_URL || config.llmGateway.baseUrl).replace(/\/$/u, "")
  };
  if (!gateway.apiKey) {
    throw new AppError("LLM_GATEWAY_API_KEY is not configured", { code: "llm_not_configured", status: 503, expose: true });
  }
  const budgets = completionBudgets(maxTokens, config.llmGateway.completionRetries, config.llmGateway.maxCompletionTokens);
  const parentRequestId = requestId || "copilot-untracked";
  let lastEmptyResponse = null;
  for (let semanticAttempt = 0; semanticAttempt < budgets.length; semanticAttempt += 1) {
    const tokenBudget = budgets[semanticAttempt];
    try {
      const requestBody = {
        model: requestedModel,
        messages,
        temperature,
        max_tokens: tokenBudget,
        stream: false,
        provider: { allow_fallbacks: true, require_parameters: true }
      };
      if (responseFormat) requestBody.response_format = responseFormat;
      if (tools.length) {
        requestBody.tools = tools;
        requestBody.tool_choice = "auto";
      }
      const response = await fetchWithRetry(`${gateway.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${gateway.apiKey}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Connection": "close",
          "User-Agent": `Personal-Copilot-LLM-Gateway/${config.service.version}`,
          "X-Request-Id": semanticAttempt ? `${parentRequestId.slice(0, 180)}-r${semanticAttempt}` : parentRequestId,
          "X-Parent-Request-Id": parentRequestId
        },
        body: JSON.stringify(requestBody)
      }, { timeoutMs: config.llmGateway.timeoutMs, retries: config.llmGateway.retries, signal, service: "LLM Gateway" });
      const completionStartTime = new Date();
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: { message: text.slice(0, 500) } };
      }
      if (!response.ok) {
        throw new AppError(`LLM Gateway returned ${response.status}: ${payload?.error?.message || payload?.detail || "generation failed"}`, {
          code: "llm_upstream_error", status: response.status === 429 ? 429 : 502,
          retryable: response.status === 429 || response.status >= 500, expose: true
        });
      }
      const choice = payload.choices?.[0];
      const content = messageContent(choice?.message?.content);
      const toolCalls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [];
      const finishReason = String(choice?.finish_reason || "unknown");
      const incomplete = (!content && !toolCalls.length) || (finishReason === "length" && !toolCalls.length);
      if (incomplete && semanticAttempt < budgets.length - 1) {
        lastEmptyResponse = {
          finishReason,
          visibleCharacters: content.length,
          reasoningCharacters: String(choice?.message?.reasoning_content || choice?.message?.reasoning || "").length,
          tokenBudget
        };
        continue;
      }
      if (!content && !toolCalls.length) {
        lastEmptyResponse = {
          finishReason,
          visibleCharacters: 0,
          reasoningCharacters: String(choice?.message?.reasoning_content || choice?.message?.reasoning || "").length,
          tokenBudget
        };
        continue;
      }
      return {
        content,
        toolCalls,
        responseMessage: choice?.message || { role: "assistant", content },
        messages,
        model: String(payload.model || requestedModel),
        configuredModel: requestedModel,
        provider: String(payload.provider || "llm-gateway"),
        responseId: String(payload.id || "") || null,
        finishReason,
        completionStartTime,
        maxTokens: tokenBudget,
        completionRetries: semanticAttempt,
        usage: usageDetails(payload)
      };
    } catch (error) {
      if (error.name === "TimeoutError") throw new AppError(`LLM Gateway timed out after ${config.llmGateway.timeoutMs} ms`, { code: "llm_timeout", status: 504, retryable: true, expose: true });
      throw error;
    }
  }
  throw new AppError(
    `LLM Gateway returned no complete visible response after ${budgets.length} attempts`,
    { code: "llm_empty_completion", status: 502, retryable: true, expose: true, details: lastEmptyResponse }
  );
}
