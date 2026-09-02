import { matchesConditions, orderedRules } from "./match.mjs";

function agentIds(agents) {
  return new Set((agents || []).filter(agent => agent.routable !== false).map(agent => agent.id));
}

export function createAgentRouter(configuration, agents) {
  const available = agentIds(agents);
  const rules = orderedRules(configuration.rules);
  for (const rule of rules) {
    if (!available.has(rule.targetAgentId)) throw new Error(`Agent 路由规则 ${rule.id} 引用了未注册 Agent ${rule.targetAgentId}`);
  }
  return Object.freeze({
    version: configuration.version,
    route({ intent, proposal = {} }) {
      const proposedMode = ["direct", "delegate", "continue"].includes(proposal.mode) ? proposal.mode : "direct";
      const proposalValid = proposedMode !== "delegate" || available.has(proposal.agentId);
      const matched = rules.find(rule => matchesConditions(rule.when, { intent })) || null;
      let mode = proposalValid ? proposedMode : configuration.invalidProposalFallback || "direct";
      let selectedAgentId = mode === "delegate" ? proposal.agentId : null;
      let action = proposalValid ? "allow" : "reject";
      let reasonCode = proposalValid ? "model-proposal-allowed" : "unknown-agent";

      if (matched?.enforcement === "required" && (mode !== "delegate" || selectedAgentId !== matched.targetAgentId)) {
        mode = "delegate";
        selectedAgentId = matched.targetAgentId;
        action = "override";
        reasonCode = matched.id;
      } else if (matched?.enforcement === "preferred" && proposedMode === "delegate" && proposalValid && selectedAgentId === matched.targetAgentId) {
        action = "confirm";
        reasonCode = matched.id;
      }

      return Object.freeze({
        schemaVersion: "copilot-agent-route.v1",
        routerVersion: configuration.version,
        proposal: Object.freeze({ mode: proposedMode, agentId: proposal.agentId || null, valid: proposalValid }),
        decision: Object.freeze({ mode, agentId: mode === "delegate" ? selectedAgentId : null }),
        policy: Object.freeze({
          action,
          reasonCode,
          ruleId: matched?.id || null,
          enforcement: matched?.enforcement || null,
          recommendedAgentId: matched?.targetAgentId || null
        }),
        availableAgentIds: Object.freeze([...available])
      });
    }
  });
}
