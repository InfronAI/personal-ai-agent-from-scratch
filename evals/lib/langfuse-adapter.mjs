import crypto from "node:crypto";

import { datasetFingerprint } from "./dataset.mjs";
import { evaluateScenario } from "./evaluators.mjs";
import { sha256Value } from "./fingerprint.mjs";
import { runLiveScenario } from "./scripted-runtime.mjs";

export const LANGFUSE_DATASET_INPUT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "copilot 在线评测输入",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "caseId", "suite", "messages"],
  properties: {
    schemaVersion: { const: "copilot-langfuse-eval-input.v1" },
    caseId: { type: "string", minLength: 1 },
    suite: { type: "string", minLength: 1 },
    messages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "content"],
        properties: {
          role: { enum: ["system", "user", "assistant", "tool"] },
          content: { type: "string", minLength: 1 }
        }
      }
    },
    context: { type: "object" }
  }
});

export const LANGFUSE_DATASET_EXPECTED_OUTPUT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "copilot 在线评测预期契约",
  type: "object",
  additionalProperties: false,
  properties: {
    route: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { enum: ["direct", "delegate"] },
        specialist: { type: ["string", "null"] }
      }
    },
    tools: {
      type: "object",
      additionalProperties: false,
      properties: {
        required: { type: "array", items: { type: "string" } },
        forbidden: { type: "array", items: { type: "string" } },
        require_success: { type: "array", items: { type: "string" } },
        require_error: { type: "array", items: { type: "string" } },
        success_severity: { enum: ["blocking", "diagnostic"] },
        forbid_duplicates: { type: "boolean" },
        duplicate_severity: { enum: ["blocking", "diagnostic"] }
      }
    },
    response: {
      type: "object",
      additionalProperties: false,
      properties: {
        language: { type: "string" },
        min_chars: { type: "integer", minimum: 0 },
        must_include: { type: "array", items: { type: "string" } },
        must_not_include: { type: "array", items: { type: "string" } },
        format: { enum: ["json"] }
      }
    },
    trace: {
      type: "object",
      additionalProperties: false,
      properties: {
        required_kinds: { type: "array", items: { type: "string" } }
      }
    },
    search: {
      type: "object",
      additionalProperties: false,
      properties: { query_contains: { type: "string" } }
    },
    memory: {
      type: "object",
      additionalProperties: false,
      properties: { write: { type: "boolean" } }
    },
    artifacts: {
      type: "object",
      additionalProperties: false,
      properties: { generated_count: { type: "integer", minimum: 0 } }
    },
    error: {
      type: "object",
      additionalProperties: false,
      properties: { code: { type: "string" } }
    }
  }
});

export const LANGFUSE_DATASET_SCHEMA_FINGERPRINT = sha256Value({
  input: LANGFUSE_DATASET_INPUT_SCHEMA,
  expectedOutput: LANGFUSE_DATASET_EXPECTED_OUTPUT_SCHEMA
});

function stableDatasetItemId(datasetName, caseId) {
  const digest = crypto.createHash("sha256").update(`${datasetName}\u0000${caseId}`).digest("hex").slice(0, 32);
  return `copilot-${digest}`;
}

function copyContext(input) {
  const context = {};
  if (Array.isArray(input.artifact_ids)) context.artifact_ids = structuredClone(input.artifact_ids);
  if (Array.isArray(input.artifact_names)) context.artifact_names = structuredClone(input.artifact_names);
  if (Array.isArray(input.memory_seed)) context.memory_seed = structuredClone(input.memory_seed);
  return context;
}

export function toLangfuseDatasetItem(item, datasetName) {
  const context = copyContext(item.input);
  return {
    datasetName,
    id: stableDatasetItemId(datasetName, item.id),
    input: {
      schemaVersion: "copilot-langfuse-eval-input.v1",
      caseId: item.id,
      suite: item.suite,
      messages: structuredClone(item.input.messages),
      ...(Object.keys(context).length ? { context } : {})
    },
    expectedOutput: structuredClone(item.expected),
    metadata: {
      schema_version: "copilot-langfuse-dataset-item.v1",
      case_id: item.id,
      suite: item.suite,
      ...structuredClone(item.metadata)
    }
  };
}

function isNotFound(error) {
  return error?.statusCode === 404 || error?.status === 404 || error?.response?.status === 404;
}

async function ensureDataset(client, { name, description, metadata }) {
  try {
    const dataset = await client.api.datasets.get(name);
    const existingSchemaVersion = dataset?.metadata?.schema_version;
    if (existingSchemaVersion && existingSchemaVersion !== metadata.schema_version) {
      throw new Error(`Langfuse Dataset ${name} 使用 ${existingSchemaVersion}，当前同步要求 ${metadata.schema_version}；请创建新的 Dataset 名称。`);
    }
    const existingSchemaFingerprint = dataset?.metadata?.dataset_schema_fingerprint;
    if (existingSchemaFingerprint && existingSchemaFingerprint !== metadata.dataset_schema_fingerprint) {
      throw new Error(`Langfuse Dataset ${name} 的字段 Schema 已变化；请创建新的 Dataset 名称。`);
    }
    return { dataset, created: false };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const dataset = await client.api.datasets.create({
    name,
    description,
    metadata,
    inputSchema: LANGFUSE_DATASET_INPUT_SCHEMA,
    expectedOutputSchema: LANGFUSE_DATASET_EXPECTED_OUTPUT_SCHEMA
  });
  return { dataset, created: true };
}

async function parallelMap(items, concurrency, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function syncLangfuseDataset({
  client,
  items,
  datasetName,
  datasetDescription = "copilot 真实 Agent 工作流的版本化在线评测集。数据由仓库内受评审的 JSONL 样本同步。",
  includeNonLive = false,
  concurrency = 4,
  configurationFingerprint = null
}) {
  if (!client) throw new Error("Langfuse 客户端尚未配置。");
  const selected = includeNonLive ? items : items.filter(item => item.metadata.live_eligible === true);
  if (!selected.length) throw new Error("没有符合当前同步条件的评测样本。");
  const versions = [...new Set(selected.map(item => item.metadata.dataset_version))].sort();
  const contentFingerprint = datasetFingerprint(selected);
  const ensured = await ensureDataset(client, {
    name: datasetName,
    description: datasetDescription,
    metadata: {
      schema_version: "copilot-langfuse-dataset.v1",
      dataset_schema_fingerprint: LANGFUSE_DATASET_SCHEMA_FINGERPRINT,
      dataset_versions: versions,
      dataset_fingerprint: contentFingerprint,
      execution_profile: includeNonLive ? "all" : "live-eligible",
      synchronized_by: "copilot-eval-cli",
      eval_config_fingerprint: configurationFingerprint
    }
  });
  const requests = selected.map(item => toLangfuseDatasetItem(item, datasetName));
  await parallelMap(requests, Math.max(1, Math.min(10, concurrency)), request => client.dataset.createItem(request));
  await client.flush?.();
  return {
    datasetName,
    configurationFingerprint,
    datasetFingerprint: contentFingerprint,
    created: ensured.created,
    selectedItems: requests.length,
    omittedItems: items.length - requests.length,
    versions,
    itemIds: requests.map(request => request.id)
  };
}

function evaluationItemFromExperiment({ input, expectedOutput, metadata }) {
  return {
    id: input.caseId,
    suite: input.suite,
    input: {
      messages: input.messages,
      ...(input.context || {})
    },
    expected: expectedOutput || {},
    metadata: {
      dataset_version: metadata?.dataset_version || "langfuse-remote",
      label_status: metadata?.label_status || "draft",
      task_type: metadata?.task_type || "unknown",
      risk: metadata?.risk || "unknown",
      source: metadata?.source || "langfuse",
      ...metadata
    }
  };
}

function serializableError(error) {
  if (!error) return null;
  return {
    name: error.name || "Error",
    code: error.code || null,
    message: error.message || String(error)
  };
}

export function createAgentExperimentTask({ runAgentTurn }) {
  return async ({ input, expectedOutput, metadata }) => {
    const item = evaluationItemFromExperiment({ input, expectedOutput, metadata });
    const execution = await runLiveScenario(item, { runAgentTurn });
    return {
      schemaVersion: "copilot-langfuse-experiment-output.v1",
      answer: execution.result?.answer || null,
      specialist: execution.result?.specialist || null,
      intent: execution.result?.intent || null,
      model: execution.result?.model || null,
      resolvedModel: execution.result?.resolvedModel || null,
      traceId: execution.result?.traceId || null,
      sessionId: execution.result?.sessionId || execution.input.sessionId,
      requestId: execution.result?.requestId || execution.input.requestId,
      runtime: execution.result?.runtime || [],
      harness: execution.result?.harness || null,
      artifacts: execution.result?.artifacts || [],
      memory: execution.result?.memory || null,
      wallTimeMs: execution.wallTimeMs ? Math.round(execution.wallTimeMs) : null,
      error: serializableError(execution.error),
      evaluationContext: {
        input: execution.input,
        records: execution.records
      }
    };
  };
}

function scoreName(evaluator) {
  return `copilot.${String(evaluator).replace(/[^a-zA-Z0-9_.:-]+/gu, "_").slice(0, 180)}`;
}

export function createAgentContractEvaluator() {
  return async ({ input, output, expectedOutput, metadata }) => {
    const item = evaluationItemFromExperiment({ input, expectedOutput, metadata });
    const serializedError = output?.error;
    const error = serializedError
      ? Object.assign(new Error(serializedError.message), { name: serializedError.name, code: serializedError.code })
      : null;
    const execution = {
      item,
      input: output?.evaluationContext?.input || {},
      result: error ? null : output,
      records: output?.evaluationContext?.records || { streamedEvents: [], memoryWrites: [] },
      error
    };
    return evaluateScenario(execution).map(itemCheck => ({
      name: scoreName(itemCheck.evaluator),
      value: itemCheck.status === "pass",
      dataType: "BOOLEAN",
      comment: itemCheck.reason,
      metadata: {
        evaluator_version: itemCheck.evaluatorVersion,
        severity: itemCheck.severity,
        status: itemCheck.status,
        scope_id: itemCheck.scopeId,
        evidence: itemCheck.evidence
      }
    }));
  };
}

export function createAgentRunEvaluator() {
  return async ({ itemResults }) => {
    const evaluations = itemResults.flatMap(item => item.evaluations || []);
    const blocking = evaluations.filter(score => score.metadata?.severity === "blocking");
    const passed = blocking.filter(score => score.value === true || score.value === 1).length;
    const passedCases = itemResults.filter(item => (item.evaluations || [])
      .filter(score => score.metadata?.severity === "blocking")
      .every(score => score.value === true || score.value === 1)).length;
    return [
      {
        name: "copilot.blocking_check_pass_rate",
        value: blocking.length ? passed / blocking.length : 0,
        dataType: "NUMERIC",
        comment: `${passed}/${blocking.length} 项阻断契约通过。`
      },
      {
        name: "copilot.case_pass_rate",
        value: itemResults.length ? passedCases / itemResults.length : 0,
        dataType: "NUMERIC",
        comment: `${passedCases}/${itemResults.length} 个样本通过全部阻断契约。`
      }
    ];
  };
}

export async function runLangfuseExperiment({
  client,
  runAgentTurn,
  datasetName,
  experimentName = "copilot Agent 系统评测",
  runName,
  description = "在受版本控制的数据集上执行真实 copilot 工作流，并记录逐项契约分数。",
  maxConcurrency = 2,
  metadata = {}
}) {
  if (!client) throw new Error("Langfuse 客户端尚未配置。");
  const dataset = await client.dataset.get(datasetName);
  return dataset.runExperiment({
    name: experimentName,
    runName,
    description,
    metadata: {
      schema_version: "copilot-langfuse-experiment.v1",
      model_policy: "config-driven",
      ...metadata
    },
    task: createAgentExperimentTask({ runAgentTurn }),
    evaluators: [createAgentContractEvaluator()],
    runEvaluators: [createAgentRunEvaluator()],
    maxConcurrency: Math.max(1, Math.min(10, maxConcurrency))
  });
}

export function summarizeLangfuseExperiment(result) {
  return {
    schemaVersion: "copilot-langfuse-experiment-summary.v1",
    experimentId: result.experimentId,
    runName: result.runName,
    datasetRunId: result.datasetRunId || null,
    datasetRunUrl: result.datasetRunUrl || null,
    cases: result.itemResults.map(item => ({
      caseId: item.input?.caseId || item.item?.metadata?.case_id || null,
      traceId: item.traceId || item.output?.traceId || null,
      error: item.output?.error || null,
      scores: (item.evaluations || []).map(score => ({
        name: score.name,
        value: score.value,
        dataType: score.dataType,
        comment: score.comment || null,
        metadata: score.metadata || null
      }))
    })),
    runScores: result.runEvaluations || []
  };
}
