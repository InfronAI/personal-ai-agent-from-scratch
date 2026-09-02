import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("..", import.meta.url));

function setupFixture({ completed = true, canManage = true, configured = true } = {}) {
  return {
    schemaVersion: "copilot-setup-state.v5",
    onboarding: { version: "core-configuration.v4", completed, completedAt: completed ? "2026-09-01T00:00:00.000Z" : null },
    administration: { webConfigurationEnabled: true, ownerClaimed: false, isOwner: false, canManage },
    requiredReady: configured,
    modelGateway: {
      configured,
      apiKeySource: configured ? "environment" : "missing",
      baseUrl: "https://llm.example/v1",
      intentionModel: "google/gemini-3.1-flash-lite"
    },
    evaluationJudge: {
      configured: true,
      model: "openai/gpt-4o",
      systemDefaultModel: "openai/gpt-4o",
      modelSource: "system-default",
      credentialRef: "LLM_GATEWAY_API_KEY",
      baseUrl: "https://llm.example/v1"
    },
    search: {
      configured,
      apiKeySource: configured ? "environment" : "missing",
      apiKeyConfigured: configured,
      baseUrl: "https://search.example/v1/tavily",
      credentialRef: "WEB_SEARCH_API_KEY"
    },
    tracing: {
      configured,
      active: configured,
      credentialSource: configured ? "environment" : "missing",
      publicKeyConfigured: configured,
      secretKeyConfigured: configured,
      baseUrl: "https://cloud.langfuse.com",
      destination: "https://cloud.langfuse.com",
      environment: "test",
      changesRequireRestart: true
    },
    runtimeConfiguration: { configured: false, updatedAt: null }
  };
}

test("生产 Web UI 不注入演示会话，且每次新建对话都会分配新 Session", async () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://copilot.local/", pretendToBeVisual: true });
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    fetch: globalThis.fetch
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    requestAnimationFrame: callback => callback(),
    fetch: async input => {
      const path = new URL(String(input), "http://copilot.local").pathname;
      const payload = path === "/api/auth/me"
        ? { authenticated: true, mode: "local-username", user: { user_id: "usr_0123456789abcdef0123456789abcdef", username: "Alice" } }
        : path === "/api/setup"
          ? setupFixture()
        : { sessions: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  try {
    await import(`../app.js?dom=${Date.now()}`);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.querySelectorAll(".history-row").length, 0);
    assert.ok(document.querySelector(".application-shell"));
    assert.equal(document.querySelectorAll(".primary-nav-item").length, 3);
    assert.equal(document.querySelector(".announcement"), null);
    assert.ok(document.querySelector(".product-mark svg .product-mark-core"));
    assert.ok(document.querySelector(".home-view"));
    assert.match(document.querySelector(".account-copy strong").textContent, /Alice/u);
    document.querySelector("[data-new-chat]").click();
    const firstHash = location.hash;
    document.querySelector("[data-new-chat]").click();
    assert.notEqual(location.hash, firstHash);
    assert.equal(document.querySelectorAll(".history-row").length, 2);
    assert.equal(document.querySelector(".home-eyebrow")?.textContent, "PERSONAL COPILOT");
  } finally {
    Object.assign(globalThis, original);
    dom.window.close();
  }
});

test("服务端历史首次加载立即刷新左栏，浏览器缓存配额失败也不阻断界面", async () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://copilot.local/", pretendToBeVisual: true });
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    fetch: globalThis.fetch
  };
  const storagePrototype = Object.getPrototypeOf(dom.window.localStorage);
  const setItemDescriptor = Object.getOwnPropertyDescriptor(storagePrototype, "setItem");
  let attemptedCache = null;
  Object.defineProperty(storagePrototype, "setItem", {
    configurable: true,
    value(key, value) {
      attemptedCache = { key, value };
      throw new dom.window.DOMException("Storage quota exceeded", "QuotaExceededError");
    }
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    requestAnimationFrame: callback => callback(),
    fetch: async input => {
      const path = new URL(String(input), "http://copilot.local").pathname;
      if (path === "/api/auth/me") return Response.json({ authenticated: true, mode: "local-username", user: { user_id: "usr_quota_ui", username: "QuotaUser" } });
      if (path === "/api/setup") return Response.json(setupFixture());
      if (path === "/api/models") return Response.json({ models: [] });
      if (path === "/api/sessions") return Response.json({ sessions: [{
        id: "session-quota-ui-001",
        title: "Server history is visible",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:01.000Z",
        turns: [{
          requestId: "request-quota-ui-001",
          traceId: "trace-quota-ui-001",
          prompt: "Load this conversation",
          answer: "Loaded",
          createdAt: "2026-09-01T00:00:01.000Z",
          result: { model: "model-router", specialist: "copilot", runtime: [{ id: "large-span", output: "x".repeat(50_000) }] }
        }]
      }] });
      return Response.json({});
    }
  });
  try {
    await import(`../app.js?quota-dom=${Date.now()}`);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.querySelectorAll(".history-row").length, 1);
    assert.match(document.querySelector(".history-row").textContent, /Server history is visible/u);
    const cached = JSON.parse(attemptedCache.value);
    assert.equal(cached[0].cacheVersion, "conversation-cache.v3");
    assert.equal(cached[0].answer, "");
    assert.deepEqual(cached[0].runtime, []);
    assert.deepEqual(cached[0].traces, []);
  } finally {
    if (setItemDescriptor) Object.defineProperty(storagePrototype, "setItem", setItemDescriptor);
    Object.assign(globalThis, original);
    dom.window.close();
  }
});

test("左侧会话列表可删除服务端已创建但尚无 Turn 的 Session", async () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://copilot.local/", pretendToBeVisual: true });
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    confirm: globalThis.confirm,
    fetch: globalThis.fetch
  };
  const deleted = [];
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    requestAnimationFrame: callback => callback(),
    confirm: () => true,
    fetch: async (input, init = {}) => {
      const path = new URL(String(input), "http://copilot.local").pathname;
      if (path === "/api/auth/me") return Response.json({ authenticated: true, mode: "local-username", user: { user_id: "usr_delete_ui", username: "DeleteUser" } });
      if (path === "/api/setup") return Response.json(setupFixture());
      if (path === "/api/sessions" && (!init.method || init.method === "GET")) return Response.json({ sessions: [{
        id: "session-delete-ui-001",
        title: "Empty server session",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:01.000Z",
        turns: []
      }] });
      if (path === "/api/sessions/session-delete-ui-001" && init.method === "DELETE") {
        deleted.push(path);
        return Response.json({ deleted: true, sessionId: "session-delete-ui-001" });
      }
      return Response.json({});
    }
  });
  try {
    await import(`../app.js?delete-dom=${Date.now()}`);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.querySelectorAll(".history-row").length, 1);
    document.querySelector("[data-delete-session]").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(deleted, ["/api/sessions/session-delete-ui-001"]);
    assert.equal(document.querySelectorAll(".history-row").length, 0);
    assert.deepEqual(JSON.parse(localStorage.getItem("chat.sessions.cache.v3.usr_delete_ui")), []);
    assert.match(document.querySelector("#toast-root").textContent, /Conversation deleted/u);
  } finally {
    Object.assign(globalThis, original);
    dom.window.close();
  }
});

test("服务端已不存在的完成态缓存不会在刷新后复活", async () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://copilot.local/", pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    fetch: globalThis.fetch
  };
  const userId = "usr_stale_cache_ui";
  dom.window.localStorage.setItem(`copilot.saved-conversations.v2.${userId}`, JSON.stringify([{
    id: "stale-local-chat",
    sessionId: "session-deleted-on-server",
    title: "Already deleted",
    prompt: "Old prompt",
    answer: "Old answer",
    status: "completed",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:01.000Z"
  }]));
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    requestAnimationFrame: callback => callback(),
    fetch: async input => {
      const path = new URL(String(input), "http://copilot.local").pathname;
      if (path === "/api/auth/me") return Response.json({ authenticated: true, mode: "local-username", user: { user_id: userId, username: "CacheUser" } });
      if (path === "/api/setup") return Response.json(setupFixture());
      if (path === "/api/models") return Response.json({ models: [] });
      if (path === "/api/sessions") return Response.json({ sessions: [] });
      return Response.json({});
    }
  });
  try {
    await import(`../app.js?stale-cache-dom=${Date.now()}`);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(document.querySelector(".home-view"));
    assert.equal(document.querySelectorAll(".history-row").length, 0);
    assert.equal(localStorage.getItem(`copilot.saved-conversations.v2.${userId}`), null);
    assert.deepEqual(JSON.parse(localStorage.getItem(`chat.sessions.cache.v3.${userId}`)), []);
  } finally {
    Object.assign(globalThis, original);
    dom.window.close();
  }
});

test("未登录 Web UI 显示用户名入口并在登录后进入独立空间", async () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://copilot.local/", pretendToBeVisual: true });
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    fetch: globalThis.fetch
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    requestAnimationFrame: callback => callback(),
    fetch: async (input, init = {}) => {
      const path = new URL(String(input), "http://copilot.local").pathname;
      if (path === "/api/auth/me") {
        return new Response(JSON.stringify({ authenticated: false, mode: "local-username", user: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (path === "/api/auth/login") {
        assert.equal(JSON.parse(init.body).username, "Bob");
        return new Response(JSON.stringify({
          authenticated: true,
          mode: "local-username",
          user: { user_id: "usr_abcdef0123456789abcdef0123456789", username: "Bob" }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (path === "/api/setup") return Response.json(setupFixture());
      return new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  try {
    await import(`../app.js?login-dom=${Date.now()}`);
    await new Promise(resolve => setTimeout(resolve, 0));
    const form = document.querySelector("[data-login-form]");
    assert.ok(form);
    assert.match(document.querySelector("#login-title").textContent, /Enter your workspace/u);
    form.querySelector("input").value = "Bob";
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(document.querySelector(".home-view"));
    assert.match(document.querySelector(".account-copy strong").textContent, /Bob/u);
  } finally {
    Object.assign(globalThis, original);
    dom.window.close();
  }
});

test("右侧 Agent DAG 按 parentId 呈现 Root、Agent、Generation 与 Tool 层级", async () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://copilot.local/#chat/chat-dag", pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    fetch: globalThis.fetch
  };
  const userId = "usr_trace";
  dom.window.localStorage.setItem(`copilot.saved-conversations.v2.${userId}`, JSON.stringify([{
    id: "chat-dag",
    sessionId: "session-dag",
    title: "Trace hierarchy",
    prompt: "请展示运行结构",
    answer: "已完成。",
    generated: [],
    traces: [{
      clientId: "trace-client-dag",
      traceId: "trace-server-dag",
      prompt: "请展示运行结构",
      answer: "已完成。",
      status: "completed",
      runtime: [
        { id: "tool", parentId: "generation", sequence: 4, kind: "TOOL CALL", name: "load_memory", actor: "Memory", status: "completed", duration: "4 ms" },
        { id: "root", parentId: null, sequence: 1, kind: "CHAIN", name: "run-copilot", actor: "Runtime", status: "completed", duration: "30 ms" },
        { id: "agent", parentId: "root", sequence: 2, kind: "AGENT RUN", name: "agent_run [copilot]", actor: "copilot", status: "completed", duration: "25 ms" },
        { id: "generation", parentId: "agent", sequence: 3, kind: "GENERATION", name: "intent-routing", actor: "Intent model", semanticRole: "intent-routing", status: "completed", duration: "20 ms" }
      ]
    }],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:01.000Z"
  }]));
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    requestAnimationFrame: callback => callback(),
    fetch: async input => {
      const path = new URL(String(input), "http://copilot.local").pathname;
      if (path === "/api/auth/me") return Response.json({ authenticated: true, mode: "local-username", user: { user_id: userId, username: "TraceUser" } });
      if (path === "/api/setup") return Response.json(setupFixture());
      if (path === "/api/models") return Response.json({ models: [] });
      return Response.json({ sessions: [] });
    }
  });
  try {
    await import(`../app.js?dag-dom=${Date.now()}`);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    const levels = [...document.querySelectorAll("[data-dag-span]")].map(node => [node.dataset.dagSpan, node.getAttribute("aria-level")]);
    assert.deepEqual(levels, [["root", "1"], ["agent", "2"], ["generation", "3"], ["tool", "4"]]);
    assert.equal(document.querySelectorAll(".trace-dag-forest > .dag-branch").length, 1);
    assert.equal(document.querySelectorAll(".dag-children").length, 3);
    assert.match(document.querySelector(".dag-structure-summary").textContent, /1 root/u);
    document.querySelector('[data-dag-span="tool"]').click();
    assert.ok(document.querySelector('[data-runtime-event-id="tool"]').classList.contains("expanded"));
  } finally {
    Object.assign(globalThis, original);
    dom.window.close();
  }
});

test("首次登录弹出核心配置向导，密钥不回显并在真实验证后完成", async () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://copilot.local/", pretendToBeVisual: true });
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    FormData: globalThis.FormData,
    fetch: globalThis.fetch
  };
  const configurationRequests = [];
  let completed = false;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    FormData: dom.window.FormData,
    requestAnimationFrame: callback => callback(),
    fetch: async (input, init = {}) => {
      const path = new URL(String(input), "http://copilot.local").pathname;
      if (path === "/api/auth/me") return Response.json({ authenticated: true, mode: "local-username", user: { user_id: "usr_setup", username: "SetupUser" } });
      if (path === "/api/sessions") return Response.json({ sessions: [] });
      if (path === "/api/models") return Response.json({ models: [] });
      if (path === "/api/memories") return Response.json({ settings: { enabled: true }, memories: [] });
      if (path === "/api/setup" && init.method !== "PATCH") return Response.json(setupFixture({ completed, configured: false }));
      if (path === "/api/setup/configuration") {
        configurationRequests.push(JSON.parse(init.body));
        return Response.json(setupFixture({ completed: false, configured: true }));
      }
      if (path === "/api/setup/complete") {
        completed = true;
        return Response.json({
          onboarding: { completed: true },
          verification: { status: "passed", model: "google/gemini-3.1-flash-lite", latencyMs: 126 },
          setup: setupFixture({ completed: true, configured: true })
        });
      }
      return Response.json({});
    }
  });
  try {
    await import(`../app.js?setup-dom=${Date.now()}`);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    const dialog = document.querySelector(".setup-dialog");
    assert.ok(dialog);
    assert.match(dialog.textContent, /Complete core configuration/u);
    assert.equal(dialog.querySelector("input[name='llmApiKey']").value, "");
    assert.equal(dialog.querySelector("input[name='intentionModel']").value, "google/gemini-3.1-flash-lite");
    assert.equal(dialog.querySelector("input[name='judgeModel']").value, "openai/gpt-4o");
    assert.match(dialog.querySelector(".setup-current-config").textContent, /Current configuration/u);
    assert.match(dialog.querySelector(".setup-current-config").textContent, /openai\/gpt-4o/u);
    assert.match(dialog.querySelector(".judge-setup-section").textContent, /System preset:\s*openai\/gpt-4o/u);
    assert.equal(dialog.querySelector("input[name='searchBaseUrl']").value, "https://search.example/v1/tavily");
    assert.equal(dialog.querySelector("input[name='searchApiKey']").value, "");
    assert.equal(dialog.querySelector("input[name='langfuseBaseUrl']").value, "https://cloud.langfuse.com");
    assert.equal(dialog.querySelector("input[name='langfusePublicKey']").value, "");
    assert.equal(dialog.querySelector("input[name='langfuseSecretKey']").value, "");

    dialog.querySelector("input[name='llmApiKey']").value = "browser-submitted-secret";
    dialog.querySelector("input[name='searchApiKey']").value = "search-browser-secret";
    dialog.querySelector("input[name='langfusePublicKey']").value = "pk-lf-browser-public";
    dialog.querySelector("input[name='langfuseSecretKey']").value = "sk-lf-browser-secret";
    dialog.querySelector("[data-setup-form]").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(configurationRequests.length, 1);
    assert.equal(configurationRequests[0].llmApiKey, "browser-submitted-secret");
    assert.equal(configurationRequests[0].searchBaseUrl, "https://search.example/v1/tavily");
    assert.equal(configurationRequests[0].judgeModel, "openai/gpt-4o");
    assert.equal(configurationRequests[0].searchApiKey, "search-browser-secret");
    assert.equal(configurationRequests[0].langfuseBaseUrl, "https://cloud.langfuse.com");
    assert.equal(configurationRequests[0].langfusePublicKey, "pk-lf-browser-public");
    assert.equal(configurationRequests[0].langfuseSecretKey, "sk-lf-browser-secret");
    assert.equal(document.body.textContent.includes("browser-submitted-secret"), false);
    assert.equal(document.body.textContent.includes("search-browser-secret"), false);
    assert.equal(document.body.textContent.includes("sk-lf-browser-secret"), false);
    assert.equal(JSON.stringify(localStorage).includes("browser-submitted-secret"), false);
    assert.equal(JSON.stringify(localStorage).includes("search-browser-secret"), false);
    assert.equal(JSON.stringify(localStorage).includes("sk-lf-browser-secret"), false);
    assert.match(document.querySelector(".setup-success").textContent, /live model probe succeeded/u);

    document.querySelector("[data-close-setup]").click();
    document.querySelector("[data-account-menu]").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(document.querySelector("[data-core-setup]"));
    document.querySelector("[data-core-setup]").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(document.querySelector(".setup-dialog"));
    assert.match(document.querySelector(".setup-dialog").textContent, /completed setup before/u);
  } finally {
    Object.assign(globalThis, original);
    dom.window.close();
  }
});

test("回答赞踩进入 Eval 候选池，并可从一级菜单打开 Dataset 审核", async () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://copilot.local/", pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    fetch: globalThis.fetch
  };
  const requests = [];
  const reviewRequests = [];
  let pendingCandidates = [{
    id: "gfc-123456789012345678901234",
    request_id: "request-feedback",
    prompt: "请解释测试",
    actual_output: "待评价回答",
    score_value: 0,
    comment: null,
    review_status: "candidate",
    failure_codes: [],
    evaluation_evidence: {
      id: "evd-123456789012345678901234",
      schema_version: "copilot-eval-evidence.v1",
      scope: "target-trace+session-prefix",
      content_hash: "a".repeat(64),
      captured_at: "2026-09-01T00:00:02.000Z",
      target_turn_index: 1,
      trace_span_count: 1,
      session_turn_count: 1,
      session_trace_count: 1,
      session_span_count: 1,
      excludes_future_turns: true
    },
    updated_at: "2026-09-01T00:00:02.000Z"
  }];
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    requestAnimationFrame: callback => callback(),
    fetch: async (input, init = {}) => {
      const path = new URL(String(input), "http://copilot.local").pathname;
      if (path === "/api/auth/me") return Response.json({ authenticated: true, mode: "local-username", user: { user_id: "usr_feedback", username: "Reviewer" } });
      if (path === "/api/setup") return Response.json(setupFixture());
      if (path === "/api/sessions") return Response.json({ sessions: [{
        id: "session-feedback",
        title: "反馈测试",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:01.000Z",
        turns: [{
          requestId: "request-feedback",
          traceId: "trace-feedback",
          prompt: "请解释测试",
          answer: "待评价回答",
          createdAt: "2026-09-01T00:00:01.000Z",
          result: { model: "model-router", specialist: "copilot", runtime: [] }
        }]
      }] });
      if (path === "/api/memories") return Response.json({ settings: { enabled: true }, memories: [] });
      if (path === "/api/feedback") {
        requests.push(JSON.parse(init.body));
        return Response.json({ feedback: { value: 0 }, candidate: { id: "gfc-123", review_status: "candidate" } });
      }
      if (path === "/api/eval/feedback-candidates") return Response.json({ candidates: pendingCandidates });
      if (path === "/api/eval/datasets") return Response.json({
        schemaVersion: "copilot-eval-dataset-catalog.v2",
        benchmarkCatalogVersion: "2026-09-01-r2",
        summary: { datasets: 2, built_in_items: 140, benchmark_families: 27, feedback_active: 0, feedback_archived: 0, feedback_candidates: pendingCandidates.length, live_eligible_items: 69, coverage: { workflow_stages: { intent_routing: 3, agent_tools: 7, final_answer: 22, memory: 7 } } },
        datasets: [
          { id: "feedback-golden", name: "Feedback Golden Set", version: "copilot-feedback-golden.v1", purpose: "Human-reviewed feedback", evaluation_dimension: "user_feedback", source: "user-feedback", lifecycle_status: "active", read_only: false, item_count: 0, active_count: 0, archived_count: 0, candidate_count: pendingCandidates.length },
          { id: "core", name: "Core", version: "copilot-core.v3", purpose: "Core contracts", evaluation_dimension: "product_contract", source: "built-in", lifecycle_status: "published", read_only: true, item_count: 19, active_count: 19, archived_count: 0, candidate_count: 0 }
        ]
      });
      if (path === "/api/eval/datasets/feedback-golden/items") return Response.json({ dataset_id: "feedback-golden", read_only: false, status: "active", items: [] });
      if (path.endsWith("/evidence")) return Response.json({ evidence: {
        id: "evd-123456789012345678901234",
        schema_version: "copilot-eval-evidence.v1",
        content_hash: "a".repeat(64),
        captured_at: "2026-09-01T00:00:02.000Z",
        snapshot: {
          schemaVersion: "copilot-eval-evidence.v1",
          subject: { requestId: "request-feedback", turnIndex: 1 },
          trace: { trace: { runtime: [{ kind: "GENERATION", name: "final-answer", status: "completed", input: { prompt: "请解释测试" }, output: { content: "待评价回答" }, metadata: {} }] } },
          session: { turns: [{ turnIndex: 1, requestId: "request-feedback", traceId: "trace-feedback", input: { content: "请解释测试" }, output: { content: "待评价回答" } }] }
        }
      } });
      if (path.startsWith("/api/eval/feedback-candidates/")) {
        reviewRequests.push(JSON.parse(init.body));
        pendingCandidates = [];
        return Response.json({ candidate: { review_status: "rejected" }, removed_from_review_queue: true, golden_item: null });
      }
      return Response.json({});
    }
  });
  try {
    await import(`../app.js?feedback-dom=${Date.now()}`);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    document.querySelector("[data-open-chat]").click();
    document.querySelector('[data-feedback="0"]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(requests, [{ requestId: "request-feedback", value: 0, comment: null }]);
    assert.match(document.querySelector("#toast-root").textContent, /evaluation evidence saved/u);

    document.querySelector("[data-eval-datasets]").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(document.querySelector(".eval-workspace"));
    assert.match(document.querySelector(".conversation-header.section-page-header h1").textContent, /Eval Datasets/u);
    assert.ok(document.querySelector(".section-page-content"));
    assert.match(document.querySelector(".eval-header-summary").textContent, /datasets/u);
    assert.ok(document.querySelector(".eval-dataset-layout"));
    assert.ok(document.querySelector(".eval-dataset-catalog"));
    assert.ok(document.querySelector(".eval-dataset-detail"));
    assert.equal(document.querySelector(".eval-summary-grid"), null, "首屏不应重复展示大型统计卡片");
    assert.equal(document.querySelector(".eval-workflow-flow"), null, "Dataset 管理页不应重复展示工作流装饰条");
    assert.equal(document.querySelector("[data-eval-review-count]").textContent, "1");
    assert.match(document.querySelector(".golden-candidate").textContent, /待评价回答/u);
    assert.ok(document.querySelector(".eval-review-criteria"), "次要审核字段应收进可展开区域");
    assert.equal(document.querySelector(".eval-review-criteria").open, false);
    document.querySelector(".section-page-scroll").scrollTop = 420;
    document.querySelector(".eval-catalog-scroll").scrollTop = 88;
    assert.match(document.querySelector(".golden-evidence-status").textContent, /1 spans/u);
    const evidenceDetails = document.querySelector("[data-evidence-details]");
    evidenceDetails.open = true;
    evidenceDetails.dispatchEvent(new dom.window.Event("toggle"));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(document.querySelector("[data-evidence-panel]").textContent, /Session through evaluated turn/u);
    assert.match(document.querySelector("[data-evidence-panel]").textContent, /final-answer/u);
    assert.equal(document.querySelector(".section-page-scroll").scrollTop, 420, "展开反馈证据不应重置主列表滚动位置");
    assert.equal(document.querySelector(".eval-catalog-scroll").scrollTop, 88, "展开反馈证据不应重置 Dataset 目录位置");
    document.querySelector("[data-review-reject]").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(reviewRequests, [{ decision: "reject", failureCodes: [] }]);
    assert.equal(document.querySelector(".golden-candidate"), null);
    assert.equal(document.querySelector("[data-eval-review-count]").textContent, "0");
    assert.match(document.querySelector(".eval-dataset-detail").textContent, /Review inbox is clear/u);
    assert.equal(document.querySelector(".section-page-scroll").scrollTop, 420, "审核反馈并重绘后应恢复主列表滚动位置");
    assert.equal(document.querySelector(".eval-catalog-scroll").scrollTop, 88, "审核反馈并重绘后应恢复 Dataset 目录位置");
  } finally {
    Object.assign(globalThis, original);
    dom.window.close();
  }
});

test("Web UI 提供独立 Eval Runs 生命周期工作台并执行真实 API 动作", async () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://copilot.local/#eval-runs", pretendToBeVisual: true });
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    confirm: globalThis.confirm,
    fetch: globalThis.fetch
  };
  const calls = [];
  const configuration = {
    profiles: [
      { id: "local", name: "Local", description: "Fast offline deterministic checks for development; no external calls.", mode: "offline-scripted", traces: false, judge: false, minimum_cases: 1, requires_confirmation: false },
      { id: "ci", name: "CI", description: "Full offline release gate; rejects new diagnostic debt against the accepted baseline.", mode: "offline-scripted", traces: false, judge: false, minimum_cases: 140, requires_confirmation: false },
      { id: "live", name: "Live", description: "Runs live-eligible cases against real models and tools without Trace export or an LLM judge.", mode: "live", traces: false, judge: false, minimum_cases: 1, requires_confirmation: true },
      { id: "live-traced", name: "Live Traced", description: "Runs live-eligible cases and exports Langfuse traces; no LLM judge.", mode: "live", traces: true, judge: false, minimum_cases: 1, requires_confirmation: true },
      { id: "live-judged", name: "Live Judged", description: "Runs live-eligible cases with Langfuse tracing and LLM-as-a-Judge scoring.", mode: "live", traces: true, judge: true, judge_model: "openai/gpt-4o", minimum_cases: 1, requires_confirmation: true }
    ],
    datasets: [
      { id: "core", name: "Core", version: "copilot-core.v3", source: "built-in", dimension: "product_contract", item_count: 19, live_eligible_count: 10, available: true },
      { id: "feedback-golden", name: "Feedback Golden Set", version: "copilot-feedback-golden.v1", source: "user-feedback", dimension: "user_feedback", item_count: 0, live_eligible_count: 0, available: false }
    ]
  };
  const completedRun = {
    id: "evr-111111111111111111111111",
    parent_run_id: null,
    name: "Release gate",
    profile: "local",
    dataset_ids: ["core"],
    execution_status: "completed",
    lifecycle_status: "active",
    gate_status: "passed",
    summary: { cases: 19, checks: { total: 42, passed: 42, blockingFailures: 0, diagnosticFailures: 0 }, bySuite: { core: { cases: 19, blockingFailures: 0, diagnosticFailures: 0 } } },
    result: { failed_checks: [] },
    log: "Evaluation completed",
    created_at: "2026-09-02T01:00:00.000Z",
    started_at: "2026-09-02T01:00:01.000Z",
    ended_at: "2026-09-02T01:00:02.000Z",
    updated_at: "2026-09-02T01:00:02.000Z"
  };
  let runs = [completedRun];
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    requestAnimationFrame: callback => callback(),
    confirm: () => true,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input), "http://copilot.local");
      const path = url.pathname;
      if (path === "/api/auth/me") return Response.json({ authenticated: true, mode: "local-username", user: { user_id: "usr_eval_runs_ui", username: "EvalOwner" } });
      if (path === "/api/setup") return Response.json(setupFixture());
      if (path === "/api/models") return Response.json({ models: [] });
      if (path === "/api/sessions") return Response.json({ sessions: [] });
      if (path === "/api/eval/runs" && (!init.method || init.method === "GET")) return Response.json({
        schemaVersion: "copilot-eval-runs.v1",
        runs: runs.map(({ result, log, ...run }) => run),
        summary: { total: runs.length, drafts: runs.filter(run => run.execution_status === "draft").length, active: 0, passed: runs.filter(run => run.gate_status === "passed").length, attention: 0 },
        configuration
      });
      if (path === "/api/eval/runs" && init.method === "POST") {
        const body = JSON.parse(init.body);
        calls.push({ path, method: init.method, body });
        const draft = {
          id: "evr-222222222222222222222222",
          parent_run_id: null,
          name: body.name,
          profile: body.profile,
          dataset_ids: body.datasetIds,
          execution_status: "draft",
          lifecycle_status: "active",
          gate_status: "pending",
          summary: {}, result: {}, log: "",
          created_at: "2026-09-02T02:00:00.000Z",
          updated_at: "2026-09-02T02:00:00.000Z"
        };
        runs = [draft, ...runs];
        return Response.json({ run: draft }, { status: 201 });
      }
      const runId = path.match(/^\/api\/eval\/runs\/(evr-[a-f0-9]{24})$/u)?.[1];
      if (runId && (!init.method || init.method === "GET")) return Response.json({ run: runs.find(run => run.id === runId) });
      if (runId && init.method === "PATCH") {
        const body = JSON.parse(init.body);
        calls.push({ path, method: init.method, body });
        const current = runs.find(run => run.id === runId);
        Object.assign(current, {
          execution_status: "completed",
          gate_status: "passed",
          started_at: "2026-09-02T02:00:01.000Z",
          ended_at: "2026-09-02T02:00:02.000Z",
          updated_at: "2026-09-02T02:00:02.000Z",
          summary: completedRun.summary,
          result: completedRun.result,
          log: "Evaluation completed"
        });
        return Response.json({ run: current });
      }
      return Response.json({});
    }
  });
  try {
    await import(`../app.js?eval-runs-dom=${Date.now()}`);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(location.hash, "#eval-runs");
    assert.ok(document.querySelector(".eval-runs-workspace"));
    assert.match(document.querySelector(".section-page-title h1").textContent, /Eval Runs/u);
    assert.match(document.querySelector(".eval-run-detail").textContent, /Release gate/u);
    assert.match(document.querySelector(".eval-run-results").textContent, /Every configured check passed/u);
    assert.equal(document.querySelectorAll(".eval-run-lifecycle > span").length, 4);

    document.querySelector("[data-new-eval-run]").click();
    const nameInput = document.querySelector('[data-eval-run-form] input[name="name"]');
    const profileSelect = document.querySelector('[data-eval-run-profile]');
    assert.match(nameInput.value, /^Local evaluation · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u);
    assert.equal(profileSelect.options.length, 5);
    assert.equal(document.querySelectorAll(".eval-run-profile-guide article").length, 5);
    assert.match(document.querySelector(".eval-run-profile-guide").textContent, /rejects new diagnostic debt/u);
    assert.match(document.querySelector(".eval-run-profile-guide").textContent, /openai\/gpt-4o/u);
    profileSelect.value = "live-judged";
    profileSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.match(document.querySelector('[data-eval-run-form] input[name="name"]').value, /^Live Judged evaluation ·/u);
    document.querySelector('[data-eval-run-profile]').value = "local";
    document.querySelector('[data-eval-run-profile]').dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    document.querySelector('[data-eval-run-form] input[name="name"]').value = "Focused core regression";
    document.querySelector("[data-save-eval-run]").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body.datasetIds, ["core"]);
    assert.equal(calls[0].body.start, false);
    assert.match(document.querySelector(".eval-run-detail").textContent, /Ready to run/u);

    document.querySelector('[data-eval-run-action="start"]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls[1].method, "PATCH");
    assert.deepEqual(calls[1].body, { action: "start", confirmLive: false });
    assert.match(document.querySelector(".eval-run-detail").textContent, /Release gate/u);
    assert.match(document.querySelector(".eval-run-detail").textContent, /Passed/u);
  } finally {
    Object.assign(globalThis, original);
    dom.window.close();
  }
});

test("Web UI 提供一级记忆管理、真实上传入口与 15 个显式模型", async () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://copilot.local/", pretendToBeVisual: true });
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    fetch: globalThis.fetch
  };
  const modelRows = [
    { id: "model-router", kind: "selection-mode", modelAlias: "model-router", displayName: "Auto", providerLabel: "Model Router", description: "Selected by Model Router", mark: "router", modalities: ["text"], recommendedFor: ["General"] },
    ...Array.from({ length: 15 }, (_, index) => ({
      id: `model-${index + 1}`,
      kind: "answer-model",
      modelAlias: `model-${index + 1}`,
      displayName: `Model ${index + 1}`,
      providerLabel: "Test provider",
      description: "Test response model",
      mark: "openai",
      modalities: ["text", "image"],
      recommendedFor: ["Testing"]
    }))
  ];
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    requestAnimationFrame: callback => callback(),
    fetch: async input => {
      const path = new URL(String(input), "http://copilot.local").pathname;
      if (path === "/api/auth/me") return Response.json({ authenticated: true, mode: "local-username", user: { user_id: "usr_features", username: "FeatureUser" } });
      if (path === "/api/setup") return Response.json(setupFixture());
      if (path === "/api/models") return Response.json({ schemaVersion: "copilot-model-catalog.v3", defaultModelId: "model-router", models: modelRows });
      if (path === "/api/sessions") return Response.json({ sessions: [] });
      if (path === "/api/memories") return Response.json({ settings: { enabled: true }, memories: [{
        memory_id: "mem-123456789012345678901234",
        kind: "preference",
        content: "我偏好简洁回答。",
        access_count: 2,
        updated_at: "2026-09-01T00:00:00.000Z",
        expires_at: "2027-09-01T00:00:00.000Z"
      }] });
      if (path === "/api/artifacts") return Response.json({ artifacts: [] });
      return Response.json({});
    }
  });
  try {
    await import(`../app.js?features-dom=${Date.now()}`);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.ok(document.querySelector("[data-memory-manager]"));
    document.querySelector("[data-memory-manager]").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(location.hash, "#memory");
    assert.ok(document.querySelector(".memory-workspace"));
    assert.ok(document.querySelector(".conversation-header.section-page-header"));
    assert.ok(document.querySelector("[data-memory-manager]").classList.contains("active"));
    assert.match(document.querySelector(".memory-manager-panel").textContent, /我偏好简洁回答/u);
    assert.ok(document.querySelector("[data-add-memory]"));
    document.querySelector("[data-add-memory]").click();
    assert.ok(document.querySelector(".memory-workspace [data-memory-editor]"));
    document.querySelector("[data-cancel-memory]").click();
    assert.equal(document.querySelector("[data-memory-editor]"), null);
    assert.equal(document.querySelector(".memory-dialog"), null, "记忆管理不应再使用弹窗");

    document.querySelector("[data-new-chat]").click();

    document.querySelector("[data-model-picker]").click();
    assert.equal(document.querySelectorAll("[data-select-model]").length, 16);
    assert.match(document.querySelector(".popover-footer").textContent, /intent model is configured separately/u);
    document.querySelector(".model-search input").click();
    assert.ok(document.querySelector(".model-popover"), "内容区点击不应关闭模型选择弹窗");
    document.querySelector("[data-close-modal]").click();

    document.querySelector("[data-attachments]").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(document.querySelector("[data-upload-device]"));
    assert.match(document.querySelector("[data-upload-device]").textContent, /Upload from device/u);
    assert.match(document.querySelector("[data-file-input]").accept, /application\/pdf/u);
  } finally {
    Object.assign(globalThis, original);
    dom.window.close();
  }
});
