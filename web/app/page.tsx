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
    <main className="container">
      <div>
        <h1>Walkaround Inspector</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          Upload a slow walkaround video of the car. We fingerprint and
          timestamp it the moment you pick it, then find scratches, dents,
          and stains automatically — reflections filtered out.
        </p>
      </div>

      <Link href="/upload" className="btn btn-primary">
        Upload walkaround video
      </Link>
      <p className="muted">
        Tip: upload before you drive off — the certified timestamp proves the
        video existed right then.
      </p>

      {pending.length > 0 && (
        <section className="card">
          <h2>Interrupted uploads</h2>
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
          {recoverError && <p style={{ color: "var(--danger)" }}>{recoverError}</p>}
        </section>
      )}

      <p className="muted" style={{ marginTop: "auto" }}>
        Add this app to your home screen so it&apos;s one tap away at the
        rental lot.
      </p>
    </main>
  );
}
