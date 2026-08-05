"use client";

// Report / status screen. Owns the resumable upload: if this device still
// holds the video blob (IndexedDB) and the server says the upload is
// incomplete, uploading starts (or resumes) automatically — surviving page
// reloads and connection drops. Findings arrive with Workflow V (Phase 4);
// until then this screen is the capture-integrity record.

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { CaptureRecord } from "../../../lib/types";
import { deletePendingVideo, getPendingVideo } from "../../../lib/blob-store";
import { uploadCapture } from "../../../lib/upload-client";

export default function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [record, setRecord] = useState<CaptureRecord | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [blobMissing, setBlobMissing] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const uploadStartedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/capture/${id}`, { cache: "no-store" });
      if (res.status === 404) {
        setNotFound(true);
        return null;
      }
      if (!res.ok) return null;
      const rec = (await res.json()) as CaptureRecord;
      setRecord(rec);
      return rec;
    } catch {
      return null; // offline — keep the last known state
    }
  }, [id]);

  // Poll while anything is still settling (TSA pending or upload running).
  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      setRecord((current) => {
        const settled =
          current &&
          current.tsa.status === "granted" &&
          current.upload.status === "complete";
        if (!settled) void refresh();
        return current;
      });
    }, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // Auto-start/resume the upload once, when we know it's incomplete and the
  // blob is on this device. (Ref guard: React strict mode double-runs effects.)
  useEffect(() => {
    if (!record || record.upload.status === "complete" || uploadStartedRef.current) return;
    uploadStartedRef.current = true;
    void (async () => {
      const pending = await getPendingVideo(id).catch(() => undefined);
      if (!pending) {
        setBlobMissing(true);
        return;
      }
      try {
        const done = await uploadCapture(id, pending.blob, pending.mime, {
          onProgress: (sent, total) => setProgress({ sent, total }),
        });
        setRecord(done);
        if (done.upload.verified) await deletePendingVideo(id).catch(() => {});
      } catch (err) {
        setUploadError((err as Error).message);
      }
    })();
  }, [record, id]);

  if (notFound) {
    return (
      <main className="container">
        <h1>Report</h1>
        <p className="muted">No capture with this id. <Link href="/">Back home</Link>.</p>
      </main>
    );
  }
  if (!record) {
    return (
      <main className="container">
        <h1>Report</h1>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const up = record.upload;
  const pct =
    up.status === "complete"
      ? 100
      : progress
        ? Math.round((progress.sent / progress.total) * 100)
        : up.totalChunks
          ? Math.round(((up.receivedChunks ?? 0) / up.totalChunks) * 100)
          : 0;

  return (
    <main className="container">
      <div className="row">
        <h1>Inspection report</h1>
        {record.source === "library" ? (
          <span className="badge warn">Library upload</span>
        ) : (
          <span className="badge ok">Recorded in app</span>
        )}
      </div>

      <section className="card">
        <h2>Capture integrity</h2>
        <div>
          <p className="muted">Video fingerprint (SHA-256)</p>
          <p className="mono">{record.hash}</p>
        </div>
        <div className="row">
          <span className="muted">
            {record.source === "library" ? "Received" : "Recorded"}{" "}
            {new Date(record.clientTime).toLocaleString()}
          </span>
          {record.tsa.status === "granted" ? (
            <span className="badge ok">✓ Timestamp certified</span>
          ) : (
            <span className="badge warn">Timestamp pending — retrying</span>
          )}
        </div>
        {record.source === "library" && (
          <p className="muted">
            This timestamp proves when the video was received — not when it was
            filmed.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Video upload</h2>
        {up.status === "complete" ? (
          up.verified ? (
            <span className="badge ok">✓ Uploaded — bytes match the timestamped fingerprint</span>
          ) : (
            <span className="badge danger">Uploaded, but hash mismatch — integrity not verified</span>
          )
        ) : blobMissing ? (
          <p className="muted">
            The video isn&apos;t stored on this device. Open this report on the
            device that recorded it to finish the upload.
          </p>
        ) : (
          <>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="muted">
              {pct}% — uploading in the background. Safe to keep this page open
              through connection drops; it resumes automatically.
            </p>
          </>
        )}
        {uploadError && <p style={{ color: "var(--danger)" }}>{uploadError}</p>}
      </section>

      {record.segments && record.segments.length > 0 && (
        <section className="card">
          <h2>Coverage</h2>
          <p className="muted">
            {record.segments.length} areas covered
            {record.durationMs ? ` · ${Math.round(record.durationMs / 1000)} s total` : ""}
          </p>
        </section>
      )}

      <section className="card">
        <h2>Findings</h2>
        <p className="muted">
          Damage analysis runs after upload completes — detections, reflection
          filtering, and the signed PDF land here automatically. (Pipeline
          arrives in the next build phase.)
        </p>
      </section>

      <Link href="/" className="btn btn-ghost">
        Home
      </Link>
    </main>
  );
}
