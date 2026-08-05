// Chunk files + final video assembly under DATA_DIR. The assembled video is
// re-hashed server-side and compared against the client hash that was
// timestamped at record-stop — that comparison is the integrity check the
// whole capture story hangs on.

import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { DATA_DIR } from "./config";
import { isValidCaptureId } from "./store";

const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const VIDEOS_DIR = path.join(DATA_DIR, "videos");

function uploadDir(captureId: string): string {
  if (!isValidCaptureId(captureId)) throw new Error("Invalid capture id");
  return path.join(UPLOADS_DIR, captureId);
}

function chunkPath(captureId: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error("Invalid chunk index");
  return path.join(uploadDir(captureId), `chunk-${index}`);
}

export async function saveChunk(
  captureId: string,
  index: number,
  data: Buffer
): Promise<void> {
  await fs.mkdir(uploadDir(captureId), { recursive: true });
  // Idempotent by construction: rewriting the same chunk is harmless.
  await fs.writeFile(chunkPath(captureId, index), data);
}

export async function listReceivedChunks(captureId: string): Promise<number[]> {
  try {
    const names = await fs.readdir(uploadDir(captureId));
    return names
      .map((n) => /^chunk-(\d+)$/.exec(n)?.[1])
      .filter((m): m is string => m !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export function videoExtension(mime: string): string {
  return mime.includes("mp4") ? "mp4" : "webm";
}

export function videoPath(captureId: string, mime: string): string {
  if (!isValidCaptureId(captureId)) throw new Error("Invalid capture id");
  return path.join(VIDEOS_DIR, `${captureId}.${videoExtension(mime)}`);
}

/** Concatenate chunks in order into the final video, returning its SHA-256
 * (hex) and size. Chunks are read one at a time (≤8 MB each) — no full-video
 * buffering. */
export async function assembleVideo(
  captureId: string,
  totalChunks: number,
  mime: string
): Promise<{ path: string; sha256: string; size: number }> {
  await fs.mkdir(VIDEOS_DIR, { recursive: true });
  const target = videoPath(captureId, mime);
  const tmp = `${target}.tmp`;
  const hash = createHash("sha256");
  const out = await fs.open(tmp, "w");
  let size = 0;
  try {
    for (let i = 0; i < totalChunks; i++) {
      const data = await fs.readFile(chunkPath(captureId, i));
      hash.update(data);
      await out.write(data);
      size += data.length;
    }
  } finally {
    await out.close();
  }
  await fs.rename(tmp, target);
  return { path: target, sha256: hash.digest("hex"), size };
}

export async function deleteChunks(captureId: string): Promise<void> {
  await fs.rm(uploadDir(captureId), { recursive: true, force: true });
}
