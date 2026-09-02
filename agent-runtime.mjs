import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";

import { config } from "./config.mjs";
import { listArtifacts, prepareModelAttachments } from "./artifacts/artifact-store.mjs";
import { executeCapability } from "./capabilities/executor.mjs";
import { capabilityNames, validateCapabilityArguments } from "./capabilities/registry.mjs";
import { AppError } from "./errors.mjs";
import { createHarnessController } from "./harness-controller.mjs";
import { agentWorkflow, routingSystem, workflowAgent } from "./workflow.mjs";
import { requestCompletion } from "./llm-gateway.mjs";
import { logger } from "./logger.mjs";
import { rememberConversationTurn } from "./memory-store.mjs";
import { selectedModel } from "./model-catalog.mjs";
import { createRuntimeRecorder } from "./runtime-events.mjs";

const defaultModelRoute = routingSystem.model.route({ role: "specialist" });
const defaultDeploymentRoute = routingSystem.deployment.route({ workload: "llm", modelRoute: defaultModelRoute });
const DEFAULT_MODEL = defaultDeploymentRoute.model;
const SEARCH_TOOL_NAME = "TavilySearchTool";
const runtimeIds = new WeakMap();
export const EXECUTABLE_TOOL_NAMES = capabilityNames;

function runtimeDependencies(overrides = {}) {
  return {
    requestCompletion,
    rememberConversationTurn,
    listArtifacts,
    prepareModelAttachments,
    ...overrides
  };
}

const text = (value, max = 6000) => String(value || "").trim().slice(0, max);
const elapsed = start => {
  const ms = performance.now() - start;
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.max(0, Math.round(ms))} ms`;
};
function runtimeId(observation) {
  if (!observation || (typeof observation !== "object" && typeof observation !== "function")) return null;
  if (!runtimeIds.has(observation)) runtimeIds.set(observation, `obs-${crypto.randomUUID()}`);
  return runtimeIds.get(observation);
}

function usableTraceId(traceId) {
  const value = String(traceId || "");
  return value && !/^0+$/u.test(value) ? value : `trace-${crypto.randomUUID()}`;
}

const runtimeEvent = (observation, fields) => ({ id: runtimeId(observation), ...fields });

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-(config.database.historyTurns * 2)).map(item => ({
    role: item?.role === "assistant" ? "assistant" : "user",
    content: Array.isArray(item?.content)
      ? structuredClone(item.content.slice(0, 20))
      : text(item?.content)
  }));
}

function toolArguments(toolCall) {
  const raw = toolCall?.function?.arguments;
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(raw || "{}"); } catch { return { raw }; }
}

function messagesFor(agent, history, prompt, attachmentParts = []) {
  const userContent = attachmentParts.length
    ? [{ type: "text", text: prompt }, ...attachmentParts]
    : prompt;
  return [{ role: "system", content: agent.systemPrompt }, ...history, { role: "user", content: userContent }];
}

function traceMessageContent(content) {
  if (!Array.isArray(content)) return content;
  return content.map(part => {
    if (part?.type === "image_url") {
      const url = String(part.image_url?.url || "");
      const mediaType = url.match(/^data:([^;,]+)/u)?.[1] || null;
      return { type: "image_url", image_url: { url: "[用户上传图像]", media_type: mediaType } };
    }
    if (part?.type === "file") {
      return { type: "file", file: { filename: part.file?.filename || null, file_data: "[用户上传文件]" } };
    }
    if (part?.type === "input_audio") {
      return { type: "input_audio", input_audio: { format: part.input_audio?.format || null, data: "[用户上传音频]" } };
    }
    return part;
  });
}

function traceMessages(messages) {
  return messages.map(message => ({ ...message, content: traceMessageContent(message.content) }));
}

function parametersFor(agent, configuredModel, completion = null, modelRoute = null) {
  const parameters = {
    temperature: modelRoute?.parameters?.temperature ?? 0,
    max_tokens: completion?.maxTokens || modelRoute?.parameters?.maxTokens || 1200,
    tools: agent.tools,
    system_instruction: agent.systemPrompt,
    configured_model: configuredModel,
    resolved_model: completion?.model || null,
    logical_model_alias: modelRoute?.modelAlias || null,
    model_selection_mode: modelRoute?.selectionMode || null,
    model_policy_id: modelRoute?.policyId || null
  };
  if (agent.name === agentWorkflow.rootAgentId) {
    parameters.workflow_schema = agentWorkflow.schemaVersion;
    parameters.routable_agents = agent.routableAgents;
  }
  return parameters;
}

function outputFor(completion) {
  return {
    role: "assistant",
    content: completion.content || null,
    tool_calls: completion.toolCalls,
    finish_reason: completion.finishReason,
    usage: completion.usage
  };
}

function assistantToolMessage(completion) {
  return { role: "assistant", content: completion.content || null, tool_calls: completion.toolCalls };
}

function toolActor(name, agentName) {
  if (name === SEARCH_TOOL_NAME) return "Tavily-compatible Search";
  if (name === "load_memory") return "Personal Copilot Memory · SQLite";
  if (name === "load_artifacts") return "Personal Copilot Artifact Store · SQLite";
  if (name === "generate_pdf" || name === "generate_docx") return "Personal Copilot Document Engine";
  return agentName;
}

function toolExecutionMetadata(name, result) {
  if (name === SEARCH_TOOL_NAME) {
    return { original_tool_name: name, execution_provider: result.provider || "tavily-compatible" };
  }
  if (name === "load_memory") {
    return {
      original_tool_name: name,
      execution_provider: "copilot-memory-sqlite",
      memory_scope: "current_user",
      retrieval_strategy: result.retrieval?.strategy || null,
      returned_count: result.returned_count || 0
    };
  }
  if (name === "load_artifacts") {
    return {
      original_tool_name: name,
      execution_provider: "copilot-artifact-store",
      returned_count: result.returned_count || 0
    };
  }
  if (name === "generate_pdf" || name === "generate_docx") {
    return {
      original_tool_name: name,
      execution_provider: "copilot-document-engine",
      artifact_id: result.artifact?.artifact_id || null,
      artifact_format: result.format || null
    };
  }
  return { original_tool_name: name, execution_provider: "copilot-local" };
}

function completedToolSummary(name, result) {
  if (name === SEARCH_TOOL_NAME) return `Returned ${result.search_result.length} search results.`;
  if (name === "load_memory") return `Retrieved ${result.returned_count || 0} active memories for the current user.`;
  if (name === "load_artifacts") return `Loaded ${result.returned_count || 0} user-owned artifacts.`;
  if (name === "generate_pdf" || name === "generate_docx") return `Generated ${result.format?.toUpperCase() || "document"} artifact ${result.artifact?.file_name || ""}.`.trim();
  return `${name} completed.`;
}

async function resolveToolDeployment({ name, parentAgent, depth, recordRuntime }) {
  if (name !== SEARCH_TOOL_NAME) return { route: null, connection: null };
  const route = routingSystem.deployment.route({ workload: "search" });
  await recordRoutingLayer({
    name: "select-deployment",
    semanticRole: "deployment-routing",
    actor: "Deployment Router",
    input: { workload: "search", capability: name },
    output: route,
    summary: `Selected deployment profile ${route.profileId} for ${name}.`,
    parentAgent,
    depth,
    recordRuntime
  });
  return { route, connection: routingSystem.deployment.credentials(route) };
}

function memoryCaptureEvidence(result) {
  return {
    action: result?.action || (result?.memory_id ? "upsert" : "skip"),
    stored: Boolean(result?.stored ?? result?.memory_id),
    reason: result?.reason || null,
    memory_id: result?.memory_id || null,
    memory_key: result?.memory_key || null,
    kind: result?.kind || null,
    superseded_count: Number(result?.superseded_count || 0),
    deleted_count: Number(result?.deleted_count || 0),
    expires_at: result?.expires_at || null,
    policy_version: result?.policy_version || null,
    error_code: result?.error_code || null
  };
}

async function captureLongTermMemory({
  dependencies,
  userId,
  sessionId,
  traceId,
  requestId,
  userMessage,
  assistantResponse,
  specialist,
  completion,
  artifacts,
  invocation,
  recordRuntime
}) {
  const started = performance.now();
  return startActiveObservation("memory_capture", async memorySpan => {
    const input = {
      source_role: "user",
      source_characters: [...String(userMessage || "")].length,
      source_hash: crypto.createHash("sha256").update(String(userMessage || "")).digest("hex"),
      scope: "current_user"
    };
    try {
      const result = await dependencies.rememberConversationTurn({
        userId,
        sessionId,
        traceId,
        userMessage,
        assistantResponse,
        metadata: {
          specialist: specialist || agentWorkflow.rootAgentId,
          model: completion?.configuredModel || DEFAULT_MODEL,
          resolved_model: completion?.model || null,
          artifact_ids: artifacts.map(item => item.artifact_id)
        }
      });
      const output = memoryCaptureEvidence(result);
      memorySpan.update({ input, output, metadata: { memory_scope: "current_user", policy_version: output.policy_version } });
      recordRuntime(runtimeEvent(memorySpan, {
        kind: "SPAN",
        name: "memory_capture",
        semanticRole: "memory-write",
        actor: "Personal Copilot Memory · SQLite",
        durationMs: performance.now() - started,
        depth: 1,
        parentId: runtimeId(invocation),
        status: "completed",
        summary: output.stored
          ? `Stored one ${output.kind || "long-term"} memory.`
          : output.action === "forget"
            ? `Forgot ${output.deleted_count} matching memories.`
            : `Skipped memory capture: ${output.reason || "not reusable"}.`,
        input,
        output,
        metadata: { memory_scope: "current_user", policy_version: output.policy_version }
      }));
      return result;
    } catch (error) {
      const output = memoryCaptureEvidence({
        action: "skip",
        stored: false,
        reason: "memory_write_failed",
        error_code: error?.code || "memory_write_failed"
      });
      memorySpan.update({
        input,
        output,
        level: "ERROR",
        statusMessage: "Long-term memory capture failed; the answer was preserved."
      });
      recordRuntime(runtimeEvent(memorySpan, {
        kind: "SPAN",
        name: "memory_capture",
        semanticRole: "memory-write",
        actor: "Personal Copilot Memory · SQLite",
        durationMs: performance.now() - started,
        depth: 1,
        parentId: runtimeId(invocation),
        status: "error",
        summary: "Long-term memory capture failed without failing the answer.",
        input,
        output,
        metadata: { memory_scope: "current_user", errorCode: output.error_code }
      }));
      logger.warn("长期记忆写入失败，主回答已保留", { requestId, traceId, error });
      return output;
    }
  }, { asType: "span", parentSpanContext: invocation.otelSpan.spanContext() });
}

async function recordDeduplicatedTool({ name, args, callId, result, parentAgent, depth, agentName, recordRuntime }) {
  return startActiveObservation("tool_deduplicated", async guard => {
    const metadata = { toolCallId: callId, capability: name, deduplicated: true };
    guard.update({ input: { capability: name, arguments: args }, output: result, metadata });
    recordRuntime(runtimeEvent(guard, {
      kind: "SPAN",
      name: "tool_deduplicated",
      actor: "Personal Copilot Harness",
      depth,
      parentId: runtimeId(parentAgent),
      status: "completed",
      summary: `Reused the previous ${name} result instead of executing the same call again.`,
      input: { capability: name, arguments: args },
      output: result,
      metadata: { ...metadata, agentName }
    }));
    return result;
  }, { asType: "span", parentSpanContext: parentAgent.otelSpan.spanContext() });
}

async function recordRoutingLayer({ name, semanticRole, actor, input, output, summary, parentAgent, depth, recordRuntime }) {
  return startActiveObservation(name, async routeSpan => {
    routeSpan.update({ input, output, metadata: { schema_version: output.schemaVersion, router_version: output.routerVersion } });
    recordRuntime(runtimeEvent(routeSpan, {
      kind: "SPAN",
      name,
      actor,
      depth,
      parentId: runtimeId(parentAgent),
      status: "completed",
      summary,
      input,
      output,
      semanticRole,
      metadata: { schemaVersion: output.schemaVersion, routerVersion: output.routerVersion }
    }));
    return output;
  }, { asType: "span", parentSpanContext: parentAgent.otelSpan.spanContext() });
}

async function runModelCall({ agent, agentName, messages, parent, depth, semanticRole = null, intent = null, requestedModelAlias = null, requiredModalities = [], recordRuntime, signal, requestId, dependencies, harness }) {
  if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
  harness.beforeModelCall();
  const modelRole = semanticRole === "intent-routing" ? "intent" : agentName === agentWorkflow.rootAgentId ? "direct" : "specialist";
  const modelRoute = routingSystem.model.route({
    role: modelRole,
    intent,
    agentId: agentName,
    requestedModelAlias,
    requiredModalities,
    routingKey: requestId
  });
  const deploymentRoute = routingSystem.deployment.route({ workload: "llm", modelRoute });
  const configuredModel = deploymentRoute.model;
  const connection = routingSystem.deployment.credentials(deploymentRoute);
  await recordRoutingLayer({
    name: "select-model",
    semanticRole: "model-routing",
    actor: "Model Router",
    input: {
      role: modelRole,
      agentId: agentName,
      requestedModelAlias: modelRole === "intent" ? null : requestedModelAlias,
      requiredModalities,
      intent: intent ? { domain: intent.domain, taskType: intent.taskType, risk: intent.risk } : null
    },
    output: modelRoute,
    summary: `Selected concrete model ${modelRoute.modelAlias} with policy ${modelRoute.policyId}.`,
    parentAgent: parent,
    depth,
    recordRuntime
  });
  await recordRoutingLayer({
    name: "select-deployment",
    semanticRole: "deployment-routing",
    actor: "Deployment Router",
    input: { workload: "llm", modelAlias: modelRoute.modelAlias },
    output: deploymentRoute,
    summary: `Selected deployment profile ${deploymentRoute.profileId}.`,
    parentAgent: parent,
    depth,
    recordRuntime
  });
  const generationName = semanticRole === "intent-routing"
    ? "intent-routing"
    : semanticRole === "direct-response"
      ? "direct-response"
      : "specialist-response";
  const observableMessages = traceMessages(messages);
  const callStarted = performance.now();
  return startActiveObservation("call_llm", async callLlm => {
    callLlm.update({ input: { agent: agentName, message_count: messages.length }, metadata: { workflow_role: semanticRole, request_id: requestId } });
    recordRuntime(runtimeEvent(callLlm, {
      kind: "SPAN", name: "call_llm", actor: configuredModel, duration: "Running", depth,
      parentId: runtimeId(parent), status: "running",
      summary: semanticRole === "intent-routing" ? "Personal Copilot intent detection and routing model call." : `Calling the model as ${agentName}.`,
      input: { messages: observableMessages, model_parameters: parametersFor(agent, configuredModel, null, modelRoute) }, output: null, semanticRole
    }));

    return startActiveObservation(generationName, async generation => {
      const generationStarted = performance.now();
      generation.update({
        model: configuredModel,
        input: messages,
        modelParameters: parametersFor(agent, configuredModel, null, modelRoute),
        metadata: {
          agent_id: agentName,
          workflow_role: semanticRole,
          logical_model_alias: modelRoute.modelAlias,
          model_policy_id: modelRoute.policyId,
          model_selection_mode: modelRoute.selectionMode,
          model_selection_reason: modelRoute.selectionReasonCode,
          model_candidate_aliases: modelRoute.candidateModelAliases,
          deployment_profile_id: deploymentRoute.profileId
        }
      });
      recordRuntime(runtimeEvent(generation, {
        kind: "GENERATION", name: generationName, actor: configuredModel, duration: "Running", depth: depth + 1,
        parentId: runtimeId(callLlm), status: "running",
        summary: semanticRole === "intent-routing"
          ? "Intent detection and routing using the configured root Agent prompt."
          : semanticRole === "direct-response"
            ? "Generating the direct user-facing response with the selected answer model."
            : `Running the configured ${agentName} prompt and tools.`,
        input: { messages: observableMessages, model_parameters: parametersFor(agent, configuredModel, null, modelRoute) }, output: null, semanticRole
      }));

      let completion;
      try {
        completion = await dependencies.requestCompletion({
          agentName,
          semanticRole,
          messages,
          model: configuredModel,
          tools: agent.tools,
          temperature: modelRoute.parameters.temperature,
          maxTokens: modelRoute.parameters.maxTokens,
          signal,
          requestId,
          connection
        });
        routingSystem.model.observe({
          modelAlias: modelRoute.modelAlias,
          success: true,
          latencyMs: performance.now() - generationStarted
        });
      } catch (error) {
        routingSystem.model.observe({
          modelAlias: modelRoute.modelAlias,
          success: false,
          latencyMs: performance.now() - generationStarted,
          errorCode: error.code || error.name || "model-call-failed"
        });
        throw error;
      }
      harness.afterModelCall(agentName, completion);
      const output = outputFor(completion);
      const metadata = {
        agent_id: agentName,
        workflow_role: semanticRole,
        provider: completion.provider,
        configured_model: configuredModel,
        resolved_model: completion.model,
        completion_token_budget: completion.maxTokens,
        completion_retries: completion.completionRetries,
        response_id: completion.responseId,
        finish_reason: completion.finishReason
      };
      metadata.logical_model_alias = modelRoute.modelAlias;
      metadata.model_selection_mode = modelRoute.selectionMode;
      metadata.model_selection_reason = modelRoute.selectionReasonCode;
      metadata.model_candidate_aliases = modelRoute.candidateModelAliases;
      generation.update({ model: configuredModel, output, usageDetails: completion.usage, completionStartTime: completion.completionStartTime, metadata });
      callLlm.update({ output: { finish_reason: completion.finishReason, requested_tools: completion.toolCalls.map(item => item.function?.name) }, metadata });
      recordRuntime(runtimeEvent(generation, {
        kind: "GENERATION", name: generationName, actor: `${completion.provider} · ${completion.model}`,
        duration: elapsed(generationStarted), depth: depth + 1, parentId: runtimeId(callLlm), status: "completed",
        summary: completion.toolCalls.length ? `Requested ${completion.toolCalls.map(item => item.function?.name).join(", ")}.` : "Generated the agent response.",
        input: { messages: observableMessages, model_parameters: parametersFor(agent, configuredModel, completion, modelRoute) }, output, semanticRole,
        metadata: {
          logicalModelAlias: modelRoute.modelAlias,
          modelPolicyId: modelRoute.policyId,
          modelSelectionMode: modelRoute.selectionMode,
          modelSelectionReason: modelRoute.selectionReasonCode,
          deploymentProfileId: deploymentRoute.profileId
        }
      }));
      recordRuntime(runtimeEvent(callLlm, {
        kind: "SPAN", name: "call_llm", actor: `${completion.provider} · ${completion.model}`,
        duration: elapsed(callStarted), depth, parentId: runtimeId(parent), status: "completed",
        summary: completion.toolCalls.length ? "Model requested tool execution." : "Model call completed.",
        input: { messages: observableMessages, model_parameters: parametersFor(agent, configuredModel, completion, modelRoute) }, output, semanticRole,
        metadata: {
          logicalModelAlias: modelRoute.modelAlias,
          modelPolicyId: modelRoute.policyId,
          modelSelectionMode: modelRoute.selectionMode,
          modelSelectionReason: modelRoute.selectionReasonCode,
          deploymentProfileId: deploymentRoute.profileId
        }
      }));
      return {
        completion: { ...completion, routing: { model: modelRoute, deployment: deploymentRoute } },
        generation,
        modelRoute,
        deploymentRoute
      };
    }, { asType: "generation" });
  }, { asType: "span" });
}

async function runSpecialist({
  agentName,
  prompt,
  history,
  userId,
  sessionId,
  traceId,
  promptContext,
  parentAgent,
  recordRuntime,
  signal,
  requestId,
  harness,
  dependencies,
  intent,
  requestedModelAlias,
  requiredModalities = [],
  attachmentParts = []
}) {
  const agent = workflowAgent(agentName, promptContext);
  if (!agent) throw new Error(`Personal Copilot has no executable workflow configuration for ${agentName}`);
  const started = performance.now();
  return startActiveObservation(`agent_run [${agentName}]`, async agentRun => {
    const initialMessages = messagesFor(agent, history, prompt, attachmentParts);
    agentRun.update({ input: initialMessages, metadata: { agent_id: agentName } });
    recordRuntime(runtimeEvent(agentRun, {
      kind: "AGENT RUN", name: `agent_run [${agentName}]`, actor: agentName, duration: "Running", depth: 2,
      parentId: runtimeId(parentAgent), status: "running", summary: `Executing the ${agentName} workflow.`,
      input: { messages: traceMessages(initialMessages) }, output: null
    }));

    const messages = [...initialMessages];
    let finalCompletion = null;
    let sourceCount = 0;
    const artifacts = [];
    for (let iteration = 0; iteration < config.agent.specialistMaxIterations; iteration += 1) {
      const step = await runModelCall({
        agent,
        agentName,
        messages,
        parent: agentRun,
        depth: 3,
        recordRuntime,
        signal,
        requestId,
        dependencies,
        harness,
        intent,
        requestedModelAlias,
        requiredModalities
      });
      finalCompletion = step.completion;
      if (!step.completion.toolCalls.length) break;
      const toolMessages = [];
      for (const call of step.completion.toolCalls) {
        const name = call.function?.name || "unknown_tool";
        const args = toolArguments(call);
        const toolPlan = harness.prepareTool(name, args);
        if (toolPlan.action === "reuse") {
          const reused = await recordDeduplicatedTool({
            name,
            args,
            callId: call.id,
            result: toolPlan.result,
            parentAgent: agentRun,
            depth: 3,
            agentName,
            recordRuntime
          });
          toolMessages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(reused) });
          continue;
        }
        const toolDeployment = await resolveToolDeployment({
          name,
          parentAgent: agentRun,
          depth: 3,
          recordRuntime
        });
        const toolStarted = performance.now();
        const toolResult = await startActiveObservation(name, async tool => {
          tool.update({ input: args, metadata: { original_tool_name: name } });
          recordRuntime(runtimeEvent(tool, {
            kind: "TOOL CALL", name, actor: toolActor(name, agentName),
            duration: "Running", depth: 3, parentId: runtimeId(agentRun), status: "running",
            summary: `${name} called with the model-provided arguments.`, input: args, output: null,
            metadata: { toolCallId: call.id, capability: name }
          }));
          try {
            const result = await executeCapability(name, args, {
              userId,
              sessionId,
              traceId,
              signal,
              requestId,
              dependencies,
              deploymentRoute: toolDeployment.route,
              deploymentConnection: toolDeployment.connection
            });
            if (name === SEARCH_TOOL_NAME) sourceCount += result.search_result.length;
            if (result.artifact) artifacts.push(result.artifact);
            harness.completeTool(toolPlan.signature, result);
            tool.update({ output: result, metadata: toolExecutionMetadata(name, result) });
            recordRuntime(runtimeEvent(tool, {
              kind: "TOOL CALL", name, actor: toolActor(name, agentName),
              duration: elapsed(toolStarted), depth: 3, parentId: runtimeId(agentRun),
              status: result.status === "error" ? "error" : "completed",
              summary: completedToolSummary(name, result),
              input: args, output: result,
              metadata: { toolCallId: call.id, capability: name, ...toolExecutionMetadata(name, result) }
            }));
            return result;
          } catch (error) {
            const result = { status: "error", error: error.message };
            harness.completeTool(toolPlan.signature, result);
            tool.update({ level: "ERROR", statusMessage: error.message, output: result });
            recordRuntime(runtimeEvent(tool, {
              kind: "TOOL CALL", name, actor: toolActor(name, agentName),
              duration: elapsed(toolStarted), depth: 3, parentId: runtimeId(agentRun), status: "error",
              summary: `${name} failed.`, input: args, output: result,
              metadata: { toolCallId: call.id, capability: name, errorCode: error.code || null }
            }));
            return result;
          }
        }, { asType: "tool", parentSpanContext: agentRun.otelSpan.spanContext() });
        toolMessages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(toolResult) });
      }
      messages.push(assistantToolMessage(step.completion), ...toolMessages);
    }
    if (!finalCompletion?.content) throw new Error(`${agentName} did not produce a final completion after tool execution`);
    const output = { role: "assistant", content: finalCompletion.content };
    agentRun.update({ output });
    recordRuntime(runtimeEvent(agentRun, {
      kind: "AGENT RUN", name: `agent_run [${agentName}]`, actor: agentName, duration: elapsed(started), depth: 2,
      parentId: runtimeId(parentAgent), status: "completed", summary: `${agentName} completed.`,
      input: { messages: traceMessages(initialMessages) }, output
    }));
    return { answer: finalCompletion.content, completion: finalCompletion, sourceCount, artifacts };
  }, { asType: "agent", parentSpanContext: parentAgent.otelSpan.spanContext() });
}

async function runDirectResponse({
  rootAgent,
  routingMessages,
  intent,
  requestedModelAlias,
  requiredModalities = [],
  parentAgent,
  recordRuntime,
  signal,
  requestId,
  harness,
  dependencies
}) {
  const directAgent = {
    ...rootAgent,
    systemPrompt: rootAgent.directResponsePrompt || rootAgent.systemPrompt,
    tools: []
  };
  const messages = [
    { role: "system", content: directAgent.systemPrompt },
    ...routingMessages.slice(1)
  ];
  const step = await runModelCall({
    agent: directAgent,
    agentName: agentWorkflow.rootAgentId,
    messages,
    parent: parentAgent,
    depth: 2,
    semanticRole: "direct-response",
    intent,
    requestedModelAlias,
    requiredModalities,
    recordRuntime,
    signal,
    requestId,
    dependencies,
    harness
  });
  if (!step.completion.content) throw new Error("Direct response model did not produce a visible answer");
  return step;
}

export async function runAgentTurn({
  prompt,
  sessionId,
  model: requestedModelId,
  history,
  userId,
  requestId,
  artifactNames = [],
  signal,
  onRuntimeEvent = null,
  dependencies: dependencyOverrides = {}
}) {
  const cleanPrompt = text(prompt);
  const cleanSessionId = text(sessionId, 200) || `copilot-${crypto.randomUUID()}`;
  const cleanUserId = text(userId, 200);
  if (!cleanUserId) throw new AppError("Authenticated user identity is required", { code: "unauthorized", status: 401, expose: true });
  const cleanRequestId = text(requestId, 200) || `req_${crypto.randomUUID()}`;
  const modelSelection = selectedModel(requestedModelId);
  const requestedModel = modelSelection.modelAlias;
  const conversation = safeHistory(history);
  const dependencies = runtimeDependencies(dependencyOverrides);
  const artifactCatalog = await Promise.resolve(dependencies.listArtifacts(cleanUserId, config.artifacts.listLimit));
  const requestedArtifactNames = (Array.isArray(artifactNames) ? artifactNames : []).map(value => text(value, 240)).filter(Boolean);
  const preparedAttachments = await Promise.resolve(dependencies.prepareModelAttachments({
    userId: cleanUserId,
    artifactNames: requestedArtifactNames
  }));
  if (preparedAttachments.missingArtifactNames?.length) {
    throw new AppError("一个或多个附件不存在", { code: "artifact_not_found", status: 404, expose: true });
  }
  const requiredInputModalities = preparedAttachments.requiredModalities || [];
  if (modelSelection.kind !== "selection-mode") {
    const unsupported = requiredInputModalities.filter(modality => !modelSelection.modalities.includes(modality));
    if (unsupported.length) {
      throw new AppError(`${modelSelection.displayName} 不支持所选附件的 ${unsupported.join(", ")} 输入`, {
        code: "model_modality_mismatch", status: 400, expose: true
      });
    }
  }
  const selectedArtifacts = preparedAttachments.artifacts || [];
  const attachmentParts = preparedAttachments.parts || [];
  const promptContext = { artifacts: artifactCatalog, newArtifacts: selectedArtifacts };
  const rootAgent = workflowAgent(agentWorkflow.rootAgentId, promptContext);
  const runtimeRecorder = createRuntimeRecorder({
    sessionId: cleanSessionId,
    requestId: cleanRequestId,
    onEvent: onRuntimeEvent
  });
  const harness = createHarnessController({
    maxToolCalls: config.agent.maxToolCallsPerTurn,
    maxNoProgressIterations: config.agent.maxNoProgressIterations,
    deadlineMs: config.agent.deadlineMs
  });
  const recordRuntime = runtimeRecorder.record;

  try {
    const result = await propagateAttributes({
      traceName: agentWorkflow.invocationName,
      userId: cleanUserId,
      sessionId: cleanSessionId,
      tags: ["agent-runtime", "multi-agent-chat"],
      metadata: {
        workflow_schema: agentWorkflow.schemaVersion,
        requested_model_id: modelSelection.id,
        requested_model_alias: requestedModel,
        attachment_count: String(selectedArtifacts.length),
        request_id: cleanRequestId
      },
      version: `agent-workflow@${agentWorkflow.workflowVersion}`,
      environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || "development"
    }, async () => startActiveObservation(agentWorkflow.invocationName, async invocation => {
      const started = performance.now();
      const traceId = usableTraceId(invocation.traceId);
      runtimeRecorder.setTraceId(traceId);
      const invocationInput = {
        user_id: cleanUserId,
        session_id: cleanSessionId,
        new_message: {
          parts: [{ text: cleanPrompt }, ...selectedArtifacts.map(item => ({
            artifact_id: item.artifact_id,
            file_name: item.file_name,
            mime_type: item.mime_type,
            size_bytes: item.size_bytes,
            sha256: item.metadata?.sha256 || null
          }))],
          role: "user"
        }
      };
      invocation.update({
        input: { role: "user", content: cleanPrompt, attachments: selectedArtifacts },
        metadata: { workflow_schema: agentWorkflow.schemaVersion, request_id: cleanRequestId, attachment_count: selectedArtifacts.length }
      });
      onRuntimeEvent?.({ type: "trace", traceId, sessionId: cleanSessionId, startedAt: new Date().toISOString() });
      recordRuntime(runtimeEvent(invocation, {
        kind: "CHAIN", name: agentWorkflow.invocationName, actor: "Agent Harness", duration: "Running", depth: 0,
        parentId: null, status: "running", summary: "Root agent invocation started.", input: invocationInput, output: null
      }));

      const rootAgentStarted = performance.now();
      const rootAgentRunName = `agent_run [${rootAgent.id}]`;
      const rootAgentResult = await startActiveObservation(rootAgentRunName, async rootAgentObservation => {
        const initialMessages = messagesFor(rootAgent, conversation, cleanPrompt, attachmentParts);
        rootAgentObservation.update({ input: initialMessages, metadata: { agent_id: rootAgent.id } });
        recordRuntime(runtimeEvent(rootAgentObservation, {
          kind: "AGENT RUN", name: rootAgentRunName, actor: rootAgent.id, duration: "Running", depth: 1,
          parentId: runtimeId(invocation), status: "running", summary: "Running the configured root orchestration agent.",
          input: { messages: traceMessages(initialMessages) }, output: null
        }));

        const messages = [...initialMessages];
        let finalAnswer = "";
        let finalCompletion = null;
        let specialist = null;
        let sourceCount = 0;
        let generatedArtifacts = [];
        let structuredRouting = null;
        for (let iteration = 0; iteration < config.agent.rootMaxIterations; iteration += 1) {
          const step = await runModelCall({
            agent: rootAgent,
            agentName: rootAgent.id,
            messages,
            parent: rootAgentObservation,
            depth: 2,
            semanticRole: "intent-routing",
            recordRuntime,
            signal,
            requestId: cleanRequestId,
            dependencies,
            harness,
            requiredModalities: requiredInputModalities
          });
          finalCompletion = step.completion;
          const proposedTransferCall = step.completion.toolCalls.find(call => call.function?.name === "transfer_to_agent") || null;
          const proposedTransferArgs = proposedTransferCall ? toolArguments(proposedTransferCall) : null;
          const proposedMode = proposedTransferCall
            ? "delegate"
            : step.completion.toolCalls.length
              ? "continue"
              : "direct";
          const intentDecision = routingSystem.intent.route({ prompt: cleanPrompt });
          const agentDecision = routingSystem.agent.route({
            intent: intentDecision,
            proposal: {
              mode: proposedMode,
              agentId: proposedTransferArgs ? text(proposedTransferArgs.agent_name, 120) : null
            }
          });
          await recordRoutingLayer({
            name: "classify-intent",
            semanticRole: "intent-routing-decision",
            actor: "Intent Router",
            input: { prompt: cleanPrompt },
            output: intentDecision,
            summary: intentDecision.ruleId
              ? `Classified ${intentDecision.taskType} using configured rule ${intentDecision.ruleId}.`
              : `Classified ${intentDecision.taskType} using the configured default.`,
            parentAgent: rootAgentObservation,
            depth: 2,
            recordRuntime
          });
          await recordRoutingLayer({
            name: "select-agent",
            semanticRole: "agent-routing",
            actor: "Agent Router",
            input: { intent: intentDecision, proposal: agentDecision.proposal },
            output: agentDecision,
            summary: agentDecision.decision.mode === "delegate"
              ? `Selected Agent ${agentDecision.decision.agentId}.`
              : `Selected ${agentDecision.decision.mode} execution.`,
            parentAgent: rootAgentObservation,
            depth: 2,
            recordRuntime
          });
          structuredRouting = {
            schemaVersion: "copilot-routing-decision.v1",
            intent: intentDecision,
            agent: agentDecision,
            rootModel: step.modelRoute,
            rootDeployment: step.deploymentRoute
          };
          const toolMessages = [];
          let transferTarget = agentDecision.decision.mode === "delegate" && !proposedTransferCall
            ? agentDecision.decision.agentId
            : null;
          for (const call of step.completion.toolCalls) {
            if (transferTarget) break;
            const name = call.function?.name || "unknown_tool";
            const args = toolArguments(call);
            const toolPlan = harness.prepareTool(name, args);
            if (toolPlan.action === "reuse") {
              const reused = await recordDeduplicatedTool({
                name,
                args,
                callId: call.id,
                result: toolPlan.result,
                parentAgent: rootAgentObservation,
                depth: 2,
                agentName: rootAgent.id,
                recordRuntime
              });
              toolMessages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(reused) });
              continue;
            }
            const toolDeployment = await resolveToolDeployment({
              name,
              parentAgent: rootAgentObservation,
              depth: 2,
              recordRuntime
            });
            const toolStarted = performance.now();
            const result = await startActiveObservation(name, async tool => {
              tool.update({ input: args });
              recordRuntime(runtimeEvent(tool, {
                kind: "TOOL CALL", name, actor: toolActor(name, rootAgent.id), duration: "Running", depth: 2,
                parentId: runtimeId(rootAgentObservation), status: "running", summary: `${name} called with model-provided arguments.`, input: args, output: null,
                metadata: { toolCallId: call.id, capability: name }
              }));
              if (name === "transfer_to_agent") {
                const routedArguments = agentDecision.decision.mode === "delegate"
                  ? { ...args, agent_name: agentDecision.decision.agentId }
                  : args;
                const validation = validateCapabilityArguments(name, routedArguments, { routableAgents: rootAgent.routableAgents });
                const target = validation.valid
                  ? text(validation.value.agent_name, 120)
                  : "";
                const targetAgent = target ? workflowAgent(target, promptContext) : null;
                if (!validation.valid || !targetAgent) {
                  const invalidTarget = {
                    status: "error",
                    error: validation.valid ? `Agent ${target} is not executable` : `Invalid transfer arguments: ${validation.errors.join("; ")}`,
                    available_agents: rootAgent.routableAgents
                  };
                  harness.completeTool(toolPlan.signature, invalidTarget);
                  tool.update({ level: "WARNING", statusMessage: invalidTarget.error, output: invalidTarget });
                  recordRuntime(runtimeEvent(tool, {
                    kind: "TOOL CALL", name, actor: rootAgent.id, duration: elapsed(toolStarted), depth: 2,
                    parentId: runtimeId(rootAgentObservation), status: "error", summary: invalidTarget.error, input: args, output: invalidTarget,
                    metadata: { toolCallId: call.id, capability: name }
                  }));
                  return invalidTarget;
                }
                transferTarget = targetAgent.name;
                harness.completeTool(toolPlan.signature, null);
                tool.update({ output: null, metadata: { delegated_agent: target, tool_result_intentionally_empty: true } });
                recordRuntime(runtimeEvent(tool, {
                  kind: "TOOL CALL", name, actor: rootAgent.id, duration: elapsed(toolStarted), depth: 2,
                  parentId: runtimeId(rootAgentObservation), status: "completed", summary: `Transferred control to ${target}.`, input: args, output: null,
                  metadata: { toolCallId: call.id, capability: name, delegatedAgent: target }
                }));
                return null;
              }
              try {
                const localResult = await executeCapability(name, args, {
                  userId: cleanUserId,
                  sessionId: cleanSessionId,
                  traceId,
                  signal,
                  requestId: cleanRequestId,
                  dependencies,
                  deploymentRoute: toolDeployment.route,
                  deploymentConnection: toolDeployment.connection
                });
                harness.completeTool(toolPlan.signature, localResult);
                tool.update({ output: localResult, metadata: toolExecutionMetadata(name, localResult) });
                recordRuntime(runtimeEvent(tool, {
                  kind: "TOOL CALL", name, actor: toolActor(name, rootAgent.id), duration: elapsed(toolStarted), depth: 2,
                  parentId: runtimeId(rootAgentObservation), status: localResult.status === "error" ? "error" : "completed",
                  summary: completedToolSummary(name, localResult), input: args, output: localResult,
                  metadata: { toolCallId: call.id, capability: name, ...toolExecutionMetadata(name, localResult) }
                }));
                return localResult;
              } catch (error) {
                const localResult = { status: "error", error: error.message };
                harness.completeTool(toolPlan.signature, localResult);
                tool.update({ level: "ERROR", statusMessage: error.message, output: localResult });
                recordRuntime(runtimeEvent(tool, {
                  kind: "TOOL CALL", name, actor: toolActor(name, rootAgent.id), duration: elapsed(toolStarted), depth: 2,
                  parentId: runtimeId(rootAgentObservation), status: "error", summary: `${name} failed.`, input: args, output: localResult,
                  metadata: { toolCallId: call.id, capability: name, errorCode: error.code || null }
                }));
                return localResult;
              }
            }, { asType: "tool", parentSpanContext: rootAgentObservation.otelSpan.spanContext() });
            toolMessages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(result) });
            if (transferTarget) break;
          }
          if (transferTarget) {
            const delegated = await runSpecialist({
              agentName: transferTarget,
              prompt: cleanPrompt,
              history: conversation,
              userId: cleanUserId,
              sessionId: cleanSessionId,
              traceId,
              promptContext,
              parentAgent: rootAgentObservation,
              recordRuntime,
              signal,
              requestId: cleanRequestId,
              harness,
              dependencies,
              intent: intentDecision,
              requestedModelAlias: requestedModel,
              requiredModalities: requiredInputModalities,
              attachmentParts
            });
            specialist = transferTarget;
            finalAnswer = delegated.answer;
            finalCompletion = delegated.completion;
            sourceCount = delegated.sourceCount;
            generatedArtifacts = delegated.artifacts;
            structuredRouting = {
              ...structuredRouting,
              specialistModel: delegated.completion?.routing?.model || null,
              specialistDeployment: delegated.completion?.routing?.deployment || null
            };
            break;
          }
          if (step.completion.content && !toolMessages.length && agentDecision.decision.mode === "direct") {
            const direct = await runDirectResponse({
              rootAgent,
              routingMessages: messages,
              intent: intentDecision,
              requestedModelAlias: requestedModel,
              requiredModalities: requiredInputModalities,
              parentAgent: rootAgentObservation,
              recordRuntime,
              signal,
              requestId: cleanRequestId,
              harness,
              dependencies
            });
            finalAnswer = direct.completion.content;
            finalCompletion = direct.completion;
            structuredRouting = {
              ...structuredRouting,
              directModel: direct.modelRoute,
              directDeployment: direct.deploymentRoute
            };
            break;
          }
          messages.push(assistantToolMessage(step.completion), ...toolMessages);
        }
        if (!finalAnswer) throw new Error("Personal Copilot did not produce a direct answer or transfer to an agent");
        const output = { role: "assistant", content: finalAnswer };
        rootAgentObservation.update({ output, metadata: { agent_id: rootAgent.id, delegated_agent: specialist } });
        recordRuntime(runtimeEvent(rootAgentObservation, {
          kind: "AGENT RUN", name: rootAgentRunName, actor: rootAgent.id, duration: elapsed(rootAgentStarted), depth: 1,
          parentId: runtimeId(invocation), status: "completed", summary: specialist ? `Personal Copilot delegated to ${specialist}.` : "Personal Copilot answered directly.",
          input: { messages: traceMessages(initialMessages) }, output
        }));
        return {
          answer: finalAnswer,
          specialist,
          completion: finalCompletion,
          sourceCount,
          artifacts: generatedArtifacts,
          routing: structuredRouting
        };
      }, { asType: "agent" });

      const output = { role: "assistant", content: rootAgentResult.answer };
      const capturedMemory = await captureLongTermMemory({
        dependencies,
        userId: cleanUserId,
        sessionId: cleanSessionId,
        traceId,
        requestId: cleanRequestId,
        userMessage: cleanPrompt,
        assistantResponse: rootAgentResult.answer,
        specialist: rootAgentResult.specialist,
        completion: rootAgentResult.completion,
        artifacts: [...selectedArtifacts, ...rootAgentResult.artifacts],
        invocation,
        recordRuntime
      });
      invocation.update({
        output,
        metadata: {
          workflow_schema: agentWorkflow.schemaVersion,
          memory_capture: capturedMemory?.memory_id || null,
          memory_capture_action: capturedMemory?.action || null,
          memory_capture_reason: capturedMemory?.reason || null,
          harness: harness.status(),
          routing_schema: rootAgentResult.routing?.schemaVersion || null
        }
      });
      recordRuntime(runtimeEvent(invocation, {
        kind: "CHAIN", name: agentWorkflow.invocationName, actor: "Agent Harness", duration: elapsed(started), depth: 0,
        parentId: null, status: "completed", summary: "Root invocation completed.", input: invocationInput, output
      }));
      return {
        answer: rootAgentResult.answer,
        traceId,
        sessionId: cleanSessionId,
        specialist: rootAgentResult.specialist || rootAgent.id,
        intent: rootAgentResult.routing?.intent || null,
        routing: rootAgentResult.routing,
        model: modelSelection.id,
        modelDisplayName: modelSelection.displayName,
        modelAlias: requestedModel,
        resolvedModel: rootAgentResult.completion?.model || null,
        intentionModel: rootAgentResult.routing?.rootDeployment?.model || null,
        requestId: cleanRequestId,
        runtime: runtimeRecorder.snapshot(),
        harness: harness.status(),
        memory: capturedMemory,
        inputArtifacts: selectedArtifacts,
        artifacts: rootAgentResult.artifacts,
        tool: rootAgentResult.artifacts.length
          ? {
              title: "Generated document",
              detail: rootAgentResult.artifacts.map(item => item.file_name).join(", "),
              artifacts: rootAgentResult.artifacts
            }
          : rootAgentResult.sourceCount
            ? { title: "Searched the web", detail: `Tavily-compatible Search · ${rootAgentResult.sourceCount} live results`, sources: rootAgentResult.sourceCount }
            : null
      };
    }, { asType: "chain" }));
    return result;
  } catch (error) {
    throw error;
  }
}
