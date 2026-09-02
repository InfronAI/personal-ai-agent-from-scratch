import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeRecorder, validateRuntimeEvents } from "../runtime-events.mjs";

test("运行事件在实时更新后仍保持稳定顺序和完整父子关系", () => {
  let clock = Date.parse("2026-08-31T00:00:00.000Z");
  const streamed = [];
  const recorder = createRuntimeRecorder({
    sessionId: "session-1",
    requestId: "request-1",
    now: () => clock,
    onEvent: event => streamed.push(event)
  });
  recorder.setTraceId("trace-1");
  recorder.record({ id: "root", kind: "CHAIN", name: "invocation", status: "running", parentId: null });
  clock += 25;
  recorder.record({ id: "child", kind: "SPAN", name: "call_llm", status: "completed", parentId: "root" });
  clock += 75;
  recorder.record({ id: "root", kind: "CHAIN", name: "invocation", status: "completed", parentId: null });

  const events = recorder.snapshot();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => event.sequence), [1, 2]);
  assert.equal(events[0].durationMs, 100);
  assert.equal(events[1].parentId, "root");
  assert.equal(streamed.length, 3);
  assert.deepEqual(validateRuntimeEvents(events), { valid: true, errors: [] });
});

