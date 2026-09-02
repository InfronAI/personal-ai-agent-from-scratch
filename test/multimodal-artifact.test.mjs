import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "copilot-multimodal-test-"));
process.env.COPILOT_DATABASE_PATH = join(directory, "copilot.sqlite");
process.env.COPILOT_ARTIFACT_DIRECTORY = join(directory, "artifacts");
process.env.COPILOT_SESSION_SECRET = "copilot-multimodal-test-session-secret-000000000000";

const {
  createUploadedArtifact,
  listArtifacts,
  prepareModelAttachments
} = await import(`../artifacts/artifact-store.mjs?test=${Date.now()}`);
const { closeDatabase } = await import("../database.mjs");

after(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test("上传文件按用户隔离，并转换为瞬时多模态消息而不泄漏到列表", () => {
  const image = createUploadedArtifact({
    userId: "user-image",
    sessionId: "session-image",
    fileName: "diagram.png",
    mimeType: "image/png",
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01])
  });
  const text = createUploadedArtifact({
    userId: "user-image",
    sessionId: "session-image",
    fileName: "brief.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("项目必须在两周内上线。", "utf8")
  });

  assert.equal(listArtifacts("other-user").length, 0);
  assert.equal(JSON.stringify(listArtifacts("user-image")).includes("base64"), false);
  const prepared = prepareModelAttachments({
    userId: "user-image",
    artifactNames: [image.artifact_id, text.artifact_id]
  });
  assert.deepEqual(prepared.requiredModalities, ["image"]);
  assert.match(prepared.parts[0].image_url.url, /^data:image\/png;base64,/u);
  assert.match(prepared.parts[1].text, /两周内上线/u);
  assert.deepEqual(prepared.missingArtifactNames, []);
});
