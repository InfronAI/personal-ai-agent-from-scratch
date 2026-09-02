import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { closeDatabase } from "../database.mjs";
import { exportableGoldenSetItems } from "../golden-set-store.mjs";
import { loadEvalConfiguration, resolveEvalPath } from "./lib/eval-config.mjs";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
if (outputIndex >= 0 && !args[outputIndex + 1]) throw new Error("--output 缺少文件路径");

const configuration = loadEvalConfiguration();
const defaultOutput = resolveEvalPath(configuration, configuration.goldenSet.export.file);
const output = resolve(appRoot, outputIndex >= 0 ? args[outputIndex + 1] : defaultOutput);
const items = exportableGoldenSetItems();
if (!items.length) {
  process.stderr.write("Golden Set 中没有已审核且有效的数据项，未生成空快照。\n");
  closeDatabase();
  process.exit(2);
}
for (const item of items) {
  if (item.evidence?.schemaVersion !== configuration.goldenSet.evidenceSchemaVersion
    || item.evidence?.scope !== configuration.goldenSet.evidenceScope
    || item.evidence?.session?.boundary?.type !== configuration.goldenSet.sessionBoundary) {
    throw new Error(`Golden 数据项 ${item.id} 缺少符合配置的 Trace/Session 证据。`);
  }
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${items.map(item => JSON.stringify(item)).join("\n")}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  schemaVersion: "copilot-golden-export.v1",
  datasetVersion: configuration.goldenSet.export.datasetVersion,
  items: items.length,
  output
}, null, 2)}\n`);
closeDatabase();
