import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "copilot-artifact-test-"));
process.env.COPILOT_DATABASE_PATH = join(directory, "copilot.sqlite");
process.env.COPILOT_ARTIFACT_DIRECTORY = join(directory, "artifacts");

const { executeCapability } = await import(`../capabilities/executor.mjs?test=${Date.now()}`);
const artifactStore = await import(`../artifacts/artifact-store.mjs?test=${Date.now()}`);
const { closeDatabase } = await import("../database.mjs");

after(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test("PDF 与 DOCX 工具生成可下载的真实二进制 Artifact", async () => {
  const context = { userId: "user-a", sessionId: "session-a", traceId: "trace-a" };
  const markdown = "# 项目计划\n\n## 目标\n\n形成可验证的交付。\n\n| 指标 | 目标 |\n| --- | --- |\n| 成功率 | 99% |";
  const pdf = await executeCapability("generate_pdf", { title: "项目计划", markdown_content: markdown }, context);
  const docx = await executeCapability("generate_docx", { title: "项目计划", markdown_content: markdown }, context);

  assert.equal(pdf.status, "success");
  assert.equal(docx.status, "success");
  const pdfDownload = artifactStore.artifactDownload({ artifactId: pdf.artifact.artifact_id, userId: "user-a" });
  const docxDownload = artifactStore.artifactDownload({ artifactId: docx.artifact.artifact_id, userId: "user-a" });
  assert.equal(readFileSync(pdfDownload.path).subarray(0, 4).toString(), "%PDF");
  assert.equal(readFileSync(docxDownload.path).subarray(0, 2).toString(), "PK");
  assert.throws(
    () => artifactStore.artifactDownload({ artifactId: pdf.artifact.artifact_id, userId: "user-b" }),
    error => error.code === "artifact_not_found"
  );

  const deletedPath = pdfDownload.path;
  assert.equal(artifactStore.deleteArtifact({ artifactId: pdf.artifact.artifact_id, userId: "user-a" }).deleted, true);
  assert.equal(existsSync(deletedPath), false);
});

