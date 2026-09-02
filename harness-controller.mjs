import { performance } from "node:perf_hooks";

import { AppError } from "./errors.mjs";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

export function normalizedToolSignature(name, args) {
  return `${String(name || "")}:${JSON.stringify(stableValue(args || {}))}`;
}

function completionFingerprint(agentName, completion) {
  return JSON.stringify({
    agentName,
    content: String(completion?.content || "").trim(),
    tools: (completion?.toolCalls || []).map(call => ({
      name: call.function?.name || "",
      arguments: stableValue(typeof call.function?.arguments === "string"
        ? (() => { try { return JSON.parse(call.function.arguments); } catch { return call.function.arguments; } })()
        : call.function?.arguments || {})
    }))
  });
}

export function createHarnessController({
  maxToolCalls,
  maxNoProgressIterations,
  deadlineMs,
  clock = () => performance.now()
}) {
  const startedAt = clock();
  const results = new Map();
  const fingerprints = new Map();
  let toolProposals = 0;
  let toolExecutions = 0;
  let deduplicatedTools = 0;
  let modelCalls = 0;

  function assertWithinDeadline() {
    if (clock() - startedAt > deadlineMs) {
      throw new AppError("Agent 已超过本轮执行时限", { code: "agent_deadline_exceeded", status: 504, retryable: true, expose: true });
    }
  }

  function beforeModelCall() {
    assertWithinDeadline();
    modelCalls += 1;
  }

  function afterModelCall(agentName, completion) {
    assertWithinDeadline();
    const fingerprint = completionFingerprint(agentName, completion);
    const previous = fingerprints.get(agentName);
    const repeated = previous?.fingerprint === fingerprint ? previous.repeated + 1 : 0;
    fingerprints.set(agentName, { fingerprint, repeated });
    if (repeated >= maxNoProgressIterations) {
      throw new AppError("Agent 连续返回相同决策，已由无进展保护器终止", {
        code: "agent_no_progress",
        status: 422,
        expose: true,
        details: { agentName, repeated }
      });
    }
  }

  function prepareTool(name, args) {
    assertWithinDeadline();
    toolProposals += 1;
    if (toolProposals > maxToolCalls) {
      throw new AppError("Agent 已超过本轮工具调用预算", { code: "tool_budget_exceeded", status: 422, expose: true });
    }
    const signature = normalizedToolSignature(name, args);
    if (results.has(signature)) {
      deduplicatedTools += 1;
      return { action: "reuse", signature, result: structuredClone(results.get(signature)) };
    }
    toolExecutions += 1;
    return { action: "execute", signature, result: null };
  }

  function completeTool(signature, result) {
    results.set(signature, structuredClone(result));
  }

  function status() {
    return {
      modelCalls,
      toolProposals,
      toolExecutions,
      deduplicatedTools,
      elapsedMs: Math.max(0, Math.round(clock() - startedAt)),
      deadlineMs,
      maxToolCalls,
      maxNoProgressIterations
    };
  }

  return Object.freeze({ assertWithinDeadline, beforeModelCall, afterModelCall, prepareTool, completeTool, status });
}

