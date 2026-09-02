import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { agentRegistry } from "../../agents/registry.mjs";

const ROOT_AGENT_ID = agentRegistry.rootAgentId;

const FAILURE_CODES_BY_DEFINITION = Object.freeze({
  intent_semantic_fit: Object.freeze([
    "none",
    "route_wrong_mode",
    "route_wrong_specialist",
    "freshness_missed",
    "risk_missed"
  ]),
  answer_task_success: Object.freeze([
    "none",
    "answer_irrelevant",
    "answer_incorrect",
    "answer_incomplete",
    "language_mismatch",
    "format_violation",
    "unsupported_claim",
    "citation_invalid",
    "unsafe_advice",
    "tool_result_ignored",
    "tool_result_fabricated"
  ])
});
const FAILURE_CODES = Object.freeze([...new Set(Object.values(FAILURE_CODES_BY_DEFINITION).flat())]);

const MISSING_INPUTS = Object.freeze([
  "none",
  "reference_facts",
  "tool_evidence",
  "conversation_context",
  "risk_policy"
]);

function outputSchema(definitionId) {
  const failureCodes = FAILURE_CODES_BY_DEFINITION[definitionId];
  if (!failureCodes) throw new Error(`Judge ${definitionId} 没有 Failure Code 协议。`);
  return {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "score", "failure_codes", "evidence_summary", "missing_inputs"],
    properties: {
      verdict: { type: "string", enum: ["pass", "fail", "uncertain", "not_applicable"] },
      score: { type: "number", minimum: 0, maximum: 1 },
      failure_codes: { type: "array", items: { type: "string", enum: failureCodes }, minItems: 1, maxItems: 5 },
      evidence_summary: { type: "string", minLength: 1, maxLength: 600 },
      missing_inputs: { type: "array", items: { type: "string", enum: MISSING_INPUTS }, minItems: 1, maxItems: 5 }
    }
  };
}

const defaultCatalogPath = new URL("../evaluators/judges.v1.json", import.meta.url);

export function loadJudgeDefinitions(path = defaultCatalogPath) {
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(path instanceof URL ? path : resolve(path), "utf8"));
  } catch (error) {
    throw new Error(`无法读取 Judge Catalog：${error.message}`);
  }
  if (catalog.schemaVersion !== "copilot-judge-catalog.v1") throw new Error("Judge Catalog schemaVersion 必须是 copilot-judge-catalog.v1。");
  if (!Array.isArray(catalog.definitions) || !catalog.definitions.length) throw new Error("Judge Catalog 至少需要一个定义。");
  const ids = new Set();
  const definitions = catalog.definitions.map((definition, index) => {
    const location = `Judge Catalog definitions[${index}]`;
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new Error(`${location} 必须是对象。`);
    const keys = Object.keys(definition).sort();
    const expectedKeys = ["calibrationStatus", "id", "systemPrompt", "version"].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) throw new Error(`${location} 字段必须严格等于：${expectedKeys.join(", ")}。`);
    if (!/^[a-z][a-z0-9_]{2,79}$/u.test(definition.id)) throw new Error(`${location}.id 无效。`);
    if (ids.has(definition.id)) throw new Error(`Judge ID 重复：${definition.id}。`);
    if (!/^\d+\.\d+\.\d+$/u.test(definition.version)) throw new Error(`${location}.version 必须使用语义版本。`);
    if (!["uncalibrated", "calibrating", "calibrated"].includes(definition.calibrationStatus)) throw new Error(`${location}.calibrationStatus 无效。`);
    if (typeof definition.systemPrompt !== "string" || definition.systemPrompt.trim().length < 80) throw new Error(`${location}.systemPrompt 过短或为空。`);
    ids.add(definition.id);
    return Object.freeze({ ...definition });
  });
  return Object.freeze(definitions);
}

export const JUDGE_DEFINITIONS = loadJudgeDefinitions();

function observedEvidence(execution) {
  const runtime = execution.result?.runtime || [];
  const expectedContract = structuredClone(execution.item.expected);
  if (execution.mode === "live" && (expectedContract.response?.reference_answer || execution.item.input.search_results || execution.item.input.search_answer)) {
    delete expectedContract.response?.must_include;
  }
  return {
    conversation: execution.item.input.messages,
    expected_contract: expectedContract,
    observed_route: {
      mode: execution.result?.specialist && execution.result.specialist !== ROOT_AGENT_ID ? "delegate" : "direct",
      specialist: execution.result?.specialist || null
    },
    observed_tools: runtime.filter(event => event.kind === "TOOL CALL").map(event => ({
      name: event.name,
      status: event.status,
      input: event.input,
      output: event.output
    })),
    final_answer: execution.result?.answer || null,
    task_metadata: {
      task_type: execution.item.metadata.task_type,
      risk: execution.item.metadata.risk,
      tags: execution.item.metadata.tags || []
    }
  };
}

function validateJudgeOutput(value, definitionId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Judge 输出必须是对象");
  const keys = Object.keys(value).sort();
  const expectedKeys = ["evidence_summary", "failure_codes", "missing_inputs", "score", "verdict"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) throw new Error(`Judge 输出字段必须严格等于：${expectedKeys.join(", ")}`);
  if (!["pass", "fail", "uncertain", "not_applicable"].includes(value.verdict)) throw new Error(`Judge verdict 无效：${value.verdict}`);
  if (!Number.isFinite(value.score) || value.score < 0 || value.score > 1) throw new Error("Judge score 必须在 0 到 1 之间");
  const allowedFailureCodes = FAILURE_CODES_BY_DEFINITION[definitionId] || FAILURE_CODES;
  if (!Array.isArray(value.failure_codes) || value.failure_codes.length < 1 || value.failure_codes.length > 5 || value.failure_codes.some(code => !allowedFailureCodes.includes(code))) throw new Error("Judge failure_codes 包含无效值");
  if (!Array.isArray(value.missing_inputs) || value.missing_inputs.length < 1 || value.missing_inputs.length > 5 || value.missing_inputs.some(code => !MISSING_INPUTS.includes(code))) throw new Error("Judge missing_inputs 包含无效值");
  if (new Set(value.failure_codes).size !== value.failure_codes.length) throw new Error("Judge failure_codes 不允许重复");
  if (new Set(value.missing_inputs).size !== value.missing_inputs.length) throw new Error("Judge missing_inputs 不允许重复");
  if (value.failure_codes.includes("none") && value.failure_codes.length !== 1) throw new Error("Judge failure_codes 中 none 必须单独出现");
  if (value.missing_inputs.includes("none") && value.missing_inputs.length !== 1) throw new Error("Judge missing_inputs 中 none 必须单独出现");
  if (typeof value.evidence_summary !== "string" || !value.evidence_summary.trim() || value.evidence_summary.length > 600) throw new Error("Judge evidence_summary 无效");
  if (value.verdict === "pass" && (value.failure_codes.length !== 1 || value.failure_codes[0] !== "none")) throw new Error("Judge 通过时 failure_codes 必须严格为 ['none']");
  if (value.verdict === "fail" && value.failure_codes.includes("none")) throw new Error("Judge 失败时必须返回具体 failure_codes");
  return value;
}

export function selectJudgeDefinitions(definitionIds = JUDGE_DEFINITIONS.map(definition => definition.id), catalog = JUDGE_DEFINITIONS) {
  const definitions = definitionIds.map(id => catalog.find(definition => definition.id === id));
  const unknown = definitionIds.filter((id, index) => !definitions[index]);
  if (unknown.length) throw new Error(`未知 Judge 定义：${unknown.join(", ")}。`);
  if (!definitions.length) throw new Error("至少需要启用一个 Judge 定义。");
  return definitions;
}

export async function runScenarioJudges(execution, {
  requestCompletion,
  model,
  requestIdPrefix,
  definitionIds,
  definitions = JUDGE_DEFINITIONS,
  temperature = 0,
  maxTokens = 900
}) {
  if (execution.error || !execution.result) return [];
  const evidence = observedEvidence(execution);
  const results = [];
  for (const definition of selectJudgeDefinitions(definitionIds, definitions)) {
    try {
      const completion = await requestCompletion({
        model,
        messages: [
          { role: "system", content: definition.systemPrompt },
          { role: "user", content: JSON.stringify(evidence) }
        ],
        temperature,
        maxTokens,
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: `agent_eval_${definition.id}_v1`,
            strict: true,
            schema: outputSchema(definition.id)
          }
        },
        requestId: `${requestIdPrefix}-${definition.id}`.slice(0, 200)
      });
      let parsed;
      try { parsed = JSON.parse(completion.content); }
      catch (error) { throw new Error(`Judge returned invalid JSON: ${error.message}`); }
      const output = validateJudgeOutput(parsed, definition.id);
      results.push({
        scopeId: execution.item.id,
        evaluator: definition.id,
        evaluatorVersion: definition.version,
        severity: "diagnostic",
        status: output.verdict === "pass" ? "pass" : "fail",
        score: output.score,
        reason: output.evidence_summary,
        evidence: {
          verdict: output.verdict,
          failure_codes: output.failure_codes,
          missing_inputs: output.missing_inputs,
          judgeModel: model,
          resolvedModel: completion.model,
          calibrationStatus: definition.calibrationStatus
        }
      });
    } catch (error) {
      results.push({
        scopeId: execution.item.id,
        evaluator: definition.id,
        evaluatorVersion: definition.version,
        severity: "diagnostic",
        status: "error",
        score: 0,
        reason: error.message,
        evidence: { judgeModel: model, calibrationStatus: definition.calibrationStatus }
      });
    }
  }
  return results;
}
