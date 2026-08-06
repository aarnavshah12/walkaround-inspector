"use client";

// Public verifier. Verification runs ENTIRELY in this browser — the PDF is
// never uploaded anywhere. The only network request is fetching the
// published signing key (and the page still works without it, minus the
// known-key check).

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { verifyReport, type VerifyResult } from "../../lib/verify-core";

export default function VerifyPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [publishedKey, setPublishedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [fileName, setFileName] = useState("");

  useEffect(() => {
    fetch("/api/public-key")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setPublishedKey(d.raw_b64url))
      .catch(() => {});
  }, []);

  async function onFile(file: File) {
    setBusy(true);
    setFileName(file.name);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setResult(await verifyReport(bytes, publishedKey));
    } catch (err) {
      setResult({
        valid: false,
        checks: [{ id: "read", label: "Read file", pass: false, detail: (err as Error).message }],
        extracted: {},
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container">
      <h1>Verify a report</h1>
      <p className="muted">
        Drop in a Walkaround Inspector PDF to check its cryptographic
        integrity. Verification happens entirely on your device — the file is
        never uploaded.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
        }}
      />
      <button className="btn btn-primary" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? "Verifying…" : "Choose a PDF report"}
      </button>

      {result && (
        <>
          <section className="card">
            <div className="row">
              <h2>{fileName}</h2>
              {result.valid ? (
                <span className="badge ok">✓ VERIFIED</span>
              ) : (
                <span className="badge danger">✗ FAILED</span>
              )}
            </div>
            <ul className="plain">
              {result.checks.map((c) => (
                <li key={c.id} className="row" style={{ justifyContent: "flex-start", alignItems: "flex-start" }}>
                  <span className={`badge ${c.pass ? "ok" : c.advisory ? "warn" : "danger"}`}>
                    {c.pass ? "✓" : "✗"}
                  </span>
                  <span>
                    {c.label}
                    {c.detail && <span className="muted"> — {c.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>What this {result.valid ? "proves" : "would have proven"}</h2>
            <p className="muted">
              A PDF with exactly these bytes existed at{" "}
              {result.extracted.reportTst?.genTime ?? "the report token time"}, signed by the key
              shown. It attests that a video with fingerprint{" "}
              <span className="mono">{result.extracted.videoHashHex?.slice(0, 16)}…</span> existed at{" "}
              {result.extracted.captureTst?.genTime ?? "the capture token time"}
              {result.extracted.source === "library"
                ? " (uploaded video: this proves when the video was received, not when it was filmed)"
                : " (recorded in-app at that time)"}
              .
            </p>
            <p className="muted">
              Not proven here: the timestamp authority&apos;s certificate chain is displayed, not
              cryptographically validated — for full independence, verify the embedded tokens with
              openssl. AI findings inside the report are assessments, not measurements. This is not
              legal advice.
            </p>
          </section>
        </>
      )}

      <Link href="/" className="btn btn-ghost">
        Home
      </Link>
    </main>
  );
}
