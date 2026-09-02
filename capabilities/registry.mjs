const VERSION = "copilot-capabilities.v2";

function objectSchema(properties, required = []) {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: Object.freeze(properties),
    required: Object.freeze(required)
  });
}

const definitions = {
  transfer_to_agent: {
    description: "Delegate the current request to one approved Personal Copilot specialist.",
    parameters: objectSchema({
      agent_name: Object.freeze({ type: "string", minLength: 1 })
    }, ["agent_name"]),
    execution: { adapter: "orchestrator", sideEffect: "none", idempotent: true, timeoutMs: 0 },
    trace: { resultMode: "handoff", redact: [] }
  },
  load_memory: {
    description: "Load relevant active memories for the current authenticated user.",
    parameters: objectSchema({
      query: Object.freeze({ type: "string", minLength: 1, maxLength: 2000 })
    }, ["query"]),
    execution: { adapter: "memory", sideEffect: "read", idempotent: true, timeoutMs: 1000 },
    trace: { resultMode: "structured", redact: ["memories.*.metadata.private"] }
  },
  TavilySearchTool: {
    description: "Search the live web through the configured Tavily-compatible deployment and return normalized textual evidence. Use for current, changing, niche, or explicitly sourced information.",
    parameters: objectSchema({
      query: Object.freeze({ type: "string", minLength: 1, maxLength: 2000 }),
      country: Object.freeze({ type: "string", minLength: 2, maxLength: 8 }),
      language: Object.freeze({ type: "string", minLength: 2, maxLength: 16 })
    }, ["query"]),
    execution: { adapter: "search", sideEffect: "read", idempotent: true, timeoutMs: 20_000 },
    trace: { resultMode: "structured", redact: [] }
  },
  load_artifacts: {
    description: "Load selected user-owned artifacts for content inspection. At least one exact artifact name or id is required.",
    parameters: objectSchema({
      artifact_names: Object.freeze({
        type: "array",
        minItems: 1,
        maxItems: 10,
        uniqueItems: true,
        items: Object.freeze({ type: "string", minLength: 1, maxLength: 240 })
      })
    }, ["artifact_names"]),
    execution: { adapter: "artifact", sideEffect: "read", idempotent: true, timeoutMs: 2000 },
    trace: { resultMode: "structured", redact: ["artifacts.*.content"] }
  },
  generate_pdf: {
    description: "Generate one downloadable PDF from complete Markdown content. Use for document requests unless the user explicitly asks for DOCX/Word.",
    parameters: objectSchema({
      markdown_content: Object.freeze({ type: "string", minLength: 1, maxLength: 120_000 }),
      title: Object.freeze({ type: "string", minLength: 1, maxLength: 200 })
    }, ["markdown_content", "title"]),
    execution: { adapter: "document", sideEffect: "create_artifact", idempotent: false, timeoutMs: 20_000 },
    trace: { resultMode: "artifact", redact: ["markdown_content"] }
  },
  generate_docx: {
    description: "Generate one downloadable DOCX from complete Markdown content. Use only when the user explicitly asks for Word, DOCX, or an editable document.",
    parameters: objectSchema({
      markdown_content: Object.freeze({ type: "string", minLength: 1, maxLength: 120_000 }),
      title: Object.freeze({ type: "string", minLength: 1, maxLength: 200 })
    }, ["markdown_content", "title"]),
    execution: { adapter: "document", sideEffect: "create_artifact", idempotent: false, timeoutMs: 20_000 },
    trace: { resultMode: "artifact", redact: ["markdown_content"] }
  }
};

function freezeDefinition(name, value) {
  return Object.freeze({
    name,
    version: name === "TavilySearchTool" ? "2.0.0" : "1.0.0",
    description: value.description,
    parameters: value.parameters,
    execution: Object.freeze(value.execution),
    trace: Object.freeze(value.trace)
  });
}

// Map 仅在协议模块内部可变，避免调用方绕过版本与校验流程修改能力事实源。
const capabilitiesByName = new Map(Object.entries(definitions).map(([name, value]) => [name, freezeDefinition(name, value)]));

export const capabilityRegistryVersion = VERSION;
export const capabilityNames = Object.freeze([...capabilitiesByName.keys()]);

export function capabilitySpec(name) {
  return capabilitiesByName.get(String(name || "")) || null;
}

export function capabilityTool(name, { routableAgents = [] } = {}) {
  const spec = capabilitySpec(name);
  if (!spec) throw new Error(`Unknown Personal Copilot capability ${name}`);
  const parameters = structuredClone(spec.parameters);
  if (name === "transfer_to_agent") {
    if (!routableAgents.length) throw new Error("transfer_to_agent requires at least one routable agent");
    parameters.properties.agent_name.enum = [...routableAgents];
  }
  return Object.freeze({
    type: "function",
    function: Object.freeze({
      name: spec.name,
      description: spec.description,
      parameters: Object.freeze(parameters)
    })
  });
}

function matchesType(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

function validateValue(value, schema, path, errors) {
  if (!matchesType(value, schema.type)) {
    errors.push(`${path} must be ${schema.type}`);
    return;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} exceeds ${schema.maxLength} characters`);
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} requires at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} allows at most ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) errors.push(`${path} items must be unique`);
    value.forEach((item, index) => validateValue(item, schema.items || {}, `${path}[${index}]`, errors));
  }
}

export function validateCapabilityArguments(name, args, { routableAgents = [] } = {}) {
  const tool = capabilityTool(name, { routableAgents });
  const schema = tool.function.parameters;
  const value = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const errors = [];
  for (const required of schema.required || []) {
    if (!(required in value) || value[required] === null || value[required] === undefined) errors.push(`${required} is required`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) if (!(key in schema.properties)) errors.push(`${key} is not allowed`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (schema.properties[key]) validateValue(item, schema.properties[key], key, errors);
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors), value: Object.freeze({ ...value }) });
}

export function validateAgentCapabilityNames(agentTemplates) {
  const errors = [];
  for (const agent of agentTemplates) {
    const names = Array.isArray(agent.capabilities) ? agent.capabilities : [];
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    const agentId = agent.id || agent.name || "unknown_agent";
    for (const duplicate of new Set(duplicates)) errors.push(`${agentId} declares ${duplicate} more than once`);
    for (const name of names) if (!capabilitySpec(name)) errors.push(`${agentId} declares unknown capability ${name}`);
  }
  return errors;
}

export function capabilityStatus() {
  return {
    version: capabilityRegistryVersion,
    capabilities: capabilityNames.map(name => {
      const spec = capabilitySpec(name);
      return {
        name,
        version: spec.version,
        adapter: spec.execution.adapter,
        sideEffect: spec.execution.sideEffect,
        idempotent: spec.execution.idempotent,
        timeoutMs: spec.execution.timeoutMs
      };
    })
  };
}
