// Resumable chunked upload. Chunks are 1 MB, sent sequentially with
// exponential backoff on failure; the server reports which chunks it already
// has, so a reload or connection drop only costs the in-flight chunk.

import type { CaptureRecord, UploadInitResponse } from "./types";

export const CHUNK_SIZE = 1024 * 1024;

/** Thrown on 4xx responses — retrying won't help. */
export class UploadRejectedError extends Error {}

export interface UploadOptions {
  onProgress?: (sentChunks: number, totalChunks: number) => void;
  signal?: AbortSignal;
}

export async function uploadCapture(
  captureId: string,
  blob: Blob,
  mime: string,
  opts: UploadOptions = {}
): Promise<CaptureRecord> {
  const totalChunks = Math.max(1, Math.ceil(blob.size / CHUNK_SIZE));

  const initRes = await fetchWithRetry(
    "/api/uploads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        captureId,
        size: blob.size,
        chunkSize: CHUNK_SIZE,
        totalChunks,
        mime,
      }),
    },
    opts.signal
  );
  const init = (await initRes.json()) as UploadInitResponse;

  if (init.complete) {
    const res = await fetchWithRetry(`/api/capture/${captureId}`, {}, opts.signal);
    return res.json();
  }

  const have = new Set<number>(init.received);
  let sent = have.size;
  opts.onProgress?.(sent, totalChunks);

  try {
    for (let i = 0; i < totalChunks; i++) {
      if (have.has(i)) continue;
      const part = blob.slice(i * CHUNK_SIZE, Math.min(blob.size, (i + 1) * CHUNK_SIZE));
      await fetchWithRetry(
        `/api/uploads/${captureId}/chunks/${i}`,
        { method: "PUT", body: part },
        opts.signal
      );
      sent++;
      opts.onProgress?.(sent, totalChunks);
    }

    const done = await fetchWithRetry(
      `/api/uploads/${captureId}/complete`,
      { method: "POST" },
      opts.signal
    );
    return done.json();
  } catch (err) {
    // A concurrent uploader (second tab, earlier orphaned instance) may have
    // finished first — chunk PUTs then 409 "already complete". That's
    // success, not failure: confirm against the capture record.
    if (err instanceof UploadRejectedError) {
      const res = await fetch(`/api/capture/${captureId}`, {
        cache: "no-store",
        signal: opts.signal,
      }).catch(() => null);
      if (res?.ok) {
        const record = (await res.json()) as CaptureRecord;
        if (record.upload.status === "complete") return record;
      }
    }
    throw err;
  }
}

/** Retries network failures and 5xx forever (capped backoff, waits for
 * `online` when the browser knows it's offline). 4xx throws immediately. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<Response> {
  let delay = 1000;
  for (;;) {
    throwIfAborted(signal);
    try {
      const res = await fetch(url, { ...init, signal });
      if (res.ok) return res;
      if (res.status >= 400 && res.status < 500) {
        throw new UploadRejectedError(
          `${init.method ?? "GET"} ${url} → ${res.status}: ${await res.text().catch(() => "")}`
        );
      }
    } catch (err) {
      if (err instanceof UploadRejectedError) throw err;
      if ((err as Error).name === "AbortError") throw err;
      // network failure — fall through to backoff
    }
    await backoff(delay, signal);
    delay = Math.min(delay * 2, 30_000);
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
}

function backoff(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("online", onOnline);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOnline = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Upload aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        // Browser says offline — wait for signal instead of burning retries.
        window.addEventListener("online", onOnline);
        return;
      }
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}
