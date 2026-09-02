function includes(values, value) {
  return !Array.isArray(values) || values.length === 0 || values.includes(value);
}

function overlaps(values, candidates) {
  return !Array.isArray(values) || values.length === 0 || candidates.some(value => values.includes(value));
}

export function orderedRules(rules) {
  return [...rules].filter(rule => rule.enabled !== false).sort((left, right) => (right.priority || 0) - (left.priority || 0));
}

export function matchesConditions(when = {}, context = {}) {
  return includes(when.roles, context.role)
    && overlaps(when.intentRuleIds, context.intent?.matchedRuleIds || [context.intent?.ruleId])
    && includes(when.domains, context.intent?.domain)
    && includes(when.taskTypes, context.intent?.taskType)
    && includes(when.riskLevels, context.intent?.risk?.level)
    && includes(when.agentIds, context.agentId)
    && includes(when.workloads, context.workload);
}
