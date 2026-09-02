import assert from "node:assert/strict";
import test from "node:test";

import { completionBudgets } from "../llm-gateway.mjs";


test("自动路由空结果使用有界的渐进 Token 预算重试", () => {
  assert.deepEqual(completionBudgets(1200, 2, 4800), [1200, 2400, 4800]);
  assert.deepEqual(completionBudgets(3000, 3, 4800), [3000, 4800, 4800, 4800]);
});
