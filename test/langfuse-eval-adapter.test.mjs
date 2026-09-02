import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadDataset } from "../evals/lib/dataset.mjs";
import {
  createAgentContractEvaluator,
  createAgentExperimentTask,
  createAgentRunEvaluator,
  runLangfuseExperiment,
  syncLangfuseDataset,
  toLangfuseDatasetItem,
  LANGFUSE_DATASET_SCHEMA_FINGERPRINT
} from "../evals/lib/langfuse-adapter.mjs";

const coreItems = loadDataset(fileURLToPath(new URL("../evals/datasets/copilot-core.v3.jsonl", import.meta.url)));

test("Langfuse 数据集映射不会泄漏脚本答案或伪搜索结果", () => {
  const source = coreItems.find(item => item.id === "core-research-current-001");
  const mapped = toLangfuseDatasetItem(source, "copilot-test");
  assert.equal(mapped.datasetName, "copilot-test");
  assert.match(mapped.id, /^copilot-[a-f0-9]{32}$/u);
  assert.equal(mapped.input.caseId, source.id);
  assert.deepEqual(mapped.input.messages, source.input.messages);
  assert.equal("script" in mapped.input, false);
  assert.equal("search_results" in mapped.input, false);
  assert.deepEqual(mapped.expectedOutput, source.expected);
  assert.equal(mapped.metadata.case_id, source.id);

  const artifactSource = coreItems.find(item => item.id === "core-artifact-analysis-001");
  const artifactMapped = toLangfuseDatasetItem(artifactSource, "copilot-test");
  assert.deepEqual(artifactMapped.input.context.artifact_names, ["product-brief.md"]);
  assert.equal(JSON.stringify(artifactMapped.input).includes("支付接口尚未完成联调"), false);
});

test("Langfuse 数据集同步默认只写入允许在线运行的样本", async () => {
  const createdDatasets = [];
  const createdItems = [];
  let flushed = 0;
  const client = {
    api: {
      datasets: {
        get: async () => { throw Object.assign(new Error("不存在"), { statusCode: 404 }); },
        create: async request => {
          createdDatasets.push(request);
          return { id: "dataset-1", ...request };
        }
      }
    },
    dataset: { createItem: async request => createdItems.push(request) },
    flush: async () => { flushed += 1; }
  };
  const summary = await syncLangfuseDataset({ client, items: coreItems, datasetName: "copilot-test", concurrency: 3, configurationFingerprint: "config-fingerprint" });
  const expectedCount = coreItems.filter(item => item.metadata.live_eligible === true).length;
  assert.equal(summary.created, true);
  assert.equal(summary.selectedItems, expectedCount);
  assert.equal(summary.omittedItems, coreItems.length - expectedCount);
  assert.equal(summary.configurationFingerprint, "config-fingerprint");
  assert.match(summary.datasetFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(createdDatasets[0].metadata.dataset_fingerprint, summary.datasetFingerprint);
  assert.equal(createdDatasets[0].metadata.dataset_schema_fingerprint, LANGFUSE_DATASET_SCHEMA_FINGERPRINT);
  assert.equal(createdDatasets.length, 1);
  assert.equal(createdItems.length, expectedCount);
  assert.equal(flushed, 1);
});

test("Langfuse 同步拒绝覆盖不同协议版本的既有 Dataset", async () => {
  const client = {
    api: {
      datasets: {
        get: async () => ({ name: "copilot-test", metadata: { schema_version: "legacy-dataset.v0" } })
      }
    },
    dataset: { createItem: async () => {} }
  };
  await assert.rejects(
    syncLangfuseDataset({ client, items: coreItems, datasetName: "copilot-test" }),
    /请创建新的 Dataset 名称/u
  );
});

test("真实实验任务使用样本消息并返回可评测执行上下文", async () => {
  const calls = [];
  const task = createAgentExperimentTask({
    runAgentTurn: async request => {
      calls.push(request);
      return {
        answer: "测试回答",
        specialist: "copilot",
        intent: { domain: "general" },
        model: "model-router",
        resolvedModel: "provider/model",
        traceId: "trace-1",
        sessionId: request.sessionId,
        requestId: request.requestId,
        runtime: [],
        memory: { stored: true, memory_id: "memory-1" },
        artifacts: []
      };
    }
  });
  const output = await task({
    input: {
      schemaVersion: "copilot-langfuse-eval-input.v1",
      caseId: "case-1",
      suite: "unit",
      messages: [{ role: "assistant", content: "上下文" }, { role: "user", content: "问题" }]
    },
    expectedOutput: {},
    metadata: { dataset_version: "v1", label_status: "draft" }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, "问题");
  assert.deepEqual(calls[0].history, [{ role: "assistant", content: "上下文" }]);
  assert.equal(output.answer, "测试回答");
  assert.equal(output.evaluationContext.records.memoryWrites.length, 1);
});

test("Langfuse 契约评测器输出布尔结构化分数", async () => {
  const evaluator = createAgentContractEvaluator();
  const scores = await evaluator({
    input: {
      caseId: "case-error",
      suite: "error",
      messages: [{ role: "user", content: "问题" }]
    },
    expectedOutput: {},
    metadata: { dataset_version: "v1", label_status: "draft" },
    output: {
      error: { name: "Error", code: "failed", message: "执行失败" },
      evaluationContext: { input: {}, records: { streamedEvents: [], memoryWrites: [] } }
    }
  });
  assert.equal(scores.length, 1);
  assert.equal(scores[0].name, "copilot.scenario_execution");
  assert.equal(scores[0].dataType, "BOOLEAN");
  assert.equal(scores[0].value, false);
  assert.equal(scores[0].metadata.severity, "blocking");
});

test("Langfuse 运行级评测器聚合阻断契约和样本通过率", async () => {
  const evaluator = createAgentRunEvaluator();
  const scores = await evaluator({
    itemResults: [
      { evaluations: [{ value: true, metadata: { severity: "blocking" } }] },
      { evaluations: [{ value: false, metadata: { severity: "blocking" } }, { value: false, metadata: { severity: "diagnostic" } }] }
    ]
  });
  assert.equal(scores.find(score => score.name === "copilot.blocking_check_pass_rate").value, 0.5);
  assert.equal(scores.find(score => score.name === "copilot.case_pass_rate").value, 0.5);
});

test("Langfuse 数据集实验接入真实任务与两层评测器", async () => {
  let received = null;
  const expectedResult = { experimentId: "exp-1", runName: "run-1", itemResults: [], runEvaluations: [] };
  const client = {
    dataset: {
      get: async name => ({
        name,
        runExperiment: async config => {
          received = config;
          return expectedResult;
        }
      })
    }
  };
  const result = await runLangfuseExperiment({
    client,
    runAgentTurn: async () => ({}),
    datasetName: "copilot-test",
    runName: "run-1",
    maxConcurrency: 3
  });
  assert.equal(result, expectedResult);
  assert.equal(received.runName, "run-1");
  assert.equal(received.maxConcurrency, 3);
  assert.equal(received.evaluators.length, 1);
  assert.equal(received.runEvaluators.length, 1);
});
