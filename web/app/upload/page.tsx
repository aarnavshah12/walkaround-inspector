"use client";

// Primary flow (upload-and-go): pick a walkaround video → probe + sanity
// warnings → SHA-256 in browser → immediate hash-timestamp POST (tiny,
// lands before the big transfer) → report page handles the resumable upload
// and automatic analysis. `source: library` is recorded end-to-end; the
// timestamp honestly proves receipt time.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { sha256Hex } from "../../lib/hash";
import { savePendingVideo } from "../../lib/blob-store";
import { registerCapture } from "../../lib/capture-client";
import { MIN_HEIGHT_PX, MIN_WALKAROUND_MS } from "../../lib/coach";

type Step = "idle" | "probing" | "hashing" | "registering" | "error";

const SECURING_STEPS = [
  {
    title: "Read",
    detail: "Duration and resolution are checked so quality issues surface before you leave the lot.",
  },
  {
    title: "Fingerprint",
    detail: "A SHA-256 hash of the exact file is computed right here in your browser.",
  },
  {
    title: "Certify",
    detail: "The fingerprint is timestamped by the server — before the upload even starts.",
  },
] as const;

export default function UploadPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function onFile(file: File) {
    try {
      setStep("probing");
      const probe = await probeVideo(file);

      setStep("hashing");
      const hash = await sha256Hex(file);

      const warnings: string[] = [];
      if (probe.durationMs !== undefined && probe.durationMs < MIN_WALKAROUND_MS) {
        warnings.push("Short video — a slow, full lap (45 s+) catches far more.");
      }
      if (probe.height !== undefined && probe.height < MIN_HEIGHT_PX) {
        warnings.push(`Low resolution (${probe.height}p) — small scratches may not be visible.`);
      }

      setStep("registering");
      const record = await registerCapture({
        hash,
        clientTime: new Date().toISOString(),
        source: "library",
        mime: file.type || "video/mp4",
        durationMs: probe.durationMs,
        sizeBytes: file.size,
        quality: { width: probe.width, height: probe.height, warnings },
      });

      await savePendingVideo({
        captureId: record.id,
        blob: file,
        mime: file.type || "video/mp4",
        size: file.size,
        createdAt: record.createdAt,
        source: "library",
        registered: true,
      });

      router.push(`/report/${record.id}`);
    } catch (err) {
      setErrorMsg((err as Error).message);
      setStep("error");
    }
  }

  const busy = step === "probing" || step === "hashing" || step === "registering";

  // Render-only mapping of the existing `step` state onto the three
  // securing rows: -1 = not started (idle/error), 0..2 = current phase.
  const phase =
    step === "probing" ? 0 : step === "hashing" ? 1 : step === "registering" ? 2 : -1;

  return (
    <main className="container fade-stagger">
      <section className="hero">
        <span className="section-label">New inspection</span>
        <h1>
          Pick the video.
          <br />
          <span className="grad-text">We secure the rest.</span>
        </h1>
        <p className="lede">
          Your walkaround is fingerprinted and timestamp-certified the moment
          you choose it. Then it uploads in resumable chunks that survive bad
          signal, and damage analysis starts on its own.
        </p>
      </section>

      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
        }}
      />

      <button
        className="btn btn-primary"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {step === "idle" || step === "error" ? (
          <>
            <svg
              className="icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M12 16V4m0 0 4 4m-4-4-4 4" />
              <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
            </svg>
            Choose a video
          </>
        ) : step === "probing" ? (
          "Reading video…"
        ) : step === "hashing" ? (
          "Computing fingerprint…"
        ) : (
          "Certifying timestamp…"
        )}
      </button>

      <p className="muted" style={{ textAlign: "center" }}>
        Upload before you drive off — the certified timestamp proves this
        exact video existed right then.
      </p>

      <section className="card" aria-live="polite">
        <div className="row">
          <span className="section-label">Securing your video</span>
          {busy ? (
            <span className="badge pulse">In progress</span>
          ) : (
            <span className="badge">Automatic</span>
          )}
        </div>

        {busy && (
          <div className="progress-track" aria-hidden>
            <div
              className="progress-fill active"
              style={{ width: `${18 + phase * 34}%` }}
            />
          </div>
        )}

        {SECURING_STEPS.map((s, i) => {
          const state = phase === -1 ? "" : i < phase ? " done" : i === phase ? " active" : "";
          return (
            <div className="step-row" key={s.title}>
              <span className={`step-icon${state}`} aria-hidden>
                {state === " done" ? (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <p className="muted">
                <strong style={{ color: "var(--text-2)" }}>{s.title}</strong> — {s.detail}
              </p>
            </div>
          );
        })}
      </section>

      {step === "error" && (
        <section className="card" role="alert">
          <div className="row">
            <span className="section-label">Upload not started</span>
            <span className="badge danger">Error</span>
          </div>
          <p className="muted">Could not process the video: {errorMsg}</p>
          <p className="muted">The video was not uploaded — choose it again to retry.</p>
        </section>
      )}
    </main>
  );
}

function probeVideo(
  file: File
): Promise<{ durationMs?: number; width?: number; height?: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    const cleanup = () => URL.revokeObjectURL(url);
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      const durationMs = Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : undefined;
      resolve({ durationMs, width: v.videoWidth || undefined, height: v.videoHeight || undefined });
      cleanup();
    };
    v.onerror = () => {
      resolve({}); // metadata is best-effort; the upload still proceeds
      cleanup();
    };
    v.src = url;
  });
}
