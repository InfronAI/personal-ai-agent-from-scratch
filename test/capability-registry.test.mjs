import assert from "node:assert/strict";
import test from "node:test";

import * as capabilityProtocol from "../capabilities/registry.mjs";
import {
  capabilityNames,
  capabilityRegistryVersion,
  capabilitySpec,
  capabilityTool,
  validateCapabilityArguments
} from "../capabilities/registry.mjs";
import { workflowAgent } from "../workflow.mjs";

test("能力注册表覆盖所有工作流工具且参数协议严格", () => {
  assert.equal(capabilityRegistryVersion, "copilot-capabilities.v2");
  assert.equal(Object.hasOwn(capabilityProtocol, "capabilityRegistry"), false, "不得向调用方暴露可变 Map");
  assert.equal(Object.isFrozen(capabilitySpec("load_memory")), true);
  const advertised = new Set();
  for (const name of [
    "copilot",
    "medical_assistant",
    "teaching_assistant",
    "software_development_assistant",
    "analyst",
    "research_assistant",
    "document_generator_assistant"
  ]) {
    for (const tool of workflowAgent(name).tools) advertised.add(tool.function.name);
  }
  assert.deepEqual([...advertised].sort(), [...capabilityNames].sort());

  const invalid = validateCapabilityArguments("generate_pdf", {
    title: "报告",
    markdown_content: "# 报告",
    file_stem: "legacy"
  });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(" "), /file_stem/);
});

test("路由工具只能选择已注册的可达 Agent", () => {
  const routableAgents = ["analyst", "research_assistant"];
  const tool = capabilityTool("transfer_to_agent", { routableAgents });
  assert.deepEqual(tool.function.parameters.properties.agent_name.enum, routableAgents);
  assert.equal(validateCapabilityArguments("transfer_to_agent", { agent_name: "Stalker" }, { routableAgents }).valid, false);
  assert.equal(validateCapabilityArguments("transfer_to_agent", { agent_name: "analyst" }, { routableAgents }).valid, true);
});
