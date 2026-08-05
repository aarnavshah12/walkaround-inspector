// Registers a capture with the API: the tiny {hash, clientTime, ...} POST
// that gets RFC 3161 timestamped server-side. Retries on network failure
// (the video itself is already safe in IndexedDB), so a dead spot at the
// rental lot delays the timestamp but never loses the evidence.

import type { CaptureCreateRequest, CaptureRecord } from "./types";
import { fetchWithRetry } from "./upload-client";

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
