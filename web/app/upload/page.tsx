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

  return (
    <main className="container">
      <h1>New inspection</h1>

      <p className="muted">
        Pick your walkaround video. Everything after that is automatic:
        it&apos;s fingerprinted (SHA-256) and timestamp-certified before the
        upload even starts, uploads in resumable chunks that survive bad
        signal, and damage analysis begins the moment the upload lands.
      </p>

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
      <button className="btn btn-primary" disabled={busy} onClick={() => inputRef.current?.click()}>
        {step === "idle" || step === "error"
          ? "Choose a video"
          : step === "probing"
            ? "Reading video…"
            : step === "hashing"
              ? "Computing fingerprint…"
              : "Certifying timestamp…"}
      </button>

      <p className="muted">
        The certified timestamp proves this exact video existed when you
        uploaded it — so upload before you drive off.
      </p>

      {step === "error" && (
        <p style={{ color: "var(--danger)" }}>Could not process the video: {errorMsg}</p>
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
