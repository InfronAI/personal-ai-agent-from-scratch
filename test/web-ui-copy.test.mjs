import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const fixedCopySources = [
  "index.html",
  "app.js",
  "styles.css",
  "src/web/api-client.mjs",
  "config/model-catalog.config.json"
];

test("Web UI 固定产品文案全部使用英文", () => {
  for (const relativePath of fixedCopySources) {
    const source = readFileSync(join(root, relativePath), "utf8");
    assert.doesNotMatch(source, /[\u3400-\u9fff]/u, `${relativePath} 含有中文固定文案`);
  }

  const html = readFileSync(join(root, "index.html"), "utf8");
  assert.match(html, /<html lang="en">/u);
});
