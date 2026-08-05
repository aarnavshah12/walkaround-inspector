"use client";

// Guided walkaround recording. Capture-integrity contract (from the plan):
// the moment recording stops we (1) persist the blob to IndexedDB, (2) hash
// it with WebCrypto, (3) POST {hash, clientTime, ...} — retried until it
// lands — and only then move on to the (much larger) resumable upload on the
// report screen. No live inference in v1.

import { useEffect, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { COACH_SEGMENTS, MIN_HEIGHT_PX, MIN_WALKAROUND_MS } from "../../lib/coach";
import { sha256Hex } from "../../lib/hash";
import { savePendingVideo } from "../../lib/blob-store";
import { registerCapture } from "../../lib/capture-client";
import type { SegmentMark } from "../../lib/types";

const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1", // iOS Safari
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

/** Std-dev of accelerometer magnitude above this reads as heavy shake. */
const SHAKE_STDDEV_WARN = 4.0;

type Phase =
  | "setup"
  | "preview"
  | "recording"
  | "finalizing"
  | "done"
  | "error";

interface FinalizeState {
  step: "saving" | "hashing" | "timestamping" | "secured";
  warnings: string[];
  captureId?: string;
}

export default function RecordPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("setup");
  const [errorMsg, setErrorMsg] = useState("");
  const [segIndex, setSegIndex] = useState(0);
  const [finalize, setFinalize] = useState<FinalizeState | null>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("");
  const recStartRef = useRef(0);
  const segStartRef = useRef(0);
  const segMarksRef = useRef<SegmentMark[]>([]);
  const motionRef = useRef<number[]>([]);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const trackSizeRef = useRef<{ width?: number; height?: number }>({});

  // Live UI clock while recording.
  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [phase]);

  // Release camera on unmount.
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      wakeLockRef.current?.release().catch(() => {});
    };
  }, []);

  async function enableCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      trackSizeRef.current = stream.getVideoTracks()[0]?.getSettings() ?? {};
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setPhase("preview");
    } catch (err) {
      setErrorMsg(
        `Camera unavailable: ${(err as Error).message}. Check camera permission — and note the app needs HTTPS (or localhost).`
      );
      setPhase("error");
    }
  }

  async function startRecording() {
    const stream = streamRef.current;
    if (!stream) return;

    // iOS gates motion data behind a permission that must be requested in a
    // user gesture. Shake detection is best-effort either way.
    try {
      const dme = DeviceMotionEvent as unknown as {
        requestPermission?: () => Promise<string>;
      };
      if (typeof dme.requestPermission === "function") await dme.requestPermission();
    } catch {
      /* no motion data — skip shake heuristic */
    }
    motionRef.current = [];
    window.addEventListener("devicemotion", onMotion);

    try {
      const wl = (navigator as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock;
      if (wl) wakeLockRef.current = await wl.request("screen");
    } catch {
      /* screen may sleep; recording continues */
    }

    const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    mimeRef.current = mime || "video/webm";
    const recorder = new MediaRecorder(stream, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: 8_000_000,
    });
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => void finalizeRecording();
    recorderRef.current = recorder;
    recorder.start(1000);

    recStartRef.current = performance.now();
    segStartRef.current = recStartRef.current;
    segMarksRef.current = [
      { id: COACH_SEGMENTS[0].id, label: COACH_SEGMENTS[0].label, startMs: 0 },
    ];
    setSegIndex(0);
    setPhase("recording");
  }

  function onMotion(e: DeviceMotionEvent) {
    const a = e.accelerationIncludingGravity;
    if (a && a.x != null && a.y != null && a.z != null) {
      motionRef.current.push(Math.hypot(a.x, a.y, a.z));
      if (motionRef.current.length > 4000) motionRef.current.shift();
    }
  }

  function nextSegment() {
    const next = segIndex + 1;
    if (next >= COACH_SEGMENTS.length) {
      stopRecording();
      return;
    }
    const startMs = performance.now() - recStartRef.current;
    segMarksRef.current.push({
      id: COACH_SEGMENTS[next].id,
      label: COACH_SEGMENTS[next].label,
      startMs: Math.round(startMs),
    });
    segStartRef.current = performance.now();
    setSegIndex(next);
  }

  function stopRecording() {
    window.removeEventListener("devicemotion", onMotion);
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    setPhase("finalizing");
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }

  function shakeStdDev(): number | null {
    const xs = motionRef.current;
    if (xs.length < 50) return null;
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
    return Math.sqrt(variance);
  }

  async function finalizeRecording() {
    const durationMs = Math.round(performance.now() - recStartRef.current);
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    chunksRef.current = [];

    const warnings: string[] = [];
    if (durationMs < MIN_WALKAROUND_MS) warnings.push("Short walkaround — a slow, full lap (45 s+) catches far more.");
    const { height } = trackSizeRef.current;
    if (height && height < MIN_HEIGHT_PX) warnings.push(`Low resolution (${height}p) — small scratches may not be visible.`);
    const shake = shakeStdDev();
    if (shake !== null && shake > SHAKE_STDDEV_WARN) warnings.push("Heavy camera shake detected — move more slowly next time.");
    if (segMarksRef.current.length < COACH_SEGMENTS.length) {
      warnings.push(`Walkaround incomplete — ${segMarksRef.current.length} of ${COACH_SEGMENTS.length} areas covered.`);
    }

    try {
      setFinalize({ step: "hashing", warnings });
      const hash = await sha256Hex(blob);
      const clientTime = new Date().toISOString();

      setFinalize({ step: "timestamping", warnings });
      // Retries until connectivity allows — the tiny POST is the part that
      // must land; the blob is safe locally regardless.
      const record = await registerCapture({
        hash,
        clientTime,
        source: "recorded",
        mime: blob.type,
        durationMs,
        sizeBytes: blob.size,
        segments: segMarksRef.current,
        quality: { ...trackSizeRef.current, warnings },
      });

      setFinalize({ step: "saving", warnings, captureId: record.id });
      await savePendingVideo({
        captureId: record.id,
        blob,
        mime: blob.type,
        size: blob.size,
        createdAt: clientTime,
        source: "recorded",
      });

      setFinalize({ step: "secured", warnings, captureId: record.id });
      setPhase("done");
      if (warnings.length === 0) router.push(`/report/${record.id}`);
    } catch (err) {
      setErrorMsg(`Could not secure the recording: ${(err as Error).message}`);
      setPhase("error");
    }
  }

  const seg = COACH_SEGMENTS[segIndex];
  const segElapsed = phase === "recording" ? performance.now() - segStartRef.current : 0;
  const segReady = segElapsed >= seg.minMs;
  const totalElapsed = phase === "recording" ? performance.now() - recStartRef.current : 0;
  const isLast = segIndex === COACH_SEGMENTS.length - 1;

  return (
    <main className="container">
      <h1>Record walkaround</h1>

      {(phase === "setup" || phase === "preview" || phase === "recording") && (
        <div className="video-frame">
          <video ref={videoRef} muted playsInline autoPlay />
          {phase === "recording" && (
            <>
              <div className="rec-pill">
                <span className="rec-dot" />
                {formatMs(totalElapsed)}
              </div>
              <div className="coach-overlay">
                <div className="row">
                  <strong>
                    {segIndex + 1}/{COACH_SEGMENTS.length} · {seg.label}
                  </strong>
                  <span className="dots">
                    {COACH_SEGMENTS.map((s, i) => (
                      <span
                        key={s.id}
                        className={`dot ${i < segIndex ? "done" : i === segIndex ? "now" : ""}`}
                      />
                    ))}
                  </span>
                </div>
                <span className="muted" style={{ color: "#d8d5e6" }}>{seg.hint}</span>
                <div className="progress-track">
                  <div
                    className={`progress-fill ${segReady ? "ok" : ""}`}
                    style={{ width: `${Math.min(100, (segElapsed / seg.minMs) * 100)}%` }}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {phase === "setup" && (
        <>
          <p className="muted">
            You&apos;ll be guided around the car area by area. Walk slowly and
            keep the panels filling the frame.
          </p>
          <button className="btn btn-primary" onClick={enableCamera}>
            Enable camera
          </button>
        </>
      )}

      {phase === "preview" && (
        <>
          <p className="muted">
            Step back until the whole car is in frame, then start. Recording
            works offline — the upload waits for signal.
          </p>
          <button className="btn btn-primary" onClick={startRecording}>
            Start recording
          </button>
        </>
      )}

      {phase === "recording" && (
        <>
          <button className="btn btn-primary" onClick={nextSegment} disabled={!segReady}>
            {isLast ? "Finish walkaround" : segReady ? `Next: ${COACH_SEGMENTS[segIndex + 1].label}` : "Keep filming this area…"}
          </button>
          <button className="btn btn-ghost" onClick={stopRecording}>
            Stop early
          </button>
        </>
      )}

      {(phase === "finalizing" || phase === "done") && finalize && (
        <section className="card">
          <h2>Securing your evidence</h2>
          <FinalizeRow label="Video saved on this device" done={finalize.step !== "hashing"} active={finalize.step === "saving"} />
          <FinalizeRow label="Fingerprint (SHA-256) computed" done={["timestamping", "saving", "secured"].includes(finalize.step)} active={finalize.step === "hashing"} />
          <FinalizeRow label="Fingerprint timestamped" done={["saving", "secured"].includes(finalize.step)} active={finalize.step === "timestamping"} />
          {finalize.warnings.length > 0 && (
            <div>
              {finalize.warnings.map((w) => (
                <p key={w} className="muted" style={{ color: "var(--warn)" }}>⚠ {w}</p>
              ))}
            </div>
          )}
          {phase === "done" && finalize.captureId && (
            <>
              <button className="btn btn-primary" onClick={() => router.push(`/report/${finalize.captureId}`)}>
                Continue to report &amp; upload
              </button>
              {finalize.warnings.length > 0 && (
                <button className="btn btn-ghost" onClick={() => window.location.reload()}>
                  Re-record instead
                </button>
              )}
            </>
          )}
        </section>
      )}

      {phase === "error" && (
        <section className="card">
          <p style={{ color: "var(--danger)" }}>{errorMsg}</p>
          <button className="btn" onClick={() => window.location.reload()}>
            Try again
          </button>
        </section>
      )}
    </main>
  );
}

function FinalizeRow({ label, done, active }: { label: string; done: boolean; active: boolean }) {
  return (
    <div className="row" style={{ justifyContent: "flex-start" }}>
      <span className={`badge ${done ? "ok" : ""}`}>{done ? "✓" : active ? "…" : "·"}</span>
      <span className={done ? "" : "muted"}>{label}</span>
    </div>
  );
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
