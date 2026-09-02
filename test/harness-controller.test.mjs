import assert from "node:assert/strict";
import test from "node:test";

import { createHarnessController } from "../harness-controller.mjs";

test("Harness 对相同规范化工具调用只执行一次", () => {
  const harness = createHarnessController({ maxToolCalls: 4, maxNoProgressIterations: 2, deadlineMs: 1000 });
  const first = harness.prepareTool("load_memory", { query: "偏好", limit: 5 });
  assert.equal(first.action, "execute");
  harness.completeTool(first.signature, { status: "success", returned_count: 1 });
  const second = harness.prepareTool("load_memory", { limit: 5, query: "偏好" });
  assert.equal(second.action, "reuse");
  assert.equal(second.result.returned_count, 1);
  const status = harness.status();
  assert.deepEqual({ ...status, elapsedMs: 0 }, {
    modelCalls: 0,
    toolProposals: 2,
    toolExecutions: 1,
    deduplicatedTools: 1,
    elapsedMs: 0,
    deadlineMs: 1000,
    maxToolCalls: 4,
    maxNoProgressIterations: 2
  });
  assert.ok(status.elapsedMs >= 0 && status.elapsedMs <= 1000);
});

test("Harness 会终止连续重复且没有进展的模型决策", () => {
  const harness = createHarnessController({ maxToolCalls: 4, maxNoProgressIterations: 1, deadlineMs: 1000 });
  const completion = { content: "", toolCalls: [{ function: { name: "load_memory", arguments: "{\"query\":\"偏好\"}" } }] };
  harness.beforeModelCall();
  harness.afterModelCall("copilot", completion);
  harness.beforeModelCall();
  assert.throws(() => harness.afterModelCall("copilot", completion), error => error.code === "agent_no_progress");
});
