import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ignoredDirectories = new Set([".git", ".data", "node_modules", "coverage", "results"]);
const ignoredFiles = new Set([".env", ".DS_Store"]);
const textExtensions = new Set([
  "", ".css", ".env", ".html", ".js", ".json", ".jsonl", ".md", ".mjs", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml"
]);
const credentialKey = /(?:api[_-]?key|access[_-]?key|secret|token|password|credential)/iu;
const safeMarker = /(?:example|placeholder|replace|dummy|fake|test|redacted|masked|not-configured|your-|<[^>]+>|\$\{)/iu;

const credentialPatterns = [
  { type: "private-key", expression: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/gu },
  { type: "aws-access-key", expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
  { type: "github-token", expression: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/gu },
  { type: "slack-token", expression: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu },
  { type: "langfuse-key", expression: /\b(?:sk|pk)-lf-[A-Za-z0-9-]{16,}\b/gu },
  { type: "api-secret", expression: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
  { type: "bearer-token", expression: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}\b/gu },
  {
    type: "credential-assignment",
    expression: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|password)\b\s*[:=]\s*["']([^"'\r\n]{12,})["']/giu,
    valueGroup: 1
  },
  {
    type: "environment-credential",
    expression: /^(?:[A-Z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_TOKEN|PASSWORD)[A-Z0-9_]*)=([^\s#]{12,})$/gmu,
    valueGroup: 1
  }
];

function publicationFiles(directory = projectRoot) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    const path = relative(projectRoot, absolute);
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name) || path === "evals/results") continue;
      files.push(...publicationFiles(absolute));
      continue;
    }
    if (ignoredFiles.has(entry.name) || (entry.name.startsWith(".env.") && entry.name !== ".env.example")) continue;
    if (textExtensions.has(extname(entry.name).toLowerCase()) || entry.name === ".gitignore") files.push(absolute);
  }
  return files;
}

function normalizedSecret(value) {
  return String(value || "").trim().replace(/^(["'])(.*)\1$/u, "$2");
}

function collectKnownLocalSecrets() {
  const secrets = [];
  const envPath = resolve(projectRoot, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
      if (!match || !credentialKey.test(match[1])) continue;
      const value = normalizedSecret(match[2]);
      if (value.length >= 10 && !safeMarker.test(value)) secrets.push({ type: `local:${match[1]}`, value });
    }
  }

  const runtimePath = resolve(projectRoot, ".data/runtime-settings.json");
  if (existsSync(runtimePath)) {
    try {
      const visit = (value, path = []) => {
        if (!value || typeof value !== "object") return;
        for (const [key, item] of Object.entries(value)) {
          const nextPath = [...path, key];
          if (typeof item === "string" && credentialKey.test(key) && item.length >= 10 && !safeMarker.test(item)) {
            secrets.push({ type: `runtime:${nextPath.join(".")}`, value: item });
          } else visit(item, nextPath);
        }
      };
      visit(JSON.parse(readFileSync(runtimePath, "utf8")));
    } catch {
      console.error("运行配置不是有效 JSON，无法完成凭证交叉检查。");
      process.exitCode = 1;
    }
  }
  return secrets;
}

function lineNumber(content, index) {
  return content.slice(0, index).split(/\r?\n/u).length;
}

const findings = [];
const files = publicationFiles();
const knownLocalSecrets = collectKnownLocalSecrets();
for (const absolute of files) {
  let content;
  try {
    content = readFileSync(absolute, "utf8");
  } catch {
    continue;
  }
  const path = relative(projectRoot, absolute);

  for (const secret of knownLocalSecrets) {
    const index = content.indexOf(secret.value);
    if (index >= 0) findings.push({ path, line: lineNumber(content, index), type: secret.type });
  }

  for (const pattern of credentialPatterns) {
    pattern.expression.lastIndex = 0;
    for (const match of content.matchAll(pattern.expression)) {
      const value = match[pattern.valueGroup || 0];
      if (safeMarker.test(value)) continue;
      findings.push({ path, line: lineNumber(content, match.index), type: pattern.type });
    }
  }
}

const uniqueFindings = [...new Map(findings.map(item => [`${item.path}:${item.line}:${item.type}`, item])).values()];
if (uniqueFindings.length) {
  console.error("发现疑似凭证；仅输出位置和类型，不输出原始内容：");
  for (const finding of uniqueFindings) console.error(`- ${finding.path}:${finding.line} [${finding.type}]`);
  process.exit(1);
}

if (!process.exitCode) console.log(`凭证扫描通过：${files.length} 个待发布文本文件未发现疑似真实密钥。`);
