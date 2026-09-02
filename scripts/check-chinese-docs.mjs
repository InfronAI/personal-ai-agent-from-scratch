import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const markdownRoots = [
  resolve(root, "AGENTS.md"),
  resolve(root, "README.md"),
  resolve(root, "README.en.md"),
  resolve(root, "docs"),
  resolve(root, "evals/README.md"),
  resolve(root, "evals/baselines/current.md")
];
const englishMarkdownPaths = new Set([resolve(root, "README.en.md")]);
const sourceRoots = [root];
const sourceExtensions = new Set([".js", ".mjs", ".css", ".html"]);
const namingExtensions = new Set([".js", ".mjs", ".css", ".html", ".md", ".json", ".jsonl"]);
const forbiddenBrandNames = [["inf", "ron"], ["no", "va"], ["hub", "x"]].map(parts => parts.join(""));

function filesUnder(path, predicate) {
  const stat = readdirSafe(path);
  if (stat === null) return predicate(path) ? [path] : [];
  return stat.flatMap(entry => {
    if (["node_modules", ".data", "results"].includes(entry)) return [];
    return filesUnder(join(path, entry), predicate);
  });
}

function readdirSafe(path) {
  try { return readdirSync(path); }
  catch (error) {
    if (error.code === "ENOTDIR") return null;
    throw error;
  }
}

function englishWordCount(value) {
  return (value.match(/\b[A-Za-z][A-Za-z'-]{2,}\b/gu) || []).length;
}

function isEnglishParagraph(value) {
  const plain = value
    .replace(/`[^`]*`/gu, "")
    .replace(/\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/https?:\/\/\S+/gu, "")
    .replace(/[#>*_~-]/gu, " ")
    .trim();
  return !/[\p{Script=Han}]/u.test(plain) && englishWordCount(plain) >= 4;
}

function checkMarkdown(path) {
  if (englishMarkdownPaths.has(path)) return [];
  const failures = [];
  let inFence = false;
  const lines = readFileSync(path, "utf8").split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (line.trim() === "# Personal AI Agent from Scratch") return;
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence || /^\s*\|/u.test(line) || /^\s*[-:]+\s*$/u.test(line)) return;
    if (isEnglishParagraph(line)) failures.push({ path, line: index + 1, value: line.trim() });
  });
  return failures;
}

function checkMarkdownLinks(path) {
  const failures = [];
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
    const target = match[1].trim().replace(/^<|>$/gu, "").split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:)/u.test(target)) continue;
    let decoded;
    try { decoded = decodeURIComponent(target); }
    catch { decoded = target; }
    const absolute = resolve(dirname(path), decoded);
    if (!existsSync(absolute)) failures.push({ path, line: null, value: `链接目标不存在：${target}` });
  }
  return failures;
}

function commentBodies(source, extension) {
  const values = [];
  if (extension === ".html") {
    for (const match of source.matchAll(/<!--([\s\S]*?)-->/gu)) values.push(match[1]);
    return values;
  }
  for (const match of source.matchAll(/\/\*([\s\S]*?)\*\//gu)) values.push(match[1]);
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^\s*\/\/\s*(.+)$/u);
    if (match) values.push(match[1]);
  }
  return values;
}

function checkComments(path) {
  const extension = extname(path);
  const source = readFileSync(path, "utf8");
  return commentBodies(source, extension)
    .filter(isEnglishParagraph)
    .map(value => ({ path, line: null, value: value.trim().replace(/\s+/gu, " ").slice(0, 180) }));
}

function checkGenericNaming() {
  const candidates = filesUnder(root, path => {
    if (path.endsWith("package-lock.json")) return false;
    if (path === fileURLToPath(import.meta.url)) return false;
    return namingExtensions.has(extname(path));
  });
  const pattern = new RegExp(`\\b(?:${forbiddenBrandNames.join("|")})\\b`, "giu");
  return candidates.flatMap(path => {
    const source = readFileSync(path, "utf8");
    const match = pattern.exec(source);
    pattern.lastIndex = 0;
    if (!match) return [];
    const line = source.slice(0, match.index).split(/\r?\n/u).length;
    return [{ path, line, value: `发现不应进入通用产品源码的品牌词：${match[0]}` }];
  });
}

function nonEmptyJsonLines(path) {
  return readFileSync(path, "utf8").split(/\r?\n/u).filter(line => line.trim());
}

function checkDerivedFacts() {
  const failures = [];
  const evaluationDocumentPath = resolve(root, "docs/EVALUATION.md");
  const evalReadmePath = resolve(root, "evals/README.md");
  const evaluationDocument = readFileSync(evaluationDocumentPath, "utf8");
  const evalReadme = readFileSync(evalReadmePath, "utf8");
  const evaluationConfiguration = JSON.parse(readFileSync(resolve(root, "evals/eval.config.json"), "utf8"));
  const datasets = Object.entries(evaluationConfiguration.datasets).map(([id, descriptor]) => {
    const path = `evals/${descriptor.file}`;
    return { id, path, descriptor, count: nonEmptyJsonLines(resolve(root, path)).length };
  });
  const datasetCount = datasets.reduce((sum, dataset) => sum + dataset.count, 0);

  if (!evaluationDocument.includes(`固定数据集共 ${datasetCount} 个场景，分布于 ${datasets.length} 个版本化数据集`)) {
    failures.push({ path: evaluationDocumentPath, line: null, value: `固定数据集总数应为 ${datasetCount}` });
  }
  for (const dataset of datasets) {
    if (!evaluationDocument.includes(`| \`${dataset.path}\` | ${dataset.count} |`)) {
      failures.push({ path: evaluationDocumentPath, line: null, value: `${dataset.path} 的场景数应为 ${dataset.count}` });
    }
  }
  const evalSummary = `当前固定 Dataset 共 ${datasetCount} 个场景，分布于 ${datasets.length} 个版本化数据集`;
  if (!evalReadme.includes(evalSummary)) {
    failures.push({ path: evalReadmePath, line: null, value: `Dataset 摘要应包含“${evalSummary}”` });
  }

  const catalogPath = resolve(root, "config/model-catalog.config.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const explicitModelCount = catalog.models.filter(model => model.kind === "answer-model").length;
  const modelCatalogStatements = [
    ["README.md", `Auto\` 与 ${explicitModelCount} 个显式`],
    ["README.en.md", `\`Auto\` and ${explicitModelCount} explicit answer models`],
    ["docs/PRODUCT.md", `Auto\` 与 ${explicitModelCount} 个显式`]
  ];
  for (const [relativePath, expectedStatement] of modelCatalogStatements) {
    const path = resolve(root, relativePath);
    if (!readFileSync(path, "utf8").includes(expectedStatement)) {
      failures.push({ path, line: null, value: `模型目录说明应包含 Auto 与 ${explicitModelCount} 个显式模型` });
    }
  }

  const routing = JSON.parse(readFileSync(resolve(root, "config/routing.config.json"), "utf8"));
  const intentionModel = routing.deploymentRouting.profiles["llm-primary"].modelAliases["intention-fast"];
  for (const relativePath of ["README.md", "README.en.md", "docs/TECHNICAL_DESIGN.md", "docs/ENGINEERING.md", "docs/DECISIONS.md"]) {
    const path = resolve(root, relativePath);
    if (!readFileSync(path, "utf8").includes(intentionModel)) {
      failures.push({ path, line: null, value: `应说明当前默认 Intention 模型 ${intentionModel}` });
    }
  }

  const environmentPath = resolve(root, ".env.example");
  const environment = readFileSync(environmentPath, "utf8");
  const requiredEnvironmentVariables = [
    "COPILOT_ALLOW_WEB_CONFIGURATION",
    "COPILOT_RUNTIME_CONFIG_PATH",
    "COPILOT_MEMORY_RETENTION_DAYS",
    "COPILOT_MEMORY_PROFILE_RETENTION_DAYS",
    "COPILOT_MAX_ARTIFACT_BYTES",
    "COPILOT_MAX_TURN_ATTACHMENT_BYTES",
    "LLM_GATEWAY_INTENTION_MODEL",
    "WEB_SEARCH_API_KEY",
    "WEB_SEARCH_BASE_URL"
  ];
  for (const variable of requiredEnvironmentVariables) {
    if (!new RegExp(`^${variable}=`, "mu").test(environment)) {
      failures.push({ path: environmentPath, line: null, value: `缺少 ${variable} 示例` });
    }
  }
  if (!environment.includes(`LLM_GATEWAY_INTENTION_MODEL=${intentionModel}`)) {
    failures.push({ path: environmentPath, line: null, value: `Intention 模型示例应与 Deployment 映射 ${intentionModel} 一致` });
  }

  return failures;
}

const markdownFiles = [...new Set(markdownRoots.flatMap(path => filesUnder(path, candidate => extname(candidate) === ".md")))];
const sourceFiles = [...new Set(sourceRoots.flatMap(path => filesUnder(path, candidate => sourceExtensions.has(extname(candidate)))))];
const failures = [
  ...markdownFiles.flatMap(checkMarkdown),
  ...markdownFiles.flatMap(checkMarkdownLinks),
  ...sourceFiles.flatMap(checkComments),
  ...checkGenericNaming(),
  ...checkDerivedFacts()
];

for (const line of readFileSync(resolve(root, ".env.example"), "utf8").split(/\r?\n/u)) {
  if (line.startsWith("#") && !/^#\s*[A-Z][A-Z0-9_]*=/u.test(line) && isEnglishParagraph(line.slice(1))) {
    failures.push({ path: resolve(root, ".env.example"), line: null, value: line });
  }
}

if (failures.length) {
  process.stderr.write("发现中文文档、代码注释或文档链接问题：\n");
  for (const failure of failures) {
    const location = failure.line ? `${relative(root, failure.path)}:${failure.line}` : relative(root, failure.path);
    process.stderr.write(`- ${location} ${failure.value}\n`);
  }
  process.exit(1);
}

process.stdout.write(`中英文 README、中文文档与注释检查通过：${markdownFiles.length} 个文档，${sourceFiles.length} 个源码文件。\n`);
