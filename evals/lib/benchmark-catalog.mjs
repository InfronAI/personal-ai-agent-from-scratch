import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

export function loadBenchmarkCatalog(path) {
  const absolutePath = resolve(path);
  const catalog = JSON.parse(readFileSync(absolutePath, "utf8"));
  assertion(catalog?.schemaVersion === "copilot-benchmark-catalog.v1", "Benchmark Catalog 协议无效。");
  assertion(typeof catalog.catalogVersion === "string" && catalog.catalogVersion, "Benchmark Catalog 缺少版本。");
  assertion(catalog.adaptationPolicy?.mode === "methodology-inspired-original", "Benchmark Catalog 只能使用原创适配策略。");
  assertion(Array.isArray(catalog.benchmarks) && catalog.benchmarks.length > 0, "Benchmark Catalog 不能为空。");
  const ids = new Set();
  for (const [index, benchmark] of catalog.benchmarks.entries()) {
    const location = `Benchmark Catalog 第 ${index + 1} 项`;
    assertion(/^[a-z0-9][a-z0-9-]+$/u.test(String(benchmark.id || "")), `${location} ID 无效。`);
    assertion(!ids.has(benchmark.id), `${location} ID 重复：${benchmark.id}。`);
    ids.add(benchmark.id);
    for (const field of ["name", "scope", "methodology"]) {
      assertion(typeof benchmark[field] === "string" && benchmark[field].trim(), `${location}.${field} 不能为空。`);
    }
    const url = new URL(benchmark.officialUrl);
    assertion(url.protocol === "https:", `${location}.officialUrl 必须使用 HTTPS。`);
  }
  return { ...catalog, path: absolutePath, ids };
}

export function validateBenchmarkMetadata(items, catalog) {
  const benchmarkItems = items.filter(item => item.metadata?.benchmark_reference_id);
  const failures = [];
  for (const item of benchmarkItems) {
    const metadata = item.metadata;
    if (!catalog.ids.has(metadata.benchmark_reference_id)) failures.push(`${item.id} 引用了未知 Benchmark ${metadata.benchmark_reference_id}`);
    if (metadata.benchmark_family !== metadata.benchmark_reference_id) failures.push(`${item.id} 的 benchmark_family 与 reference_id 不一致`);
    if (!metadata.benchmark_task) failures.push(`${item.id} 缺少 benchmark_task`);
    if (metadata.benchmark_adaptation !== catalog.adaptationPolicy.mode) failures.push(`${item.id} 未声明原创适配策略`);
  }
  return {
    valid: failures.length === 0,
    failures,
    benchmarkItems: benchmarkItems.length,
    families: Object.fromEntries([...catalog.ids].sort().map(id => [id, benchmarkItems.filter(item => item.metadata.benchmark_reference_id === id).length]))
  };
}
