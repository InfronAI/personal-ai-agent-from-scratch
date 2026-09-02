import assert from "node:assert/strict";
import test from "node:test";

import { runScenarioJudges } from "../evals/lib/judges.mjs";

function executionFixture() {
  return {
    item: {
      id: "judge-schema-case-001",
      input: { messages: [{ role: "user", content: "解释熵增。" }] },
      expected: { response: { min_chars: 10 } },
      metadata: { task_type: "stable_simple_qa", risk: "low", tags: [] }
    },
    error: null,
    result: { specialist: "copilot", answer: "熵增描述孤立系统总熵不减少。", runtime: [] }
  };
}

test("Judge Strict JSON 使用网关兼容 Schema，并在本地补足数组唯一性", async () => {
  let schema;
  const passed = await runScenarioJudges(executionFixture(), {
    requestCompletion: async request => {
      schema = request.responseFormat.json_schema.schema;
      return {
        content: JSON.stringify({ verdict: "pass", score: 1, failure_codes: ["none"], evidence_summary: "答案完成了稳定知识解释。", missing_inputs: ["none"] }),
        model: "openai/gpt-4o"
      };
    },
    model: "openai/gpt-4o",
    requestIdPrefix: "judge-schema-test",
    definitionIds: ["answer_task_success"]
  });
  assert.equal(schema.properties.failure_codes.uniqueItems, undefined);
  assert.equal(schema.properties.failure_codes.minItems, 1);
  assert.equal(schema.properties.failure_codes.items.enum.includes("route_wrong_mode"), false);
  assert.equal(passed[0].status, "pass");

  const duplicated = await runScenarioJudges(executionFixture(), {
    requestCompletion: async () => ({
      content: JSON.stringify({ verdict: "fail", score: 0, failure_codes: ["answer_incorrect", "answer_incorrect"], evidence_summary: "重复编码。", missing_inputs: ["none"] }),
      model: "openai/gpt-4o"
    }),
    model: "openai/gpt-4o",
    requestIdPrefix: "judge-duplicate-test",
    definitionIds: ["answer_task_success"]
  });
  assert.equal(duplicated[0].status, "error");
  assert.match(duplicated[0].reason, /不允许重复/u);
});
