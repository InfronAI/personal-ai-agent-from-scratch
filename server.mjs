import crypto from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { config, appRoot, readiness } from "./config.mjs";
import {
  artifactDownload,
  artifactStoreStatus,
  createUploadedArtifact,
  deleteArtifact,
  listArtifacts
} from "./artifacts/artifact-store.mjs";
import { executorStatus } from "./capabilities/executor.mjs";
import { conversationStoreStatus, deleteConversation, listConversations, ownedTurn, ownsTrace, prepareConversation, saveCompletedTurn } from "./conversation-store.mjs";
import { closeDatabase, databaseStatus } from "./database.mjs";
import { evalDatasetCatalog, evalDatasetCatalogStatus, evalDatasetItems } from "./eval-dataset-catalog.mjs";
import { evalRunService } from "./eval-run-service.mjs";
import { evalRunStoreStatus } from "./eval-run-store.mjs";
import { AppError, publicError } from "./errors.mjs";
import { backfillEvaluationEvidenceSnapshots, evaluationEvidenceForCandidate } from "./evaluation-evidence-store.mjs";
import {
  feedbackForRequest,
  feedbackStoreStatus,
  markFeedbackExportFailed,
  markFeedbackSynced,
  saveUserFeedback
} from "./feedback-store.mjs";
import {
  captureFeedbackCandidate,
  goldenSetStatus,
  listFeedbackCandidates,
  listGoldenSetItems,
  reviewFeedbackCandidate,
  updateGoldenSetItemLifecycle
} from "./golden-set-store.mjs";
import {
  clearIdentityCookie,
  issueIdentityCookie,
  optionalIdentity,
  resolveIdentity,
  validateOrigin
} from "./identity.mjs";
import { exportTraceScore, shutdownLangfuseClient } from "./langfuse-client.mjs";
import { logger } from "./logger.mjs";
import { publicModelCatalog, selectedModel } from "./model-catalog.mjs";
import { runAgentTurn } from "./agent-runtime.mjs";
import {
  createMemory,
  deleteMemory,
  getMemorySettings,
  listMemories,
  memoryStoreStatus,
  setMemoryEnabled,
  updateMemory
} from "./memory-store.mjs";
import { shutdownTracing, tracingStatus } from "./observability.mjs";
import { onboardingStoreStatus } from "./onboarding-store.mjs";
import { publicSetupState, updateSetupConfiguration, verifyAndCompleteSetup } from "./setup-service.mjs";
import { workflowStatus } from "./workflow.mjs";
import { findUserById, loginWithUsername, userStoreStatus } from "./user-store.mjs";

const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".ttf": "font/ttf"
};
const allowedStaticFiles = new Set(["index.html", "app.js", "styles.css"]);

function createRequestCoordinator() {
  const requestWindows = new Map();
  const concurrentByUser = new Map();
  const sessionLocks = new Map();
  const cleanup = setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [userId, timestamps] of requestWindows) {
      const active = timestamps.filter(timestamp => timestamp >= cutoff);
      if (active.length) requestWindows.set(userId, active);
      else requestWindows.delete(userId);
    }
  }, 60_000);
  cleanup.unref();
  return { requestWindows, concurrentByUser, sessionLocks, close: () => clearInterval(cleanup) };
}

function securityHeaders(response, requestId) {
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data: https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}

function writeJson(response, status, payload, requestId) {
  securityHeaders(response, requestId);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function publicIdentity(identity) {
  if (!identity) return null;
  if (identity.mode === "trusted-header") {
    return { user_id: identity.userId, username: identity.username, mode: identity.mode };
  }
  const user = findUserById(identity.userId);
  return user ? { user_id: user.user_id, username: user.username, mode: identity.mode } : null;
}

async function readJson(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new AppError("Content-Type must be application/json", { code: "unsupported_media_type", status: 415, expose: true });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > config.http.maxBodyBytes) throw new AppError("Request body is too large", { code: "payload_too_large", status: 413, expose: true });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new AppError("Request body must be valid JSON", { code: "invalid_json", status: 400, expose: true });
  }
}

async function readBinary(request, maximumBytes) {
  const declaredSize = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredSize) && declaredSize > maximumBytes) {
    throw new AppError("上传文件过大", { code: "payload_too_large", status: 413, expose: true });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new AppError("上传文件过大", { code: "payload_too_large", status: 413, expose: true });
    chunks.push(chunk);
  }
  if (!size) throw new AppError("上传文件不能为空", { code: "empty_upload", status: 400, expose: true });
  return Buffer.concat(chunks);
}

function validatePrompt(body) {
  const prompt = String(body.prompt || "").trim();
  if (!prompt || prompt.length > config.http.maxPromptCharacters) {
    throw new AppError(`Prompt must contain between 1 and ${config.http.maxPromptCharacters} characters`, { code: "invalid_prompt", status: 400, expose: true });
  }
  return prompt;
}

function validateArtifactNames(body) {
  if (body.artifactNames === undefined) return [];
  if (!Array.isArray(body.artifactNames) || body.artifactNames.length > 10) {
    throw new AppError("artifactNames 必须是长度不超过 10 的数组", { code: "invalid_artifacts", status: 400, expose: true });
  }
  return [...new Set(body.artifactNames.map(value => String(value || "").trim()).filter(Boolean))];
}

function acquireCapacity(coordinator, userId) {
  const now = Date.now();
  const recent = (coordinator.requestWindows.get(userId) || []).filter(timestamp => now - timestamp < 60_000);
  if (recent.length >= config.http.requestsPerMinute) throw new AppError("Request rate limit exceeded", { code: "rate_limited", status: 429, retryable: true, expose: true });
  const active = coordinator.concurrentByUser.get(userId) || 0;
  if (active >= config.http.maxConcurrentPerUser) throw new AppError("Too many concurrent requests", { code: "concurrency_limited", status: 429, retryable: true, expose: true });
  recent.push(now);
  coordinator.requestWindows.set(userId, recent);
  coordinator.concurrentByUser.set(userId, active + 1);
  return () => {
    const next = Math.max(0, (coordinator.concurrentByUser.get(userId) || 1) - 1);
    if (next) coordinator.concurrentByUser.set(userId, next);
    else coordinator.concurrentByUser.delete(userId);
  };
}

async function withSessionLock(coordinator, sessionId, task) {
  const previous = coordinator.sessionLocks.get(sessionId) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  coordinator.sessionLocks.set(sessionId, current);
  await previous;
  try { return await task(); }
  finally {
    release();
    if (coordinator.sessionLocks.get(sessionId) === current) coordinator.sessionLocks.delete(sessionId);
  }
}

function requestAbortSignal(request, response) {
  const client = new AbortController();
  request.once("aborted", () => client.abort(new AppError("Client disconnected", { code: "client_disconnected", status: 499 })));
  response.once("close", () => {
    if (!response.writableEnded) client.abort(new AppError("Client disconnected", { code: "client_disconnected", status: 499 }));
  });
  return AbortSignal.any([client.signal, AbortSignal.timeout(config.http.requestTimeoutMs)]);
}

async function executeChat({ request, response, body, identity, requestId, emit, services, coordinator }) {
  const prompt = validatePrompt(body);
  const artifactNames = validateArtifactNames(body);
  const modelSelection = selectedModel(body.model);
  const sessionId = String(body.sessionId || `copilot-${crypto.randomUUID()}`);
  const releaseCapacity = acquireCapacity(coordinator, identity.userId);
  try {
    return await withSessionLock(coordinator, `${identity.userId}:${sessionId}`, async () => {
      const conversation = prepareConversation({ sessionId, requestId: body.requestId || requestId, userId: identity.userId });
      if (conversation.cachedResult) return conversation.cachedResult;
      const result = await services.runAgentTurn({
        prompt, sessionId: conversation.sessionId, requestId: conversation.requestId,
        model: modelSelection.id, history: conversation.history, userId: identity.userId,
        artifactNames,
        signal: requestAbortSignal(request, response), onRuntimeEvent: emit
      });
      saveCompletedTurn({ requestId: conversation.requestId, sessionId: conversation.sessionId, userId: identity.userId, prompt, result });
      return result;
    });
  } finally { releaseCapacity(); }
}

async function handleRequest(request, response, { services, coordinator }) {
  const requestId = /^[-A-Za-z0-9_]{8,200}$/.test(String(request.headers["x-request-id"] || ""))
    ? String(request.headers["x-request-id"]) : `req_${crypto.randomUUID()}`;
  const started = performance.now();
  securityHeaders(response, requestId);
  const parsedUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  try {
    if (pathname === "/healthz" && request.method === "GET") {
      writeJson(response, 200, { status: "ok", service: config.service.name, version: config.service.version }, requestId);
      return;
    }
    if (pathname === "/readyz" && request.method === "GET") {
      const state = readiness();
      writeJson(response, state.ready ? 200 : 503, state, requestId);
      return;
    }
    if (pathname === "/api/auth/me" && request.method === "GET") {
      const identity = optionalIdentity(request, response);
      const user = publicIdentity(identity);
      if (identity && !user && identity.mode === "local-username") clearIdentityCookie(response);
      writeJson(response, 200, {
        authenticated: Boolean(user),
        mode: config.auth.mode,
        user
      }, requestId);
      return;
    }
    if (pathname === "/api/auth/login" && request.method === "POST") {
      validateOrigin(request);
      if (config.auth.mode !== "local-username") {
        throw new AppError("当前环境由可信身份代理接管登录", { code: "login_managed_upstream", status: 409, expose: true });
      }
      const body = await readJson(request);
      const user = loginWithUsername(body.username);
      issueIdentityCookie(response, { userId: user.user_id });
      writeJson(response, 200, {
        authenticated: true,
        mode: config.auth.mode,
        user: { user_id: user.user_id, username: user.username, mode: config.auth.mode }
      }, requestId);
      return;
    }
    if (pathname === "/api/auth/logout" && request.method === "POST") {
      validateOrigin(request);
      clearIdentityCookie(response);
      writeJson(response, 200, { authenticated: false, mode: config.auth.mode }, requestId);
      return;
    }
    if (pathname === "/api/health/tracing" && request.method === "GET") {
      writeJson(response, 200, {
        ...tracingStatus(),
        workflow: workflowStatus(),
        memory: memoryStoreStatus(),
        conversations: conversationStoreStatus(),
        artifacts: artifactStoreStatus(),
        feedback: feedbackStoreStatus(),
        goldenSet: goldenSetStatus(),
        evalDatasets: evalDatasetCatalogStatus(),
        evalRuns: evalRunStoreStatus(),
        database: databaseStatus(),
        executor: executorStatus(),
        users: userStoreStatus(),
        onboarding: onboardingStoreStatus()
      }, requestId);
      return;
    }

    if (pathname === "/api/setup" && request.method === "GET") {
      const identity = resolveIdentity(request, response);
      writeJson(response, 200, publicSetupState({
        userId: identity.userId,
        authMode: identity.mode,
        tracing: tracingStatus()
      }), requestId);
      return;
    }

    if (pathname === "/api/setup/configuration" && request.method === "PATCH") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      const body = await readJson(request);
      updateSetupConfiguration({ userId: identity.userId, authMode: identity.mode, body });
      writeJson(response, 200, publicSetupState({
        userId: identity.userId,
        authMode: identity.mode,
        tracing: tracingStatus()
      }), requestId);
      return;
    }

    if (pathname === "/api/setup/complete" && request.method === "POST") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      const result = await verifyAndCompleteSetup({ userId: identity.userId, fetchImpl: services.fetch });
      writeJson(response, 200, {
        ...result,
        setup: publicSetupState({ userId: identity.userId, authMode: identity.mode, tracing: tracingStatus() })
      }, requestId);
      return;
    }

    if (pathname === "/api/models" && request.method === "GET") {
      resolveIdentity(request, response);
      writeJson(response, 200, publicModelCatalog(), requestId);
      return;
    }

    if (pathname === "/api/memories" && request.method === "GET") {
      const identity = resolveIdentity(request, response);
      writeJson(response, 200, { settings: getMemorySettings(identity.userId), memories: listMemories(identity.userId) }, requestId);
      return;
    }

    if (pathname === "/api/memories" && request.method === "POST") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      const body = await readJson(request);
      writeJson(response, 201, { memory: createMemory({
        userId: identity.userId,
        content: body.content,
        kind: body.kind,
        expiresInDays: body.expiresInDays
      }) }, requestId);
      return;
    }

    if (pathname === "/api/memory/settings" && request.method === "PATCH") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") throw new AppError("enabled 必须是布尔值", { code: "invalid_memory_setting", status: 400, expose: true });
      writeJson(response, 200, { settings: setMemoryEnabled({ userId: identity.userId, enabled: body.enabled }) }, requestId);
      return;
    }

    const memoryMatch = pathname.match(/^\/api\/memories\/(mem-[A-Fa-f0-9]+)$/u);
    if (memoryMatch && request.method === "PATCH") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      const body = await readJson(request);
      writeJson(response, 200, { memory: updateMemory({
        userId: identity.userId,
        memoryId: memoryMatch[1],
        content: body.content,
        kind: body.kind,
        expiresInDays: body.expiresInDays
      }) }, requestId);
      return;
    }
    if (memoryMatch && request.method === "DELETE") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      writeJson(response, 200, deleteMemory({ userId: identity.userId, memoryId: memoryMatch[1] }), requestId);
      return;
    }

    if (pathname === "/api/feedback" && request.method === "GET") {
      const identity = resolveIdentity(request, response);
      const feedbackRequestId = parsedUrl.searchParams.get("requestId") || "";
      if (!ownedTurn(feedbackRequestId, identity.userId)) throw new AppError("对话轮次不存在", { code: "turn_not_found", status: 404, expose: true });
      writeJson(response, 200, { feedback: feedbackForRequest({ userId: identity.userId, requestId: feedbackRequestId }) }, requestId);
      return;
    }

    if (pathname === "/api/feedback" && request.method === "POST") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      const body = await readJson(request);
      const turn = ownedTurn(body.requestId, identity.userId);
      if (!turn?.traceId) throw new AppError("对话轮次或 Trace 不存在", { code: "turn_not_found", status: 404, expose: true });
      let feedback = saveUserFeedback({
        userId: identity.userId,
        sessionId: turn.sessionId,
        requestId: turn.requestId,
        traceId: turn.traceId,
        value: body.value,
        comment: body.comment,
        metadata: { source: "copilot-web", release: config.service.version }
      });
      const candidate = captureFeedbackCandidate({
        userId: identity.userId,
        feedbackId: feedback.id,
        requestId: turn.requestId,
        value: feedback.value,
        comment: feedback.comment
      });
      let exportState = { configured: false, exported: false };
      try {
        exportState = await exportTraceScore({
          id: feedback.id,
          traceId: feedback.trace_id,
          name: feedback.name,
          value: feedback.value,
          dataType: feedback.data_type,
          comment: feedback.comment,
          metadata: feedback.metadata
        });
        if (exportState.exported) feedback = markFeedbackSynced({ id: feedback.id, userId: identity.userId });
      } catch (error) {
        feedback = markFeedbackExportFailed({ id: feedback.id, userId: identity.userId, error });
        logger.warn("用户反馈暂未同步到 Langfuse", { requestId, traceId: turn.traceId, error });
      }
      writeJson(response, 200, { feedback, candidate, export: exportState }, requestId);
      return;
    }

    if (pathname === "/api/eval/feedback-candidates" && request.method === "GET") {
      const identity = resolveIdentity(request, response);
      writeJson(response, 200, {
        candidates: listFeedbackCandidates({ userId: identity.userId, status: parsedUrl.searchParams.get("status") || "candidate" })
      }, requestId);
      return;
    }

    const feedbackEvidenceMatch = pathname.match(/^\/api\/eval\/feedback-candidates\/(gfc-[a-f0-9]{24})\/evidence$/u);
    if (feedbackEvidenceMatch && request.method === "GET") {
      const identity = resolveIdentity(request, response);
      const evidence = evaluationEvidenceForCandidate({ userId: identity.userId, candidateId: feedbackEvidenceMatch[1] });
      if (!evidence) throw new AppError("反馈评估证据不存在", { code: "evaluation_evidence_not_found", status: 404, expose: true });
      writeJson(response, 200, { evidence }, requestId);
      return;
    }

    const feedbackCandidateMatch = pathname.match(/^\/api\/eval\/feedback-candidates\/(gfc-[a-f0-9]{24})$/u);
    if (feedbackCandidateMatch && request.method === "PATCH") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      const body = await readJson(request);
      const publicUser = publicIdentity(identity);
      writeJson(response, 200, reviewFeedbackCandidate({
        userId: identity.userId,
        candidateId: feedbackCandidateMatch[1],
        decision: body.decision,
        reviewer: publicUser?.username || identity.userId,
        expectedOutput: body.expectedOutput,
        expectedRoute: body.expectedRoute,
        failureCodes: body.failureCodes
      }), requestId);
      return;
    }

    if (pathname === "/api/eval/golden-set" && request.method === "GET") {
      const identity = resolveIdentity(request, response);
      writeJson(response, 200, {
        items: listGoldenSetItems({
          userId: identity.userId,
          status: parsedUrl.searchParams.get("status") || "active"
        })
      }, requestId);
      return;
    }

    const goldenItemMatch = pathname.match(/^\/api\/eval\/golden-set\/(gold-[a-f0-9]{24})$/u);
    if (goldenItemMatch && request.method === "PATCH") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      const body = await readJson(request);
      writeJson(response, 200, {
        item: updateGoldenSetItemLifecycle({
          userId: identity.userId,
          goldenId: goldenItemMatch[1],
          action: body.action
        })
      }, requestId);
      return;
    }

    if (pathname === "/api/eval/datasets" && request.method === "GET") {
      const identity = resolveIdentity(request, response);
      writeJson(response, 200, evalDatasetCatalog({ userId: identity.userId }), requestId);
      return;
    }

    const evalDatasetItemsMatch = pathname.match(/^\/api\/eval\/datasets\/([a-z0-9][a-z0-9-]{1,79})\/items$/u);
    if (evalDatasetItemsMatch && request.method === "GET") {
      const identity = resolveIdentity(request, response);
      writeJson(response, 200, evalDatasetItems({
        userId: identity.userId,
        datasetId: evalDatasetItemsMatch[1],
        status: parsedUrl.searchParams.get("status") || "active"
      }), requestId);
      return;
    }

    if (pathname === "/api/eval/runs" && request.method === "GET") {
      const identity = resolveIdentity(request, response);
      writeJson(response, 200, services.evalRunService.list({
        userId: identity.userId,
        lifecycle: parsedUrl.searchParams.get("lifecycle") || "active"
      }), requestId);
      return;
    }

    if (pathname === "/api/eval/runs" && request.method === "POST") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      const body = await readJson(request);
      writeJson(response, 201, {
        run: services.evalRunService.create({ userId: identity.userId, body })
      }, requestId);
      return;
    }

    const evalRunMatch = pathname.match(/^\/api\/eval\/runs\/(evr-[a-f0-9]{24})$/u);
    if (evalRunMatch && request.method === "GET") {
      const identity = resolveIdentity(request, response);
      writeJson(response, 200, {
        run: services.evalRunService.get({ userId: identity.userId, runId: evalRunMatch[1] })
      }, requestId);
      return;
    }

    if (evalRunMatch && request.method === "PATCH") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      const body = await readJson(request);
      writeJson(response, body.action === "rerun" ? 201 : 200, {
        run: services.evalRunService.action({
          userId: identity.userId,
          runId: evalRunMatch[1],
          action: body.action,
          confirmLive: body.confirmLive === true
        })
      }, requestId);
      return;
    }

    if (pathname === "/api/sessions" && request.method === "GET") {
      const identity = resolveIdentity(request, response);
      writeJson(response, 200, { sessions: listConversations(identity.userId) }, requestId);
      return;
    }
    const sessionMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{8,200})$/u);
    if (sessionMatch && request.method === "DELETE") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      const result = await withSessionLock(coordinator, `${identity.userId}:${sessionMatch[1]}`, async () => (
        deleteConversation({ sessionId: sessionMatch[1], userId: identity.userId })
      ));
      writeJson(response, 200, result, requestId);
      return;
    }

    if (pathname === "/api/artifacts" && request.method === "GET") {
      const identity = resolveIdentity(request, response);
      writeJson(response, 200, { artifacts: listArtifacts(identity.userId) }, requestId);
      return;
    }

    if (pathname === "/api/artifacts/upload" && request.method === "POST") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      const fileName = parsedUrl.searchParams.get("fileName") || "";
      const sessionId = parsedUrl.searchParams.get("sessionId") || "unassigned-upload";
      const buffer = await readBinary(request, config.artifacts.maxArtifactBytes);
      const artifact = createUploadedArtifact({
        userId: identity.userId,
        sessionId,
        fileName,
        mimeType: request.headers["content-type"],
        buffer
      });
      writeJson(response, 201, { artifact }, requestId);
      return;
    }

    const artifactDownloadMatch = pathname.match(/^\/api\/artifacts\/([A-Za-z0-9-]+)\/download$/u);
    if (artifactDownloadMatch && request.method === "GET") {
      const identity = resolveIdentity(request, response);
      const download = artifactDownload({ artifactId: artifactDownloadMatch[1], userId: identity.userId });
      response.writeHead(200, {
        "Content-Type": download.mimeType,
        "Content-Length": download.sizeBytes,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download.fileName)}`,
        "Cache-Control": "private, no-store"
      });
      createReadStream(download.path).pipe(response);
      return;
    }

    const artifactMatch = pathname.match(/^\/api\/artifacts\/([A-Za-z0-9-]+)$/u);
    if (artifactMatch && request.method === "DELETE") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      writeJson(response, 200, deleteArtifact({ artifactId: artifactMatch[1], userId: identity.userId }), requestId);
      return;
    }

    if (pathname === "/api/chat/stream" && request.method === "POST") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      const body = await readJson(request);
      response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
      const emit = payload => { if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(payload)}\n`); };
      emit({ type: "accepted", sessionId: body.sessionId, requestId });
      try {
        const result = await executeChat({ request, response, body, identity, requestId, emit, services, coordinator });
        emit({ type: "result", result });
      } catch (error) {
        logger.error("Streaming chat request failed", { requestId, userId: identity.userId, error });
        emit({ type: "error", ...publicError(error, requestId) });
      } finally { response.end(); }
      return;
    }

    if (pathname === "/api/chat" && request.method === "POST") {
      validateOrigin(request);
      const identity = resolveIdentity(request, response);
      const body = await readJson(request);
      const result = await executeChat({ request, response, body, identity, requestId, emit: null, services, coordinator });
      writeJson(response, 200, result, requestId);
      return;
    }

    if (pathname.startsWith("/api/traces/") && request.method === "GET") {
      const identity = resolveIdentity(request, response);
      const traceId = pathname.slice("/api/traces/".length);
      if (!/^[a-zA-Z0-9_-]+$/.test(traceId)) throw new AppError("Invalid trace id", { code: "invalid_trace", status: 400, expose: true });
      if (!config.traceApi.allowUnowned && !ownsTrace(traceId, identity.userId)) throw new AppError("Trace not found", { code: "trace_not_found", status: 404, expose: true });
      const traceHeaders = {
        "User-Agent": `Personal-Copilot-Runtime-Inspector/${config.service.version}`, "Accept": "application/json", "Connection": "close",
        "X-Eval-Team-Id": config.traceApi.teamId, "X-Eval-Key-Id": config.traceApi.keyId, "X-Request-Id": requestId
      };
      let upstream = await services.fetch(`${config.traceApi.baseUrl}/traces/${encodeURIComponent(traceId)}`, {
        headers: traceHeaders, signal: AbortSignal.timeout(10_000)
      });
      if (upstream.status === 404) {
        await upstream.body?.cancel();
        const catalog = await services.fetch(`${config.traceApi.baseUrl}/traces?limit=500`, {
          headers: traceHeaders, signal: AbortSignal.timeout(10_000)
        });
        if (catalog.ok) {
          const payload = await catalog.json();
          const match = (payload.items || []).find(item => (
            item.trajectory_id === traceId
            || item.trace_id === traceId
            || item.run_ids?.includes(traceId)
            || item.request_ids?.includes(traceId)
          ));
          if (match?.trajectory_id) {
            upstream = await services.fetch(`${config.traceApi.baseUrl}/traces/${encodeURIComponent(match.trajectory_id)}`, {
              headers: traceHeaders, signal: AbortSignal.timeout(10_000)
            });
          }
        } else await catalog.body?.cancel();
      }
      response.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(await upstream.text());
      return;
    }

    if (pathname.startsWith("/api/")) throw new AppError("API route not found", { code: "not_found", status: 404, expose: true });
    if (pathname.split("/").some(segment => segment.startsWith("."))) throw new AppError("Not found", { code: "not_found", status: 404, expose: true });
    const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    let file = join(appRoot, safePath === "/" ? "index.html" : safePath);
    const relativePath = safePath.replace(/^[/\\]/, "");
    const allowedModule = /^src\/web\/[a-z0-9-]+\.mjs$/u.test(relativePath);
    const allowedFont = /^assets\/fonts\/[A-Za-z0-9-]+\.(?:woff2|ttf)$/u.test(relativePath);
    const allowedFile = allowedStaticFiles.has(relativePath) || allowedModule || allowedFont;
    if (!file.startsWith(appRoot) || !allowedFile || !existsSync(file) || statSync(file).isDirectory()) {
      if (relativePath && extname(relativePath)) throw new AppError("静态资源不存在", { code: "not_found", status: 404, expose: true });
      file = join(appRoot, "index.html");
    }
    response.setHeader("Content-Type", types[extname(file)] || "application/octet-stream");
    response.setHeader("Cache-Control", config.environment === "production" && file !== join(appRoot, "index.html") ? "public, max-age=300" : "no-store");
    createReadStream(file).pipe(response);
  } catch (error) {
    logger.error("HTTP request failed", { requestId, method: request.method, pathname, error });
    if (!response.headersSent) writeJson(response, error.status || 500, publicError(error, requestId), requestId);
    else response.end();
  } finally {
    logger.info("HTTP request completed", { requestId, method: request.method, pathname, status: response.statusCode, durationMs: Math.round(performance.now() - started) });
  }
}

export function createApplicationServer(overrides = {}) {
  const evidenceBackfill = backfillEvaluationEvidenceSnapshots();
  if (evidenceBackfill.captured) logger.info("已补齐历史反馈的评估证据快照", evidenceBackfill);
  const services = {
    runAgentTurn,
    fetch: globalThis.fetch,
    evalRunService,
    ...overrides
  };
  const coordinator = createRequestCoordinator();
  const instance = createServer((request, response) => void handleRequest(request, response, { services, coordinator }));
  instance.requestTimeout = config.http.requestTimeoutMs + 5_000;
  instance.headersTimeout = 15_000;
  instance.keepAliveTimeout = 5_000;
  instance.maxRequestsPerSocket = 1000;
  instance.once("close", () => {
    coordinator.close();
    services.evalRunService?.shutdown?.();
  });
  return instance;
}

const isMainModule = Boolean(process.argv[1]) && pathToFileURL(resolvePath(process.argv[1])).href === import.meta.url;
export const server = isMainModule ? createApplicationServer() : null;

if (server) {
  server.listen(config.service.port, config.service.host, () => {
    logger.info("Personal Copilot server started", { address: `http://${config.service.host}:${config.service.port}`, environment: config.environment, authMode: config.auth.mode, tracing: tracingStatus() });
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Graceful shutdown started", { signal });
  server?.close();
  server?.closeIdleConnections?.();
  const force = setTimeout(() => server?.closeAllConnections?.(), config.service.shutdownTimeoutMs);
  force.unref();
  await shutdownTracing();
  await shutdownLangfuseClient();
  closeDatabase();
  clearTimeout(force);
  logger.info("Graceful shutdown completed", { signal });
}

if (isMainModule) {
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", error => {
    logger.error("Uncaught exception", { error });
    void shutdown("uncaughtException").finally(() => process.exit(1));
  });
  process.on("unhandledRejection", error => logger.error("Unhandled rejection", { error: error instanceof Error ? error : new Error(String(error)) }));
}
