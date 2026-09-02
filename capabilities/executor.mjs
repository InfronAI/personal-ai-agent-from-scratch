import { createArtifact, loadArtifacts } from "../artifacts/artifact-store.mjs";
import { AppError } from "../errors.mjs";
import { loadMemory } from "../memory-store.mjs";
import { renderDocx, renderPdf } from "../documents/generator.mjs";
import { searchWithTavily } from "../web-search.mjs";
import { capabilitySpec, validateCapabilityArguments } from "./registry.mjs";

const defaultAdapters = Object.freeze({
  searchWithTavily,
  loadMemory,
  loadArtifacts,
  createArtifact,
  renderPdf,
  renderDocx
});

function dependencies(overrides = {}) {
  return { ...defaultAdapters, ...overrides };
}

function assertActive(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
}

async function executeSearch(args, context, adapters) {
  const result = await adapters.searchWithTavily(args.query.trim(), {
    maxResults: 5,
    signal: context.signal,
    requestId: context.requestId,
    country: args.country || null,
    language: args.language || null,
    connection: context.deploymentConnection || null
  });
  return {
    status: "success",
    search_result: result.results.map(item => ({ title: item.title, snippet: item.content, link: item.url, score: item.score })),
    image_result: [],
    answer: result.answer || null,
    provider: result.provider || "tavily-compatible",
    provider_request_id: result.requestId || null,
    deployment_profile_id: context.deploymentRoute?.profileId || null
  };
}

async function executeDocument(name, args, context, adapters) {
  const format = name === "generate_pdf" ? "pdf" : "docx";
  const rendered = format === "pdf"
    ? await adapters.renderPdf({ title: args.title, markdown: args.markdown_content })
    : await adapters.renderDocx({ title: args.title, markdown: args.markdown_content });
  assertActive(context.signal);
  const artifact = adapters.createArtifact({
    userId: context.userId,
    sessionId: context.sessionId,
    traceId: context.traceId || null,
    title: args.title,
    kind: "generated_document",
    mimeType: format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: format,
    buffer: rendered.buffer,
    contentText: rendered.markdown,
    metadata: {
      generator: name,
      generator_version: "1.0.0",
      source_format: "markdown",
      parsed_blocks: rendered.blocks
    }
  });
  return { status: "success", format, artifact };
}

export async function executeCapability(name, args, context = {}) {
  const spec = capabilitySpec(name);
  if (!spec) throw new AppError(`Unknown workflow capability ${name}`, { code: "unknown_tool", status: 422, expose: true });
  if (spec.execution.adapter === "orchestrator") {
    throw new AppError(`${name} must be executed by the orchestration controller`, { code: "invalid_tool_dispatch", status: 500 });
  }
  const validation = validateCapabilityArguments(name, args, { routableAgents: context.routableAgents || [] });
  if (!validation.valid) {
    throw new AppError(`Invalid arguments for ${name}: ${validation.errors.join("; ")}`, {
      code: "invalid_tool_arguments",
      status: 400,
      expose: true,
      details: { capability: name, errors: validation.errors }
    });
  }
  assertActive(context.signal);
  const adapters = dependencies(context.dependencies);
  if (spec.execution.adapter === "search") return executeSearch(validation.value, context, adapters);
  if (spec.execution.adapter === "memory") {
    return adapters.loadMemory({
      userId: context.userId,
      sessionId: context.sessionId,
      query: validation.value.query,
      limit: 5
    });
  }
  if (spec.execution.adapter === "artifact") {
    return adapters.loadArtifacts({ userId: context.userId, artifactNames: validation.value.artifact_names });
  }
  if (spec.execution.adapter === "document") return executeDocument(name, validation.value, context, adapters);
  throw new AppError(`Capability ${name} has no executor adapter`, { code: "tool_not_executable", status: 500 });
}

export function executorStatus() {
  return {
    version: "copilot-capability-executor.v1",
    adapters: [...new Set(["search", "memory", "artifact", "document", "orchestrator"])]
  };
}
