import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { fetchWithRetry } from "../http-client.mjs";

test("上游 Client 重试瞬时失败且保持请求内容", async () => {
  let attempts = 0;
  const server = createServer((request, response) => {
    attempts += 1;
    response.writeHead(attempts === 1 ? 503 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: attempts > 1, method: request.method }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetchWithRetry(`http://127.0.0.1:${port}/test`, { method: "POST", body: "payload" }, {
      timeoutMs: 1000, retries: 1, service: "test-upstream"
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).method, "POST");
    assert.equal(attempts, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
