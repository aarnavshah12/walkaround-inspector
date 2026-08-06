"use client";

// Public verifier. Verification runs ENTIRELY in this browser — the PDF is
// never uploaded anywhere. The only network request is fetching the
// published signing key (and the page still works without it, minus the
// known-key check).

import { useEffect, useRef, useState } from "react";
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

  const passCount = result ? result.checks.filter((c) => c.pass).length : 0;
  const ex = result?.extracted;

  return (
    <main className="container fade-stagger">
      <section className="hero">
        <h1>
          Verify a report,
          <br />
          <span className="grad-text">trust the math.</span>
        </h1>
        <p className="lede">
          Drop in a Walkaround Inspector PDF to check its cryptographic
          integrity. Verification happens entirely on your device — the file
          is never uploaded.
        </p>
      </section>

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
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
        {busy ? "Verifying…" : "Choose a PDF report"}
      </button>
      <p className="muted" style={{ textAlign: "center" }}>
        Works offline, too — the signature and timestamps are checked right
        here in your browser.
      </p>

      {!result && (
        <section className="card">
          <span className="section-label">What gets checked</span>
          <div className="step-row">
            <span className="step-icon" aria-hidden>1</span>
            <p className="muted">
              <strong style={{ color: "var(--text-2)" }}>Signature</strong> — the report&apos;s bytes
              match the embedded ECDSA P-256 signature, so nothing was altered.
            </p>
          </div>
          <div className="step-row">
            <span className="step-icon" aria-hidden>2</span>
            <p className="muted">
              <strong style={{ color: "var(--text-2)" }}>Timestamps</strong> — independent authority
              tokens pin when the video and the report existed.
            </p>
          </div>
          <div className="step-row">
            <span className="step-icon" aria-hidden>3</span>
            <p className="muted">
              <strong style={{ color: "var(--text-2)" }}>Fingerprint</strong> — the video&apos;s SHA-256
              recorded at capture is bound into the signed report.
            </p>
          </div>
        </section>
      )}

      {result && (
        <>
          <section
            className="card"
            role="status"
            style={{
              alignItems: "center",
              textAlign: "center",
              gap: 10,
              padding: "32px 20px 26px",
              borderColor: result.valid ? "rgba(52, 211, 153, 0.35)" : "rgba(251, 113, 133, 0.4)",
              background: result.valid
                ? "linear-gradient(180deg, rgba(52, 211, 153, 0.1), rgba(255, 255, 255, 0.03) 70%)"
                : "linear-gradient(180deg, rgba(251, 113, 133, 0.1), rgba(255, 255, 255, 0.03) 70%)",
            }}
          >
            <span
              className={`step-icon ${result.valid ? "done" : "fail"}`}
              style={{ width: 58, height: 58 }}
              aria-hidden
            >
              {result.valid ? (
                <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m5 13 4 4L19 7" />
                </svg>
              ) : (
                <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              )}
            </span>
            <p
              style={{
                fontSize: "1.9rem",
                fontWeight: 800,
                letterSpacing: "0.08em",
                lineHeight: 1.1,
                color: result.valid ? "var(--ok)" : "var(--danger)",
              }}
            >
              {result.valid ? "VERIFIED" : "FAILED"}
            </p>
            <p className="muted" style={{ maxWidth: "38ch" }}>
              <span className="mono" style={{ color: "var(--text-2)" }}>{fileName}</span>
              <br />
              {result.valid
                ? "Cryptographic integrity confirmed."
                : "This file could not be authenticated."}
            </p>
          </section>

          <section className="card">
            <div className="row">
              <span className="section-label">Integrity checks</span>
              <span
                className={`badge ${
                  passCount === result.checks.length ? "ok" : result.valid ? "warn" : "danger"
                }`}
              >
                {passCount}/{result.checks.length} passed
              </span>
            </div>
            <ul className="plain">
              {result.checks.map((c) => {
                const advisoryFail = !c.pass && c.advisory;
                return (
                  <li key={c.id} className="step-row" style={{ alignItems: "flex-start" }}>
                    <span
                      className={`step-icon ${c.pass ? "done" : advisoryFail ? "" : "fail"}`}
                      style={
                        advisoryFail
                          ? {
                              background: "rgba(251, 191, 36, 0.1)",
                              borderColor: "rgba(251, 191, 36, 0.4)",
                              color: "var(--warn)",
                            }
                          : undefined
                      }
                      role="img"
                      aria-label={c.pass ? "Passed" : advisoryFail ? "Advisory" : "Failed"}
                    >
                      {c.pass ? "✓" : advisoryFail ? "!" : "✗"}
                    </span>
                    <div className="stack-sm" style={{ gap: 2, paddingTop: 3 }}>
                      <span style={{ fontWeight: 600, fontSize: "0.92rem" }}>
                        {c.label}
                        {advisoryFail && (
                          <span className="badge warn" style={{ marginLeft: 8, verticalAlign: "middle" }}>
                            advisory
                          </span>
                        )}
                      </span>
                      {c.detail && (
                        <span className="muted" style={{ fontSize: "0.82rem" }}>
                          {c.detail}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="card">
            <span className="section-label">Extracted from the report</span>
            <dl>
              <div className="kv">
                <dt>Video existed at</dt>
                <dd>{ex?.captureTst?.genTime ?? ex?.captureTime ?? "—"}</dd>
              </div>
              <div className="kv">
                <dt>Report signed at</dt>
                <dd>{ex?.reportTst?.genTime ?? ex?.reportTime ?? "—"}</dd>
              </div>
              <div className="kv">
                <dt>Video source</dt>
                <dd>
                  {ex?.source
                    ? ex.source === "library"
                      ? "Uploaded from library"
                      : "Recorded in-app"
                    : "—"}
                </dd>
              </div>
              {ex?.captureId && (
                <div className="kv">
                  <dt>Capture ID</dt>
                  <dd className="mono" style={{ fontSize: "0.76rem" }}>{ex.captureId}</dd>
                </div>
              )}
            </dl>
            {ex?.videoHashHex && (
              <div className="stack-sm">
                <span className="section-label" style={{ fontSize: "0.66rem" }}>
                  Video fingerprint · SHA-256
                </span>
                <span className="hash-chip mono">{ex.videoHashHex}</span>
              </div>
            )}
          </section>

          <section className="card">
            <span className="section-label">
              What this {result.valid ? "proves" : "would have proven"}
            </span>
            <div className="card-nested">
              <p className="muted" style={{ color: "var(--text-2)" }}>
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
            </div>
            <p className="muted">
              Not proven here: the timestamp authority&apos;s certificate chain is displayed, not
              cryptographically validated — for full independence, verify the embedded tokens with
              openssl. AI findings inside the report are assessments, not measurements. This is not
              legal advice.
            </p>
          </section>
        </>
      )}
    </main>
  );
}
