"use client";

// Home: upload-and-go. Pick a walkaround video; fingerprinting,
// timestamping, upload, and damage analysis all happen automatically.
// (The in-app guided recording flow still exists at /record but is hidden
// from the UI for now — owner decision 2026-08-05.)
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { listPendingVideos, type PendingVideo } from "../lib/blob-store";
import { recoverPendingVideo } from "../lib/capture-client";

export default function HomePage() {
  const router = useRouter();
  const [pending, setPending] = useState<PendingVideo[]>([]);
  const [recovering, setRecovering] = useState<string | null>(null);
  const [recoverError, setRecoverError] = useState("");

  useEffect(() => {
    listPendingVideos()
      .then(setPending)
      .catch(() => {});
  }, []);

  async function finishSecuring(p: PendingVideo) {
    setRecovering(p.captureId);
    setRecoverError("");
    try {
      const serverId = await recoverPendingVideo(p);
      router.push(`/report/${serverId}`);
    } catch (err) {
      setRecoverError((err as Error).message);
      setRecovering(null);
    }
  }

  return (
    <main className="container fade-stagger">
      <section className="hero">
        <h1>
          Proof of condition,
          <br />
          <span className="grad-text">before you drive off.</span>
        </h1>
        <p className="lede">
          Upload a slow walkaround video of the car. It&apos;s fingerprinted
          and timestamp-certified the moment you pick it — then AI finds the
          scratches, dents, and stains, with reflections filtered out.
        </p>
      </section>

      <Link href="/upload" className="btn btn-primary">
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 16V4m0 0 4 4m-4-4-4 4" />
          <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
        </svg>
        Upload walkaround video
      </Link>
      <p className="muted" style={{ textAlign: "center" }}>
        Upload before you drive off — the certified timestamp proves the video
        existed right then.
      </p>

      {pending.length > 0 && (
        <section className="card">
          <span className="section-label">Interrupted uploads</span>
          <p className="muted">
            These videos are safely stored on this device. Open one to resume
            where it left off.
          </p>
          <ul className="plain">
            {pending.map((p) => {
              const label = `${new Date(p.createdAt).toLocaleString()} · ${(p.size / (1024 * 1024)).toFixed(1)} MB`;
              return (
                <li key={p.captureId}>
                  {p.registered === false ? (
                    <button
                      className="btn"
                      disabled={recovering === p.captureId}
                      onClick={() => void finishSecuring(p)}
                    >
                      {recovering === p.captureId ? "Securing timestamp…" : `${label} — finish securing`}
                    </button>
                  ) : (
                    <Link href={`/report/${p.captureId}`} className="btn">
                      {label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
          {recoverError && <p className="muted" style={{ color: "var(--danger)" }}>{recoverError}</p>}
        </section>
      )}

      <section className="card">
        <span className="section-label">How it works</span>
        <div className="step-row">
          <span className="step-icon done">1</span>
          <p className="muted">
            <strong style={{ color: "var(--text-2)" }}>Fingerprint & certify</strong> — the video&apos;s
            SHA-256 is timestamped by an independent authority before it even uploads.
          </p>
        </div>
        <div className="step-row">
          <span className="step-icon done">2</span>
          <p className="muted">
            <strong style={{ color: "var(--text-2)" }}>Detect & filter</strong> — AI finds damage across
            frames; a physics filter rejects reflections and glare.
          </p>
        </div>
        <div className="step-row">
          <span className="step-icon done">3</span>
          <p className="muted">
            <strong style={{ color: "var(--text-2)" }}>Signed report</strong> — a tamper-evident PDF
            anyone can verify, without trusting us.
          </p>
        </div>
      </section>

      <p className="muted" style={{ marginTop: "auto", textAlign: "center" }}>
        Add to your home screen so it&apos;s one tap away at the rental lot.
      </p>
    </main>
  );
}
