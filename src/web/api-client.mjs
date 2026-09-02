const ERROR_MESSAGES = Object.freeze({
  unauthorized: "Sign in to continue.",
  invalid_username: "Enter a valid username.",
  login_managed_upstream: "Sign-in is managed by the configured identity provider.",
  forbidden_origin: "This request was blocked because its origin is not allowed.",
  setup_configuration_forbidden: "You do not have permission to change this instance configuration.",
  invalid_setup_url: "Enter a valid HTTP(S) URL without embedded credentials.",
  insecure_setup_url: "Production endpoints must use HTTPS.",
  invalid_setup_model: "Enter a valid model ID.",
  invalid_setup_api_key: "Enter a valid API Key.",
  invalid_langfuse_key: "Enter a valid Langfuse project key.",
  invalid_langfuse_environment: "Enter a valid Langfuse environment name.",
  incomplete_langfuse_credentials: "Langfuse Public Key and Secret Key must be configured together.",
  llm_not_configured: "Configure the LLM Gateway API Key before continuing.",
  setup_gateway_unreachable: "Could not reach the LLM Gateway. Check the Base URL and network connection.",
  setup_gateway_unauthorized: "The LLM Gateway rejected the API Key.",
  setup_gateway_payment_required: "The LLM Gateway account has insufficient credit.",
  setup_gateway_forbidden: "The LLM Gateway rejected this model or request.",
  setup_gateway_rate_limited: "The LLM Gateway is rate-limited. Try again shortly.",
  setup_gateway_no_provider: "No provider is currently available for this model.",
  setup_gateway_rejected: "The LLM Gateway verification request failed.",
  setup_gateway_empty_completion: "The LLM Gateway responded without a usable completion.",
  session_forbidden: "This session belongs to another user.",
  session_not_found: "The requested session was not found.",
  turn_not_found: "The requested conversation turn was not found.",
  evaluation_evidence_not_found: "Evaluation evidence is not available for this feedback candidate.",
  evaluation_evidence_unavailable: "The point-in-time evaluation evidence could not be captured.",
  eval_dataset_not_found: "The requested Eval Dataset was not found.",
  eval_run_not_found: "The requested Eval Run was not found.",
  invalid_eval_run_name: "Enter an Eval Run name between 1 and 120 characters.",
  invalid_eval_run_profile: "Select a configured Eval Profile.",
  invalid_eval_run_datasets: "Select at least one available Eval Dataset.",
  eval_run_dataset_empty: "The selected Eval Dataset has no active cases.",
  eval_run_minimum_cases: "The selected datasets do not meet this profile's minimum case count.",
  eval_run_live_confirmation_required: "Confirm live model and tool usage before starting this run.",
  eval_run_not_startable: "Only an active Draft can be started.",
  eval_run_not_cancellable: "Only a queued or running Eval Run can be cancelled.",
  eval_run_not_rerunnable: "Only a completed, failed, or cancelled Eval Run can be rerun.",
  eval_run_active_execution: "Cancel the active Eval Run before archiving it.",
  invalid_eval_run_lifecycle: "Select a valid Eval Run lifecycle filter.",
  invalid_eval_run_action: "Select a valid Eval Run action.",
  eval_runner_unavailable: "The Eval Runner is currently unavailable.",
  invalid_golden_status: "Select a valid Golden Set lifecycle status.",
  invalid_golden_action: "Select a valid Golden Set lifecycle action.",
  golden_item_not_found: "The requested Golden Set item was not found.",
  payload_too_large: "The uploaded file is too large.",
  empty_upload: "The uploaded file is empty.",
  unsupported_upload: "This file type is not supported.",
  invalid_file_name: "The file name is invalid.",
  invalid_artifacts: "Select no more than 10 attachments.",
  artifact_not_found: "One or more attachments could not be found.",
  invalid_memory_content: "Memory content cannot be empty.",
  sensitive_memory: "Long-term memory cannot store credentials or sensitive information.",
  invalid_memory_kind: "Select a valid memory type.",
  invalid_memory_ttl: "Memory retention must be between 1 and 3,650 days.",
  memory_not_found: "The requested memory was not found.",
  invalid_model: "Select a supported response model.",
  model_modality_mismatch: "The selected model does not support these attachments.",
  model_route_unavailable: "Model Router could not select a compatible model."
});

function publicErrorMessage(payload, fallback, status = null) {
  if (payload?.code && ERROR_MESSAGES[payload.code]) return ERROR_MESSAGES[payload.code];
  const upstream = String(payload?.error || payload?.detail || "").trim();
  if (upstream && !/[\u3400-\u9fff]/u.test(upstream)) return upstream;
  return status ? `${fallback} (HTTP ${status})` : fallback;
}

async function jsonError(response, fallback) {
  const payload = await response.json().catch(() => ({}));
  const error = new Error(publicErrorMessage(payload, fallback, response.status));
  error.code = payload.code || null;
  error.status = response.status;
  error.requestId = payload.requestId || null;
  return error;
}

export async function fetchCurrentUser() {
  const response = await fetch("/api/auth/me", { headers: { "Accept": "application/json" } });
  if (!response.ok) throw await jsonError(response, "Could not load sign-in status");
  return response.json();
}

export async function loginWithUsername(username) {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ username })
  });
  if (!response.ok) throw await jsonError(response, "Could not sign in");
  return response.json();
}

export async function logoutCurrentUser() {
  const response = await fetch("/api/auth/logout", {
    method: "POST",
    headers: { "Accept": "application/json" }
  });
  if (!response.ok) throw await jsonError(response, "Could not sign out");
  return response.json();
}

export async function fetchSetupState() {
  const response = await fetch("/api/setup", { headers: { "Accept": "application/json" } });
  if (!response.ok) throw await jsonError(response, "Could not load core configuration status");
  return response.json();
}

export async function updateCoreConfiguration(payload) {
  const response = await fetch("/api/setup/configuration", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw await jsonError(response, "Could not save core configuration");
  return response.json();
}

export async function completeCoreSetup() {
  const response = await fetch("/api/setup/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: "{}"
  });
  if (!response.ok) throw await jsonError(response, "Core configuration verification failed");
  return response.json();
}

export async function fetchSessions() {
  const response = await fetch("/api/sessions", { headers: { "Accept": "application/json" } });
  if (!response.ok) throw await jsonError(response, "Could not load conversations");
  return response.json();
}

export async function deleteSession(sessionId) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: { "Accept": "application/json" }
  });
  if (!response.ok) throw await jsonError(response, "Could not delete the conversation");
  return response.json();
}

export async function fetchArtifacts() {
  const response = await fetch("/api/artifacts", { headers: { "Accept": "application/json" } });
  if (!response.ok) throw await jsonError(response, "Could not load artifacts");
  return response.json();
}

export async function uploadArtifact(file, sessionId) {
  const query = new URLSearchParams({ fileName: file.name, sessionId });
  const response = await fetch(`/api/artifacts/upload?${query}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream", "Accept": "application/json" },
    body: file
  });
  if (!response.ok) throw await jsonError(response, `Could not upload ${file.name}`);
  return response.json();
}

export async function fetchModelCatalog() {
  const response = await fetch("/api/models", { headers: { "Accept": "application/json" } });
  if (!response.ok) throw await jsonError(response, "Could not load the model catalog");
  return response.json();
}

export async function fetchMemories() {
  const response = await fetch("/api/memories", { headers: { "Accept": "application/json" } });
  if (!response.ok) throw await jsonError(response, "Could not load long-term memory");
  return response.json();
}

export async function setMemoryEnabled(enabled) {
  const response = await fetch("/api/memory/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ enabled })
  });
  if (!response.ok) throw await jsonError(response, "Could not update memory settings");
  return response.json();
}

export async function createMemory(payload) {
  const response = await fetch("/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw await jsonError(response, "Could not add long-term memory");
  return response.json();
}

export async function updateMemory(memoryId, payload) {
  const response = await fetch(`/api/memories/${encodeURIComponent(memoryId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw await jsonError(response, "Could not update long-term memory");
  return response.json();
}

export async function deleteMemory(memoryId) {
  const response = await fetch(`/api/memories/${encodeURIComponent(memoryId)}`, {
    method: "DELETE",
    headers: { "Accept": "application/json" }
  });
  if (!response.ok) throw await jsonError(response, "Could not delete long-term memory");
  return response.json();
}

export async function submitFeedback({ requestId, value, comment = null }) {
  const response = await fetch("/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ requestId, value, comment })
  });
  if (!response.ok) throw await jsonError(response, "Could not save feedback");
  return response.json();
}

export async function fetchFeedbackCandidates(status = "candidate") {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const response = await fetch(`/api/eval/feedback-candidates${query}`, { headers: { "Accept": "application/json" } });
  if (!response.ok) throw await jsonError(response, "Could not load Eval feedback candidates");
  return response.json();
}

export async function fetchFeedbackEvidence(candidateId) {
  const response = await fetch(`/api/eval/feedback-candidates/${encodeURIComponent(candidateId)}/evidence`, {
    headers: { "Accept": "application/json" }
  });
  if (!response.ok) throw await jsonError(response, "Could not load evaluation evidence");
  return response.json();
}

export async function fetchGoldenSet(status = "active") {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const response = await fetch(`/api/eval/golden-set${query}`, { headers: { "Accept": "application/json" } });
  if (!response.ok) throw await jsonError(response, "Could not load the Golden Set");
  return response.json();
}

export async function fetchEvalDatasets() {
  const response = await fetch("/api/eval/datasets", { headers: { "Accept": "application/json" } });
  if (!response.ok) throw await jsonError(response, "Could not load Eval Datasets");
  return response.json();
}

export async function fetchEvalDatasetItems(datasetId, status = "active") {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const response = await fetch(`/api/eval/datasets/${encodeURIComponent(datasetId)}/items${query}`, {
    headers: { "Accept": "application/json" }
  });
  if (!response.ok) throw await jsonError(response, "Could not load Eval Dataset items");
  return response.json();
}

export async function fetchEvalRuns(lifecycle = "active") {
  const query = lifecycle ? `?lifecycle=${encodeURIComponent(lifecycle)}` : "";
  const response = await fetch(`/api/eval/runs${query}`, { headers: { "Accept": "application/json" } });
  if (!response.ok) throw await jsonError(response, "Could not load Eval Runs");
  return response.json();
}

export async function fetchEvalRun(runId) {
  const response = await fetch(`/api/eval/runs/${encodeURIComponent(runId)}`, {
    headers: { "Accept": "application/json" }
  });
  if (!response.ok) throw await jsonError(response, "Could not load the Eval Run");
  return response.json();
}

export async function createEvalRun(payload) {
  const response = await fetch("/api/eval/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw await jsonError(response, "Could not create the Eval Run");
  return response.json();
}

export async function updateEvalRun(runId, action, payload = {}) {
  const response = await fetch(`/api/eval/runs/${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ action, ...payload })
  });
  if (!response.ok) throw await jsonError(response, "Could not update the Eval Run");
  return response.json();
}

export async function updateGoldenSetLifecycle(goldenId, action) {
  const response = await fetch(`/api/eval/golden-set/${encodeURIComponent(goldenId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ action })
  });
  if (!response.ok) throw await jsonError(response, "Could not update the Golden Set item");
  return response.json();
}

export async function reviewFeedbackCandidate(candidateId, payload) {
  const response = await fetch(`/api/eval/feedback-candidates/${encodeURIComponent(candidateId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw await jsonError(response, "Could not review the feedback candidate");
  return response.json();
}

export async function streamChat({ prompt, sessionId, requestId, model, artifactNames = [], signal, onMessage }) {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/x-ndjson" },
    body: JSON.stringify({ prompt, sessionId, requestId, model, artifactNames }),
    signal
  });
  if (!response.ok) throw await jsonError(response, "Personal Copilot request failed");
  if (!response.body) throw new Error("Personal Copilot API returned no response stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      onMessage?.(message);
      if (message.type === "result") result = message.result;
      if (message.type === "error") throw new Error(publicErrorMessage(message, "Personal Copilot streaming request failed"));
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const message = JSON.parse(buffer);
    onMessage?.(message);
    if (message.type === "result") result = message.result;
    if (message.type === "error") throw new Error(publicErrorMessage(message, "Personal Copilot streaming request failed"));
  }
  if (!result) throw new Error("Personal Copilot stream ended without a final result");
  return result;
}
