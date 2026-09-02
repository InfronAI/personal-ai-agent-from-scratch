import { memoryWriteDecision } from "../../memory-store.mjs";

function cleanAgentName(value) {
  return String(value || "").trim().replaceAll(" ", "_");
}

function usageFor(step) {
  const visible = String(step.content || "").length;
  return {
    input: Number(step.usage?.input || 100),
    output: Number(step.usage?.output || Math.max(1, Math.ceil(visible / 3))),
    total: Number(step.usage?.total || 100 + Math.max(1, Math.ceil(visible / 3))),
    cachedInput: Number(step.usage?.cachedInput || 0),
    reasoning: Number(step.usage?.reasoning || 0)
  };
}

function toolCallsFor(step, index) {
  const calls = step.action === "tools" ? step.calls : [{ tool: step.tool, arguments: step.arguments || {} }];
  return calls.map((call, callIndex) => ({
    id: `eval_call_${index}_${callIndex}`,
    type: "function",
    function: {
      name: call.tool,
      arguments: JSON.stringify(call.arguments || {})
    }
  }));
}

function agentFromMessages(messages, workflowAgents, explicitAgentName = null) {
  if (explicitAgentName) return explicitAgentName;
  const systemPrompt = messages.find(message => message.role === "system")?.content;
  return workflowAgents.find(agent => agent.systemPrompt === systemPrompt)?.name || "unknown";
}

function scriptedCompletion(item, workflowAgents, records) {
  const queue = [...(item.input.script || [])];
  let callIndex = 0;
  let pendingDirectAnswer = null;
  const requestCompletion = async request => {
    const syntheticDirect = request.semanticRole === "direct-response" && pendingDirectAnswer;
    const step = syntheticDirect || queue.shift();
    if (!step) throw new Error(`${item.id}: scripted completion queue is exhausted`);
    const actualAgent = agentFromMessages(request.messages, workflowAgents, request.agentName);
    if (cleanAgentName(step.agent) !== cleanAgentName(actualAgent)) {
      throw new Error(`${item.id}: expected scripted call for ${step.agent}, received ${actualAgent}`);
    }
    const toolCalls = step.action === "answer" ? [] : toolCallsFor(step, callIndex);
    const content = step.action === "answer" ? step.content : String(step.content || "");
    const completion = {
      content,
      toolCalls,
      responseMessage: { role: "assistant", content: content || null, tool_calls: toolCalls },
      messages: request.messages,
      model: String(step.resolvedModel || `eval/${request.model.split("/").at(-1)}`),
      configuredModel: request.model,
      provider: "scripted-eval",
      responseId: `eval_response_${item.id}_${callIndex}`,
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      completionStartTime: new Date(0),
      maxTokens: request.maxTokens,
      completionRetries: 0,
      usage: usageFor(step)
    };
    records.modelCalls.push({ index: callIndex, agent: actualAgent, request, completion });
    if (!syntheticDirect && request.semanticRole === "intent-routing" && step.action === "answer") {
      pendingDirectAnswer = { ...step };
    } else if (syntheticDirect) {
      pendingDirectAnswer = null;
    }
    callIndex += 1;
    return completion;
  };
  return { requestCompletion, remaining: () => queue.length };
}

function scriptedSearch(item, records) {
  return async (query, options) => {
    records.searchCalls.push({ query, options: { maxResults: options.maxResults, requestId: options.requestId } });
    if (item.input.search_error) {
      const error = new Error(String(item.input.search_error.message || "模拟搜索失败"));
      error.code = String(item.input.search_error.code || "search_failed");
      throw error;
    }
    const results = (item.input.search_results || [{
      title: "Eval source",
      url: "https://example.com/eval-source",
      content: "A deterministic search result for the copilot Eval harness.",
      score: 0.99
    }]).map(result => ({ ...result }));
    return {
      answer: item.input.search_answer || null,
      results,
      requestId: `eval_search_${records.searchCalls.length}`
    };
  };
}

function scriptedArtifacts(item, records) {
  const artifacts = (item.input.artifact_seed || []).map((artifact, index) => ({
    artifact_id: artifact.artifact_id || `eval_artifact_${index}`,
    name: artifact.name || `eval_artifact_${index}`,
    title: artifact.title || `评测 Artifact ${index + 1}`,
    kind: artifact.kind || "uploaded_document",
    mime_type: artifact.mime_type || "text/markdown",
    file_name: artifact.file_name || `eval-artifact-${index + 1}.md`,
    size_bytes: Number(artifact.size_bytes || String(artifact.content || "").length),
    download_url: artifact.download_url || `/api/artifacts/eval_artifact_${index}/download`,
    source: artifact.source || { session_id: `eval-artifact-session-${item.id}`, trace_id: null },
    metadata: artifact.metadata || {},
    created_at: artifact.created_at || new Date(0).toISOString(),
    updated_at: artifact.updated_at || new Date(0).toISOString(),
    content: String(artifact.content || "")
  }));
  const listArtifacts = userId => {
    records.artifactLists.push({ userId });
    return artifacts.map(({ content: _content, ...artifact }) => structuredClone(artifact));
  };
  const loadArtifacts = ({ userId, artifactNames }) => {
    records.artifactReads.push({ userId, artifactNames: [...artifactNames] });
    const names = new Set(artifactNames);
    const matching = artifacts.filter(artifact => [artifact.artifact_id, artifact.name, artifact.title, artifact.file_name].some(value => names.has(value)));
    return {
      status: "success",
      artifacts: structuredClone(matching),
      returned_count: matching.length,
      missing_artifact_names: artifactNames.filter(name => !matching.some(artifact => [artifact.artifact_id, artifact.name, artifact.title, artifact.file_name].includes(name))),
      scope: "current_user"
    };
  };
  const prepareModelAttachments = ({ userId, artifactNames }) => {
    const loaded = loadArtifacts({ userId, artifactNames });
    const requiredModalities = new Set();
    const parts = loaded.artifacts.map(artifact => {
      const mimeType = String(artifact.mime_type || "application/octet-stream").toLowerCase();
      if (mimeType.startsWith("image/")) {
        requiredModalities.add("image");
        return { type: "image_url", image_url: { url: `data:${mimeType};base64,${artifact.content}` } };
      }
      if (mimeType === "application/pdf") {
        requiredModalities.add("file");
        return {
          type: "file",
          file: {
            filename: artifact.file_name,
            file_data: `data:${mimeType};base64,${artifact.content}`
          }
        };
      }
      if (mimeType.startsWith("audio/")) {
        requiredModalities.add("audio");
        return {
          type: "input_audio",
          input_audio: {
            data: artifact.content,
            format: mimeType.split("/").at(-1) || "wav"
          }
        };
      }
      return { type: "text", text: `\n\n[附件：${artifact.file_name}]\n${artifact.content}` };
    });
    return {
      artifacts: loaded.artifacts.map(({ content: _content, ...artifact }) => artifact),
      parts,
      totalBytes: loaded.artifacts.reduce((sum, artifact) => sum + artifact.size_bytes, 0),
      requiredModalities: [...requiredModalities],
      missingArtifactNames: loaded.missing_artifact_names
    };
  };
  return { listArtifacts, loadArtifacts, prepareModelAttachments };
}

function scriptedMemory(item, records) {
  const loadMemory = request => {
    records.memoryReads.push(request);
    const memories = (item.input.memory_seed || []).map((memory, index) => ({
      memory_id: memory.memory_id || `eval_memory_${index}`,
      memory_key: memory.memory_key || `eval-memory-${index}`,
      kind: memory.kind || memory.metadata?.type || "explicit_memory",
      content: memory.content || memory.user_message || "",
      importance: memory.importance ?? 0.8,
      confidence: memory.confidence ?? 1,
      expires_at: memory.expires_at || null,
      relevance_score: memory.relevance_score ?? 1,
      source: memory.source || { role: "user", session_id: request.sessionId, trace_id: null },
      metadata: memory.metadata || {}
    }));
    return {
      status: "success",
      query: request.query,
      memories,
      returned_count: memories.length,
      retrieval: { scope: "current_user", strategy: "scripted-eval", candidate_count: memories.length, limit: request.limit }
    };
  };
  const rememberConversationTurn = request => {
    const policy = memoryWriteDecision(request.userMessage);
    records.memoryDecisions.push({ request, policy });
    if (policy.action === "forget") {
      return {
        action: "forget",
        stored: false,
        reason: policy.reason,
        deleted_count: 0,
        policy_version: policy.policyVersion
      };
    }
    if (!policy.shouldWrite) {
      return { action: "skip", stored: false, reason: policy.reason, policy_version: policy.policyVersion };
    }
    records.memoryWrites.push({ ...request, decision: policy });
    return {
      action: "upsert",
      stored: true,
      memory_id: `eval_written_${item.id}`,
      memory_key: policy.memoryKey,
      kind: policy.kind,
      expires_at: new Date(policy.ttlDays * 86_400_000).toISOString(),
      policy_version: policy.policyVersion,
      created_at: new Date(0).toISOString()
    };
  };
  return { loadMemory, rememberConversationTurn };
}

function executionInput(item) {
  const messages = item.input.messages;
  return {
    prompt: messages.at(-1).content,
    history: messages.slice(0, -1).filter(message => message.role === "user" || message.role === "assistant"),
    sessionId: `eval-session-${item.id}`.slice(0, 199),
    requestId: `eval-request-${item.id}`.slice(0, 199),
    userId: `eval-user-${item.id}`.slice(0, 199),
    model: item.input.model || "model-router",
    artifactNames: Array.isArray(item.input.artifact_names) ? item.input.artifact_names : []
  };
}

export async function runScriptedScenario(item, { runAgentTurn, workflowAgents }) {
  const records = { modelCalls: [], searchCalls: [], memoryReads: [], memoryWrites: [], memoryDecisions: [], artifactLists: [], artifactReads: [], streamedEvents: [] };
  const completion = scriptedCompletion(item, workflowAgents, records);
  const memory = scriptedMemory(item, records);
  const artifacts = scriptedArtifacts(item, records);
  const input = executionInput(item);
  try {
    const result = await runAgentTurn({
      ...input,
      onRuntimeEvent: event => records.streamedEvents.push(event),
      dependencies: {
        requestCompletion: completion.requestCompletion,
        searchWithTavily: scriptedSearch(item, records),
        ...artifacts,
        ...memory
      }
    });
    if (completion.remaining()) throw new Error(`${item.id}: ${completion.remaining()} scripted model calls were not consumed`);
    return { item, input, result, records, error: null, mode: "offline-scripted" };
  } catch (error) {
    return { item, input, result: null, records, error, mode: "offline-scripted" };
  }
}

export async function runLiveScenario(item, { runAgentTurn }) {
  const records = { streamedEvents: [], memoryWrites: [], memoryDecisions: [] };
  const input = executionInput(item);
  const started = performance.now();
  try {
    const result = await runAgentTurn({ ...input, onRuntimeEvent: event => records.streamedEvents.push(event) });
    if (result.memory?.stored) records.memoryWrites.push(result.memory);
    return { item, input, result, records, error: null, wallTimeMs: performance.now() - started, mode: "live" };
  } catch (error) {
    return { item, input, result: null, records, error, wallTimeMs: performance.now() - started, mode: "live" };
  }
}
