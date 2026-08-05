"use client";

// Home: start a walkaround, resume interrupted uploads, or (secondary path)
// upload an existing video from the library.
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
          Record a slow lap of the car before you drive off. The video&apos;s
          fingerprint is timestamped the moment you stop recording — proof of
          its condition, even if the report comes later.
        </p>
      </div>

      <Link href="/record" className="btn btn-primary">
        Start walkaround
      </Link>

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

      <section className="card">
        <h2>Already have a video?</h2>
        <p className="muted">
          You can upload one from your library, but its timestamp will prove
          when we <em>received</em> it — not when it was filmed. Recording in
          the app is the strong evidence.
        </p>
        <Link href="/upload" className="btn btn-ghost">
          Upload from library
        </Link>
      </section>

      <p className="muted" style={{ marginTop: "auto" }}>
        Tip: add this app to your home screen so it&apos;s one tap away at the
        rental lot. Recording works offline — uploads wait for signal.
      </p>
    </main>
  );
}
