// Registers a capture with the API: the tiny {hash, clientTime, ...} POST
// that gets RFC 3161 timestamped server-side. Retries on network failure,
// and the blob is persisted to IndexedDB before this is ever called — a dead
// spot at the rental lot delays the timestamp but never loses the evidence.

import type { CaptureCreateRequest, CaptureRecord } from "./types";
import { fetchWithRetry } from "./upload-client";
import {
  deletePendingVideo,
  savePendingVideo,
  type PendingVideo,
} from "./blob-store";
import { sha256Hex } from "./hash";

export async function registerCapture(
  meta: CaptureCreateRequest,
  signal?: AbortSignal
): Promise<CaptureRecord> {
  const res = await fetchWithRetry(
    "/api/capture",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(meta),
    },
    signal
  );
  return res.json();
}

/** Finish securing a video whose record-stop happened offline: hash it if
 * the hash step never ran, register it, and re-key the IndexedDB entry from
 * its local id to the server capture id. Returns the server id. */
export async function recoverPendingVideo(
  pending: PendingVideo,
  signal?: AbortSignal
): Promise<string> {
  if (!pending.meta) {
    throw new Error("No capture metadata stored with this video");
  }
  let meta = pending.meta;
  if (!meta.hash) {
    meta = { ...meta, hash: await sha256Hex(pending.blob) };
  }
  const record = await registerCapture(meta, signal);
  await savePendingVideo({
    ...pending,
    captureId: record.id,
    registered: true,
    meta,
  });
  await deletePendingVideo(pending.captureId);
  return record.id;
}
