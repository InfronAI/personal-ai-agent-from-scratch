import { orderedRules } from "./match.mjs";

function detectLanguage(prompt) {
  return /[\p{Script=Han}]/u.test(prompt) ? "zh-CN" : "en";
}

function detectFormat(prompt, patterns) {
  return (patterns || []).find(item => new RegExp(item.pattern, "iu").test(prompt))?.format || null;
}

const riskRank = Object.freeze({ low: 0, medium: 1, high: 2 });

function aggregateRisk(matched, fallback) {
  const risks = matched.map(rule => rule.output?.risk).filter(Boolean);
  if (!risks.length) return { ...fallback };
  const selected = [...risks].sort((left, right) => (riskRank[right.level] ?? -1) - (riskRank[left.level] ?? -1))[0];
  return {
    level: selected.level,
    reason: selected.reason,
    reasons: [...new Set(risks.map(item => item.reason).filter(Boolean))]
  };
}

export function createIntentRouter(configuration) {
  const rules = orderedRules(configuration.rules).map(rule => ({ ...rule, matcher: new RegExp(rule.match.pattern, "iu") }));
  return Object.freeze({
    version: configuration.version,
    route({ prompt }) {
      const value = String(prompt || "").trim();
      const matched = rules.filter(rule => rule.matcher.test(value));
      const primary = matched[0] || null;
      const output = structuredClone(primary?.output || configuration.defaultOutput);
      const requiredCapabilities = [...new Set((matched.length ? matched : [{ output }])
        .flatMap(rule => rule.output?.requiredCapabilities || []))];
      return Object.freeze({
        schemaVersion: "copilot-intent-decision.v1",
        routerVersion: configuration.version,
        ruleId: primary?.id || null,
        matchedRuleIds: Object.freeze(matched.map(rule => rule.id)),
        domain: output.domain,
        taskType: output.taskType,
        risk: Object.freeze(aggregateRisk(matched, output.risk || { level: "low", reason: "default" })),
        constraints: Object.freeze({
          language: detectLanguage(value),
          requestedFormat: detectFormat(value, configuration.formatPatterns),
          requiresFreshData: matched.length
            ? matched.some(rule => Boolean(rule.output?.requiresFreshData))
            : Boolean(output.requiresFreshData)
        }),
        requiredCapabilities: Object.freeze(requiredCapabilities),
        evidence: Object.freeze({
          source: primary ? "configured-rule" : "configured-default",
          primaryRule: primary?.id || null,
          matchedRules: Object.freeze(matched.map(rule => rule.id))
        })
      });
    }
  });
}
