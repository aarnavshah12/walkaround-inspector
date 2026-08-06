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
  const [copied, setCopied] = useState(false);
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
      <main className="container fade-stagger">
        <section className="hero">
          <h1>
            Report <span className="grad-text">not found</span>
          </h1>
          <p className="lede">
            There&apos;s no capture with this id — it may have been created on a
            different device.
          </p>
        </section>
        <Link href="/" className="btn btn-ghost">
          Back home
        </Link>
      </main>
    );
  }
  if (!record) {
    return (
      <main className="container">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <h1>
            Inspection <span className="grad-text">report</span>
          </h1>
          <span className="badge pulse">Loading</span>
        </div>
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
    <main className="container fade-stagger">
      <header className="row" style={{ flexWrap: "wrap", paddingTop: 6 }}>
        <h1>
          Inspection <span className="grad-text">report</span>
        </h1>
        {record.source === "library" ? (
          <span className="badge">Uploaded video</span>
        ) : (
          <span className="badge ok">Recorded in app</span>
        )}
      </header>

      <section className="card">
        <div className="row">
          <span className="section-label">Damage findings</span>
          {up.status !== "complete" ? (
            <span className="badge pulse">Waiting for upload</span>
          ) : up.verified === false ? (
            <span className="badge danger">Skipped</span>
          ) : record.analysis?.status === "failed" || record.analysis?.status === "unavailable" ? (
            <span className="badge danger">
              {record.analysis?.status === "failed" ? "Failed" : "Unavailable"}
            </span>
          ) : record.analysis?.status !== "complete" ? (
            <span className="badge pulse">Analyzing</span>
          ) : !findings ? (
            <span className="badge pulse">Loading</span>
          ) : findings.findings.length === 0 ? (
            <span className="badge ok">No damage found</span>
          ) : (
            <span className="badge danger">
              {findings.findings.length} finding{findings.findings.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {record.upload.status !== "complete" ? (
          <p className="muted">Analysis starts automatically once the upload completes.</p>
        ) : record.upload.verified === false ? (
          <p className="muted">
            Analysis skipped — the uploaded bytes don&apos;t match the
            timestamped fingerprint, so findings couldn&apos;t be attributed
            to the certified video.
          </p>
        ) : record.analysis?.status === "failed" || record.analysis?.status === "unavailable" ? (
          <p className="muted" style={{ color: "var(--danger)" }}>
            Analysis {record.analysis.status === "failed" ? "failed" : "couldn't start"}
            {record.analysis.error ? ` — ${record.analysis.error}` : ""}.
          </p>
        ) : record.analysis?.status !== "complete" ? (
          <div className="stack-sm">
            <div className="row">
              <span className="muted">{record.analysis?.stage ?? "Starting analysis"}</span>
              <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                {Math.round((record.analysis?.progress ?? 0) * 100)}%
              </span>
            </div>
            <div className="progress-track">
              <div
                className="progress-fill active"
                style={{ width: `${Math.round((record.analysis?.progress ?? 0) * 100)}%` }}
              />
            </div>
            <p className="muted">
              Running automatically{analysisEta(record.analysis)}. This page
              updates itself — no need to refresh.
            </p>
          </div>
        ) : !findings ? (
          <p className="muted">Loading findings…</p>
        ) : findings.findings.length === 0 ? (
          <p className="muted">
            No confirmed damage in this walkaround.
            {findings.rejected.length > 0 &&
              ` ${findings.rejected.length} candidate detection${findings.rejected.length === 1 ? "" : "s"} rejected as reflections, glare, or noise.`}
          </p>
        ) : (
          <>
            {findings.findings.map((f) => (
              <div key={f.id} className={`card-nested finding-card${f.veto ? " vetoed" : ""}`}>
                {f.crop && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.crop} alt={`${f.class} crop`} className="finding-media" />
                )}
                <div className="row">
                  <span className={`badge ${f.veto ? "warn" : "danger"}`}>
                    {f.assessment?.damage_type && f.assessment.damage_type !== "none"
                      ? f.assessment.damage_type
                      : f.class}
                  </span>
                  <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
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
          <span className="section-label">Annotated walkaround</span>
          <video
            className="player"
            controls
            playsInline
            preload="metadata"
            src={`/api/capture/${id}/annotated`}
          />
          <p className="muted">Every detection the pipeline tracked, frame by frame.</p>
          <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap", gap: 14 }}>
            <span className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--danger)", flex: "none" }} />
              Confirmed finding
            </span>
            <span className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--warn)", flex: "none" }} />
              AI-assessed false positive
            </span>
            <span className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--muted)", flex: "none" }} />
              Rejected reflection / noise
            </span>
          </div>
        </section>
      )}

      {findings?.vehicle &&
        Object.values(findings.vehicle).some((v) => v && v !== "unknown" && v !== "unreadable") && (
          <section className="card">
            <div className="row">
              <span className="section-label">Vehicle</span>
              <span className="badge">AI-assessed</span>
            </div>
            <p style={{ fontWeight: 700, fontSize: "1.06rem", letterSpacing: "-0.01em" }}>
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
            </p>
            {findings.vehicle.license_plate && findings.vehicle.license_plate !== "unreadable" && (
              <span className="hash-chip mono" style={{ width: "fit-content" }}>
                Plate · {findings.vehicle.license_plate}
              </span>
            )}
          </section>
        )}

      <section className="card">
        <div className="row">
          <span className="section-label">Capture integrity</span>
          {record.tsa.status === "granted" ? (
            <span className="badge ok">Timestamp certified</span>
          ) : (
            <span className="badge warn pulse">Timestamp pending</span>
          )}
        </div>

        <div className="stack-sm">
          <span className="muted">Video fingerprint (SHA-256)</span>
          <div className="hash-chip mono" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ flex: 1 }}>{record.hash}</span>
            <button
              onClick={() => {
                void navigator.clipboard
                  .writeText(record.hash)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  })
                  .catch(() => {});
              }}
              aria-label={copied ? "Fingerprint copied" : "Copy fingerprint"}
              title="Copy fingerprint"
              style={{
                appearance: "none",
                background: "transparent",
                border: "none",
                color: copied ? "var(--ok)" : "var(--muted)",
                cursor: "pointer",
                padding: 2,
                display: "inline-flex",
                flex: "none",
              }}
            >
              {copied ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="9" y="9" width="12" height="12" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          </div>
        </div>

        <dl>
          <div className="kv">
            <dt>{record.source === "library" ? "Received" : "Recorded"}</dt>
            <dd>{new Date(record.clientTime).toLocaleString()}</dd>
          </div>
        </dl>

        {up.status === "complete" ? (
          up.verified ? (
            <span className="badge ok">Uploaded — bytes match the certified fingerprint</span>
          ) : (
            <span className="badge danger">Uploaded, but hash mismatch — not verified</span>
          )
        ) : blobMissing ? (
          <p className="muted">
            The video isn&apos;t stored on this device. Open this report on the
            device that recorded it to finish the upload.
          </p>
        ) : (
          <div className="stack-sm">
            <div className="row">
              <span className="muted">Uploading video</span>
              <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>{pct}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill active" style={{ width: `${pct}%` }} />
            </div>
            <p className="muted">
              Safe to keep this page open through connection drops — the upload
              resumes automatically.
            </p>
          </div>
        )}
        {uploadError && <p className="muted" style={{ color: "var(--danger)" }}>{uploadError}</p>}

        {record.source === "library" && (
          <p className="muted">
            This timestamp proves when the video was received — not when it was
            filmed.
          </p>
        )}
      </section>

      {record.segments && record.segments.length > 0 && (
        <section className="card">
          <span className="section-label">Coverage</span>
          <dl>
            <div className="kv">
              <dt>Areas covered</dt>
              <dd>{record.segments.length}</dd>
            </div>
            {record.durationMs ? (
              <div className="kv">
                <dt>Total duration</dt>
                <dd>{Math.round(record.durationMs / 1000)} s</dd>
              </div>
            ) : null}
          </dl>
        </section>
      )}

      {(record.quality?.warnings.length ?? 0) > 0 && (
        <section className="card">
          <div className="row">
            <span className="section-label">Capture quality</span>
            <span className="badge warn">
              {record.quality!.warnings.length} warning{record.quality!.warnings.length === 1 ? "" : "s"}
            </span>
          </div>
          {record.quality!.warnings.map((w) => (
            <p key={w} className="muted" style={{ color: "var(--warn)" }}>
              ⚠ {w}
            </p>
          ))}
        </section>
      )}

      {record.upload.verified === true &&
        record.analysis?.status === "complete" &&
        record.tsa.status === "granted" && (
          <div className="stack-sm">
            <a href={`/api/capture/${id}/report`} className="btn btn-primary">
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 4v12m0 0 4-4m-4 4-4-4" />
                <path d="M4 20h16" />
              </svg>
              Download signed PDF report
            </a>
            <p className="muted" style={{ textAlign: "center" }}>
              Tamper-evident PDF — anyone can check it, no account needed.
            </p>
          </div>
        )}
    </main>
  );
}

function formatPts(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** " · ~40 s left" estimated from elapsed time vs progress; empty until
 * there's enough signal to extrapolate honestly. */
function analysisEta(analysis?: CaptureRecord["analysis"]): string {
  if (!analysis?.startedAt || !analysis.progress || analysis.progress < 0.05) return "";
  const elapsed = (Date.now() - Date.parse(analysis.startedAt)) / 1000;
  if (elapsed < 5) return "";
  const remaining = Math.round((elapsed * (1 - analysis.progress)) / analysis.progress);
  if (remaining < 3) return "";
  return remaining < 90 ? ` · ~${remaining} s left` : ` · ~${Math.round(remaining / 60)} min left`;
}
