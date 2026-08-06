"use client";

// Report / status screen. Owns the resumable upload: if this device still
// holds the video blob (IndexedDB) and the server says the upload is
// incomplete, uploading starts (or resumes) automatically — surviving page
// reloads and connection drops. Findings arrive with Workflow V (Phase 4);
// until then this screen is the capture-integrity record.

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { CaptureRecord, FindingsReport } from "../../../lib/types";
import { deletePendingVideo, getPendingVideo } from "../../../lib/blob-store";
import { uploadCapture } from "../../../lib/upload-client";

export default function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [record, setRecord] = useState<CaptureRecord | null>(null);
  const [findings, setFindings] = useState<FindingsReport | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [blobMissing, setBlobMissing] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const uploadStartedRef = useRef(false);
  const uploadControllerRef = useRef<AbortController | null>(null);

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
      // However the upload finished (this session, another tab, another
      // day), a verified capture no longer needs the local copy.
      if (rec.upload.status === "complete" && rec.upload.verified) {
        void deletePendingVideo(id).catch(() => {});
      }
      return rec;
    } catch {
      return null; // offline — keep the last known state
    }
  }, [id]);

  // Poll while anything is still settling: TSA pending, upload running, or
  // analysis not yet in a terminal state (verified uploads auto-analyze).
  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      setRecord((current) => {
        const analysisSettled =
          current?.upload.verified !== true ||
          ["complete", "failed", "unavailable"].includes(current.analysis?.status ?? "");
        const settled =
          current &&
          current.tsa.status === "granted" &&
          current.upload.status === "complete" &&
          analysisSettled;
        if (!settled) void refresh();
        return current;
      });
    }, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // Fetch findings once analysis reports complete.
  useEffect(() => {
    if (record?.analysis?.status !== "complete" || findings) return;
    void fetch(`/api/capture/${id}/findings`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && setFindings(data))
      .catch(() => {});
  }, [record?.analysis?.status, findings, id]);

  // Auto-start/resume the upload once, when we know it's incomplete and the
  // blob is on this device. (Ref guard: React strict mode double-runs
  // effects, and this effect re-fires on every poll's setRecord.)
  useEffect(() => {
    if (!record || record.upload.status === "complete" || uploadStartedRef.current) return;
    uploadStartedRef.current = true;
    const controller = new AbortController();
    uploadControllerRef.current = controller;
    void (async () => {
      const pending = await getPendingVideo(id).catch(() => undefined);
      if (controller.signal.aborted) return;
      if (!pending) {
        setBlobMissing(true);
        return;
      }
      try {
        const done = await uploadCapture(id, pending.blob, pending.mime, {
          onProgress: (sent, total) => setProgress({ sent, total }),
          signal: controller.signal,
        });
        setRecord(done);
        if (done.upload.verified) await deletePendingVideo(id).catch(() => {});
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setUploadError((err as Error).message);
      }
    })();
  }, [record, id]);

  // Abort the in-flight upload when leaving the page — a fresh instance
  // resumes from the server's received-chunk list, instead of two uploaders
  // racing over the same capture.
  useEffect(() => {
    return () => uploadControllerRef.current?.abort();
  }, []);

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
          <span className="badge">Uploaded video</span>
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

      {(record.quality?.warnings.length ?? 0) > 0 && (
        <section className="card">
          <h2>Capture quality</h2>
          {record.quality!.warnings.map((w) => (
            <p key={w} className="muted" style={{ color: "var(--warn)" }}>
              ⚠ {w}
            </p>
          ))}
        </section>
      )}

      <section className="card">
        <h2>Findings</h2>
        {record.upload.status !== "complete" ? (
          <p className="muted">Analysis starts automatically once the upload completes.</p>
        ) : record.upload.verified === false ? (
          <p className="muted">
            Analysis skipped — the uploaded bytes don&apos;t match the
            timestamped fingerprint, so findings couldn&apos;t be attributed
            to the certified video.
          </p>
        ) : record.analysis?.status === "failed" || record.analysis?.status === "unavailable" ? (
          <p style={{ color: "var(--danger)" }}>
            Analysis {record.analysis.status === "failed" ? "failed" : "couldn't start"}
            {record.analysis.error ? ` — ${record.analysis.error}` : ""}.
          </p>
        ) : record.analysis?.status !== "complete" ? (
          <p className="muted">
            Analyzing the video — detecting damage and filtering out
            reflections. This page updates automatically.
          </p>
        ) : !findings ? (
          <p className="muted">Loading findings…</p>
        ) : findings.findings.length === 0 ? (
          <>
            <span className="badge ok">✓ No damage found</span>
            <p className="muted">
              No confirmed damage in this walkaround.
              {findings.rejected.length > 0 &&
                ` ${findings.rejected.length} candidate detection${findings.rejected.length === 1 ? "" : "s"} rejected as reflections, glare, or noise.`}
            </p>
          </>
        ) : (
          <>
            {findings.findings.map((f) => (
              <div
                key={f.id}
                className="card"
                style={{ background: "var(--surface-2)", opacity: f.veto ? 0.55 : 1 }}
              >
                {f.crop && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={f.crop}
                    alt={`${f.class} crop`}
                    style={{ borderRadius: 8, maxWidth: "100%" }}
                  />
                )}
                <div className="row">
                  <span className={`badge ${f.veto ? "warn" : "danger"}`}>
                    {f.assessment?.damage_type && f.assessment.damage_type !== "none"
                      ? f.assessment.damage_type
                      : f.class}
                  </span>
                  <span className="muted">
                    {f.confidence.max !== null ? `${Math.round(f.confidence.max * 100)}% confidence` : ""}
                  </span>
                </div>
                {f.veto && (
                  <p className="muted" style={{ color: "var(--warn)" }}>
                    AI assessment: likely a false positive (reflection, glare,
                    or shadow) — kept for transparency.
                  </p>
                )}
                {f.assessment && !f.veto && (
                  <p className="muted">
                    <span className="badge">AI-assessed</span>{" "}
                    {[
                      f.assessment.severity,
                      f.assessment.sub_type,
                      f.assessment.affected_part,
                      f.assessment.approx_size_cm ? `~${f.assessment.approx_size_cm} cm` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    {f.assessment.pre_existing_indicators &&
                      f.assessment.pre_existing_indicators !== "none" &&
                      ` · pre-existing signs: ${f.assessment.pre_existing_indicators}`}
                  </p>
                )}
                <p className="muted">
                  Seen at {formatPts(f.best_frame.pts_ms)}
                  {f.segment ? ` · ${f.segment.label}` : ""} · tracked across{" "}
                  {f.tracklet.frames} frames
                </p>
              </div>
            ))}
            {findings.rejected.length > 0 && (
              <p className="muted">
                {findings.rejected.length} additional candidate
                {findings.rejected.length === 1 ? "" : "s"} rejected as
                reflections, glare, or noise.
              </p>
            )}
          </>
        )}
      </section>

      {findings?.annotated && (
        <section className="card">
          <h2>Annotated walkaround</h2>
          <video
            controls
            playsInline
            preload="metadata"
            src={`/api/capture/${id}/annotated`}
            style={{ width: "100%", borderRadius: 8, background: "#000" }}
          />
          <p className="muted">
            Every detection the pipeline tracked: red = confirmed finding,
            amber = AI-assessed false positive, gray = rejected as
            reflection/noise.
          </p>
        </section>
      )}

      {findings?.vehicle &&
        Object.values(findings.vehicle).some((v) => v && v !== "unknown" && v !== "unreadable") && (
          <section className="card">
            <div className="row">
              <h2>Vehicle</h2>
              <span className="badge">AI-assessed</span>
            </div>
            <p className="muted">
              {[
                findings.vehicle.color,
                findings.vehicle.make,
                findings.vehicle.model,
                findings.vehicle.model_year_range && findings.vehicle.model_year_range !== "unknown"
                  ? `(${findings.vehicle.model_year_range})`
                  : null,
              ]
                .filter((v) => v && v !== "unknown")
                .join(" ")}
              {findings.vehicle.license_plate &&
                findings.vehicle.license_plate !== "unreadable" &&
                ` · plate ${findings.vehicle.license_plate}`}
            </p>
          </section>
        )}

      {record.upload.verified === true &&
        record.analysis?.status === "complete" &&
        record.tsa.status === "granted" && (
          <a href={`/api/capture/${id}/report`} className="btn btn-primary">
            Download signed PDF report
          </a>
        )}
      <p className="muted">
        Anyone can check a downloaded report at the{" "}
        <Link href="/verify">verifier page</Link> — no account needed.
      </p>

      <Link href="/" className="btn btn-ghost">
        Home
      </Link>
    </main>
  );
}

function formatPts(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
