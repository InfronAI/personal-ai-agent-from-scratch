import crypto from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import { config } from "../config.mjs";
import { database } from "../database.mjs";
import { AppError } from "../errors.mjs";

mkdirSync(config.artifacts.directory, { recursive: true });

const insertArtifact = database.prepare(`
  INSERT INTO artifacts (
    id, user_id, session_id, trace_id, name, title, kind, mime_type,
    file_name, storage_path, size_bytes, content_text, metadata_json,
    active, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
`);
const byIdForUser = database.prepare(`
  SELECT * FROM artifacts WHERE id = ? AND user_id = ? AND active = 1 LIMIT 1
`);
const listForUser = database.prepare(`
  SELECT id, session_id, trace_id, name, title, kind, mime_type, file_name,
         size_bytes, metadata_json, created_at, updated_at
  FROM artifacts WHERE user_id = ? AND active = 1
  ORDER BY created_at DESC LIMIT ?
`);
const deactivateArtifact = database.prepare(`
  UPDATE artifacts SET active = 0, updated_at = ? WHERE id = ? AND user_id = ? AND active = 1
`);

const uploadTypes = Object.freeze({
  pdf: ["application/pdf"],
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  webp: ["image/webp"],
  txt: ["text/plain"],
  md: ["text/markdown", "text/plain"],
  json: ["application/json", "text/json", "text/plain"],
  csv: ["text/csv", "application/csv", "text/plain"],
  mp3: ["audio/mpeg", "audio/mp3"],
  wav: ["audio/wav", "audio/x-wav"]
});
const supportedExtensions = Object.freeze(["pdf", "docx", "md", "txt", "json", ...Object.keys(uploadTypes)]);

function cleanIdentifier(value, fallback) {
  return String(value || fallback).trim().slice(0, 200) || fallback;
}

function safeJson(raw) {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function slug(value) {
  const normalized = String(value || "document").normalize("NFKD").toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 72);
  return normalized || "document";
}

function cleanExtension(value) {
  const extension = String(value || "").toLocaleLowerCase().replace(/^\./u, "");
  if (!supportedExtensions.includes(extension)) {
    throw new AppError(`Artifact extension ${extension || "missing"} is not supported`, { code: "invalid_artifact", status: 400, expose: true });
  }
  return extension;
}

function cleanUploadFileName(value) {
  const fileName = basename(String(value || "").normalize("NFKC"))
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[/\\]/gu, "-")
    .trim()
    .slice(0, 180);
  if (!fileName || fileName === "." || fileName === "..") {
    throw new AppError("文件名无效", { code: "invalid_file_name", status: 400, expose: true });
  }
  return fileName;
}

function publicArtifact(row, { includeContent = false } = {}) {
  return {
    artifact_id: row.id,
    name: row.name,
    title: row.title,
    kind: row.kind,
    mime_type: row.mime_type,
    file_name: row.file_name,
    size_bytes: row.size_bytes,
    download_url: `/api/artifacts/${encodeURIComponent(row.id)}/download`,
    source: { session_id: row.session_id, trace_id: row.trace_id },
    metadata: safeJson(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(includeContent ? {
      content: row.content_text
        ? row.content_text.slice(0, config.artifacts.maxSourceCharacters)
        : `[Binary ${row.mime_type} artifact; textual source is unavailable]`,
      content_truncated: Boolean(row.content_text && row.content_text.length > config.artifacts.maxSourceCharacters)
    } : {})
  };
}

function resolvedStoragePath(row) {
  const path = resolve(row.storage_path);
  const root = `${resolve(config.artifacts.directory)}/`;
  if (!path.startsWith(root)) throw new AppError("Artifact storage path is invalid", { code: "artifact_storage_error", status: 500 });
  return path;
}

export function createArtifact({
  userId,
  sessionId,
  traceId = null,
  title,
  kind,
  mimeType,
  extension,
  buffer,
  contentText = null,
  metadata = {},
  fileName: requestedFileName = null,
  namePrefix = "generated"
}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new AppError("Generated artifact is empty", { code: "artifact_generation_failed", status: 500 });
  if (buffer.length > config.artifacts.maxArtifactBytes) {
    throw new AppError(`Generated artifact exceeds ${config.artifacts.maxArtifactBytes} bytes`, { code: "artifact_too_large", status: 413, expose: true });
  }
  const scopedUserId = cleanIdentifier(userId, "anonymous");
  const scopedSessionId = cleanIdentifier(sessionId, "unknown-session");
  const cleanTitle = String(title || "Document").trim().slice(0, 200) || "Document";
  const cleanKind = cleanIdentifier(kind, "document");
  const cleanMimeType = String(mimeType || "application/octet-stream").slice(0, 120);
  const cleanExt = cleanExtension(extension);
  const id = `art-${crypto.randomUUID()}`;
  const name = `${slug(namePrefix)}_${cleanExt}_${slug(cleanTitle)}-${id.slice(-8)}`;
  const fileName = requestedFileName
    ? cleanUploadFileName(requestedFileName)
    : `${slug(cleanTitle)}-${id.slice(-8)}.${cleanExt}`;
  const storagePath = resolve(config.artifacts.directory, `${id}.${cleanExt}`);
  const temporaryPath = resolve(config.artifacts.directory, `.${id}.${cleanExt}.tmp`);
  const now = new Date().toISOString();
  const cleanContent = contentText === null ? null : String(contentText).slice(0, config.artifacts.maxSourceCharacters);
  writeFileSync(temporaryPath, buffer, { mode: 0o600, flag: "wx" });
  try {
    renameSync(temporaryPath, storagePath);
    insertArtifact.run(
      id,
      scopedUserId,
      scopedSessionId,
      traceId ? cleanIdentifier(traceId, "") : null,
      name,
      cleanTitle,
      cleanKind,
      cleanMimeType,
      fileName,
      storagePath,
      buffer.length,
      cleanContent,
      JSON.stringify(metadata),
      now,
      now
    );
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch {}
    try { unlinkSync(storagePath); } catch {}
    throw error;
  }
  return publicArtifact(byIdForUser.get(id, scopedUserId));
}

export function createUploadedArtifact({ userId, sessionId, fileName, mimeType, buffer }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new AppError("上传文件不能为空", { code: "empty_upload", status: 400, expose: true });
  }
  const cleanFileName = cleanUploadFileName(fileName);
  const extension = cleanExtension(extname(cleanFileName));
  const allowedMimeTypes = uploadTypes[extension];
  if (!allowedMimeTypes) {
    throw new AppError(`不支持上传 .${extension} 文件`, { code: "unsupported_upload", status: 415, expose: true });
  }
  const declaredMimeType = String(mimeType || "application/octet-stream").split(";", 1)[0].trim().toLocaleLowerCase();
  const resolvedMimeType = declaredMimeType === "application/octet-stream" ? allowedMimeTypes[0] : declaredMimeType;
  if (!allowedMimeTypes.includes(resolvedMimeType)) {
    throw new AppError(`文件扩展名 .${extension} 与 Content-Type ${resolvedMimeType} 不匹配`, {
      code: "upload_type_mismatch", status: 415, expose: true
    });
  }
  const textual = resolvedMimeType.startsWith("text/") || ["application/json"].includes(resolvedMimeType);
  if (textual && buffer.includes(0)) {
    throw new AppError("文本文件包含二进制内容", { code: "invalid_text_upload", status: 400, expose: true });
  }
  const title = cleanFileName.replace(/\.[^.]+$/u, "") || cleanFileName;
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  return createArtifact({
    userId,
    sessionId,
    title,
    kind: "uploaded_file",
    mimeType: resolvedMimeType,
    extension,
    buffer,
    contentText: textual ? buffer.toString("utf8") : null,
    fileName: cleanFileName,
    namePrefix: "uploaded",
    metadata: {
      source: "user_upload",
      sha256,
      original_file_name: cleanFileName,
      multimodal_kind: resolvedMimeType.startsWith("image/")
        ? "image"
        : resolvedMimeType.startsWith("audio/")
          ? "audio"
          : resolvedMimeType === "application/pdf"
            ? "file"
            : "text"
    }
  });
}

function attachmentRows(userId, artifactNames) {
  const scopedUserId = cleanIdentifier(userId, "anonymous");
  const names = [...new Set((artifactNames || []).map(value => String(value || "").trim()).filter(Boolean))].slice(0, 10);
  if (!names.length) return [];
  const placeholders = names.map(() => "?").join(", ");
  const rows = database.prepare(`
    SELECT * FROM artifacts
    WHERE user_id = ? AND active = 1
      AND (id IN (${placeholders}) OR name IN (${placeholders}) OR file_name IN (${placeholders}) OR title IN (${placeholders}))
  `).all(scopedUserId, ...names, ...names, ...names, ...names);
  const byName = new Map(rows.flatMap(row => [row.id, row.name, row.file_name, row.title].map(value => [value, row])));
  return names.map(name => byName.get(name)).filter((row, index, values) => row && values.indexOf(row) === index);
}

export function prepareModelAttachments({ userId, artifactNames }) {
  const requestedNames = [...new Set((artifactNames || []).map(value => String(value || "").trim()).filter(Boolean))].slice(0, 10);
  const rows = attachmentRows(userId, artifactNames);
  const totalBytes = rows.reduce((sum, row) => sum + Number(row.size_bytes || 0), 0);
  if (totalBytes > config.artifacts.maxTurnAttachmentBytes) {
    throw new AppError(`本轮附件总大小超过 ${config.artifacts.maxTurnAttachmentBytes} bytes`, {
      code: "turn_attachments_too_large", status: 413, expose: true
    });
  }
  const parts = [];
  const requiredModalities = new Set();
  for (const row of rows) {
    const buffer = readFileSync(resolvedStoragePath(row));
    const mimeType = String(row.mime_type || "application/octet-stream").toLocaleLowerCase();
    if (mimeType.startsWith("text/") || mimeType === "application/json") {
      parts.push({
        type: "text",
        text: `\n\n[附件：${row.file_name}]\n${String(row.content_text || buffer.toString("utf8")).slice(0, config.artifacts.maxSourceCharacters)}`
      });
      continue;
    }
    if (mimeType.startsWith("image/")) {
      requiredModalities.add("image");
      parts.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${buffer.toString("base64")}` } });
      continue;
    }
    if (mimeType === "application/pdf") {
      requiredModalities.add("file");
      parts.push({ type: "file", file: { filename: row.file_name, file_data: `data:${mimeType};base64,${buffer.toString("base64")}` } });
      continue;
    }
    if (mimeType.startsWith("audio/")) {
      requiredModalities.add("audio");
      const extension = extname(row.file_name).replace(/^\./u, "").toLocaleLowerCase();
      parts.push({ type: "input_audio", input_audio: { data: buffer.toString("base64"), format: extension === "mp3" ? "mp3" : "wav" } });
      continue;
    }
    parts.push({
      type: "text",
      text: row.content_text
        ? `\n\n[附件：${row.file_name}]\n${String(row.content_text).slice(0, config.artifacts.maxSourceCharacters)}`
        : `\n\n[附件：${row.file_name}，类型：${mimeType}。如需读取内容，请调用 load_artifacts。]`
    });
  }
  return {
    artifacts: rows.map(row => publicArtifact(row)),
    parts,
    totalBytes,
    requiredModalities: [...requiredModalities],
    missingArtifactNames: requestedNames.filter(name => !rows.some(row => [row.id, row.name, row.file_name, row.title].includes(name)))
  };
}

export function loadArtifacts({ userId, artifactNames }) {
  const scopedUserId = cleanIdentifier(userId, "anonymous");
  const names = [...new Set((artifactNames || []).map(value => String(value || "").trim()).filter(Boolean))].slice(0, 10);
  if (!names.length) return { status: "error", error: "load_artifacts requires at least one artifact name", artifacts: [], returned_count: 0 };
  const placeholders = names.map(() => "?").join(", ");
  const rows = database.prepare(`
    SELECT * FROM artifacts
    WHERE user_id = ? AND active = 1
      AND (id IN (${placeholders}) OR name IN (${placeholders}) OR file_name IN (${placeholders}) OR title IN (${placeholders}))
    ORDER BY created_at DESC
  `).all(scopedUserId, ...names, ...names, ...names, ...names);
  const artifacts = rows.map(row => publicArtifact(row, { includeContent: true }));
  const found = new Set(rows.flatMap(row => [row.id, row.name, row.file_name, row.title]));
  return {
    status: "success",
    artifacts,
    returned_count: artifacts.length,
    missing_artifact_names: names.filter(name => !found.has(name)),
    scope: "current_user"
  };
}

export function listArtifacts(userId, limit = config.artifacts.listLimit) {
  const scopedUserId = cleanIdentifier(userId, "anonymous");
  const bounded = Math.min(config.artifacts.listLimit, Math.max(1, Number(limit) || config.artifacts.listLimit));
  return listForUser.all(scopedUserId, bounded).map(row => publicArtifact(row));
}

export function artifactDownload({ artifactId, userId }) {
  const scopedUserId = cleanIdentifier(userId, "anonymous");
  const row = byIdForUser.get(cleanIdentifier(artifactId, ""), scopedUserId);
  if (!row) throw new AppError("Artifact not found", { code: "artifact_not_found", status: 404, expose: true });
  return {
    path: resolvedStoragePath(row),
    fileName: basename(row.file_name),
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    artifact: publicArtifact(row)
  };
}

export function deleteArtifact({ artifactId, userId }) {
  const scopedUserId = cleanIdentifier(userId, "anonymous");
  const row = byIdForUser.get(cleanIdentifier(artifactId, ""), scopedUserId);
  if (!row) throw new AppError("Artifact not found", { code: "artifact_not_found", status: 404, expose: true });
  const changed = deactivateArtifact.run(new Date().toISOString(), row.id, scopedUserId).changes;
  if (changed) {
    const path = resolvedStoragePath(row);
    try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { deleted: Boolean(changed), artifact_id: row.id };
}

export function artifactStoreStatus() {
  const row = database.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE active = 1").get();
  return {
    configured: true,
    provider: "sqlite+filesystem",
    active_artifacts: Number(row.count || 0),
    max_artifact_bytes: config.artifacts.maxArtifactBytes,
    max_turn_attachment_bytes: config.artifacts.maxTurnAttachmentBytes,
    supported_extensions: [...new Set(supportedExtensions)],
    upload_extensions: Object.keys(uploadTypes)
  };
}
