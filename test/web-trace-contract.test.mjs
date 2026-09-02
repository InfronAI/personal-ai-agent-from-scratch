import assert from "node:assert/strict";
import test from "node:test";

import { orderedTraceEvents, traceContractErrors, traceEventForest, upsertRuntimeEvent } from "../src/web/trace-contract.mjs";

test("前端 Trace Store 按 id 增量更新且保持 DAG 顺序", () => {
  const events = [];
  upsertRuntimeEvent(events, { id: "child", parentId: "root", sequence: 2, status: "running" });
  upsertRuntimeEvent(events, { id: "root", parentId: null, sequence: 1, status: "completed" });
  upsertRuntimeEvent(events, { id: "child", parentId: "root", sequence: 2, status: "completed" });
  assert.equal(events.length, 2);
  assert.equal(events.find(item => item.id === "child").status, "completed");
  assert.deepEqual(orderedTraceEvents(events).map(item => item.id), ["root", "child"]);
  assert.deepEqual(traceContractErrors(events), []);
});

test("Agent DAG 完全根据 parentId 计算层级，不信任调用方提供的 depth", () => {
  const events = [
    { id: "tool", parentId: "generation", sequence: 4, depth: 0, kind: "TOOL CALL" },
    { id: "root", parentId: null, sequence: 1, depth: 7, kind: "CHAIN" },
    { id: "agent", parentId: "root", sequence: 2, depth: 0, kind: "AGENT RUN" },
    { id: "generation", parentId: "agent", sequence: 3, depth: 1, kind: "GENERATION" },
    { id: "sibling", parentId: "agent", sequence: 5, depth: 7, kind: "SPAN" }
  ];
  const forest = traceEventForest(events);

  assert.equal(forest.length, 1);
  assert.equal(forest[0].event.id, "root");
  assert.equal(forest[0].descendantCount, 4);
  assert.deepEqual(
    orderedTraceEvents(events).map(event => [event.id, event.depth]),
    [["root", 0], ["agent", 1], ["generation", 2], ["tool", 3], ["sibling", 2]]
  );
});

test("Agent DAG 将孤儿与环路安全提升为根节点并报告协议错误", () => {
  const events = [
    { id: "orphan", parentId: "missing", sequence: 1 },
    { id: "cycle-a", parentId: "cycle-b", sequence: 2 },
    { id: "cycle-b", parentId: "cycle-a", sequence: 3 }
  ];
  const forest = traceEventForest(events);

  assert.deepEqual(forest.map(node => node.event.id), ["orphan", "cycle-a", "cycle-b"]);
  assert.deepEqual(orderedTraceEvents(events).map(event => event.depth), [0, 0, 0]);
  assert.ok(traceContractErrors(events).some(error => error.includes("missing parent")));
  assert.ok(traceContractErrors(events).some(error => error.includes("cycle in its parent chain")));
});
