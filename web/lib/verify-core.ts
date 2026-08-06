// Signed-report verification. Isomorphic — runs entirely in the browser on
// /verify (the PDF never leaves the user's machine) and in Node for the CLI
// harness. Mirrors lib/server/report.ts: recompute the digest of everything
// outside the windows, check the ECDSA signature, check both RFC 3161
// tokens' message imprints, and re-derive all three windows byte-for-byte.

import { parseTimeStampResp, type TstInfo } from "./der";
import {
  canonicalPayload,
  decodeWindows,
  deriveWindowA,
  deriveWindowB,
  deriveWindowC,
  fromB64url,
  hexToB64url,
  isoSeconds,
  signatureMessage,
  type ReportSigInputs,
} from "./sig-format";

export interface Check {
  id: string;
  label: string;
  pass: boolean;
  /** Advisory checks inform but don't fail the verdict. */
  advisory?: boolean;
  detail?: string;
}

export interface VerifyExtracted {
  captureId?: string;
  videoHashHex?: string;
  source?: string;
  captureTime?: string;
  reportTime?: string;
  pubB64?: string;
  digestHex?: string;
  captureTst?: TstInfo | null;
  reportTst?: TstInfo | null;
  reportTsrHex?: string;
  captureTsrHex?: string;
}

export interface VerifyResult {
  valid: boolean;
  checks: Check[];
  extracted: VerifyExtracted;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function extractOnce(latin1: string, re: RegExp, what: string): string | null {
  const first = re.exec(latin1);
  if (!first) return null;
  if (re.exec(latin1)) throw new Error(`${what} appears more than once`);
  return first[1];
}

export async function verifyReport(
  bytes: Uint8Array,
  publishedPubB64?: string | null
): Promise<VerifyResult> {
  const checks: Check[] = [];
  const extracted: VerifyExtracted = {};
  const fail = (partial?: Partial<VerifyResult>): VerifyResult => ({
    valid: false,
    checks,
    extracted,
    ...partial,
  });

  const latin1 = new TextDecoder("latin1").decode(bytes);

  // 1. Windows record.
  let ranges: Array<[number, number]> | null = null;
  try {
    const field = extractOnce(
      latin1,
      /\/WAIWindows \((\d{10} \d{10} \d{10} \d{10} \d{10} \d{10})\)/g,
      "/WAIWindows"
    );
    ranges = field ? decodeWindows(field) : null;
    if (ranges && ranges[2][1] > bytes.length) ranges = null;
  } catch (err) {
    checks.push({ id: "structure", label: "Signed-report structure", pass: false, detail: (err as Error).message });
    return fail();
  }
  checks.push({
    id: "structure",
    label: "Signed-report structure (/WAIWindows record)",
    pass: ranges !== null,
    detail: ranges ? undefined : "This does not look like a Walkaround Inspector signed report.",
  });
  if (!ranges) return fail();

  // 2. Digest of everything outside the windows.
  const total = bytes.length - ranges.reduce((s, [a, b]) => s + (b - a), 0);
  const outside = new Uint8Array(total);
  let src = 0;
  let dst = 0;
  for (const [start, end] of ranges) {
    outside.set(bytes.subarray(src, start), dst);
    dst += start - src;
    src = end;
  }
  outside.set(bytes.subarray(src), dst);
  const digestHex = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", outside)));
  extracted.digestHex = digestHex;

  // 3. Signed fields.
  let videoHashHex: string | null, pubB64: string | null, captureId: string | null;
  let captureTime: string | null, source: string | null, captureTsrHex: string | null;
  try {
    videoHashHex = extractOnce(latin1, /\/VideoHash \(([0-9a-f]{64})\)/g, "/VideoHash");
    pubB64 = extractOnce(latin1, /\/PubKey \(([A-Za-z0-9_-]{87})\)/g, "/PubKey");
    captureId = extractOnce(latin1, /\/CaptureId \(([0-9a-f-]{36})\)/g, "/CaptureId");
    captureTime = extractOnce(latin1, /\/CaptureTime \(([0-9TZ:-]{20})\)/g, "/CaptureTime");
    source = extractOnce(latin1, /\/Source \((recorded|library)\)/g, "/Source");
    captureTsrHex = extractOnce(latin1, /\/CaptureTSR <([0-9A-Fa-f]*)>/g, "/CaptureTSR");
  } catch (err) {
    checks.push({ id: "fields", label: "Verification fields", pass: false, detail: (err as Error).message });
    return fail();
  }
  const fieldsOk = !!(videoHashHex && pubB64 && captureId && captureTime && source);
  checks.push({ id: "fields", label: "Verification fields present", pass: fieldsOk });
  if (!fieldsOk) return fail();
  Object.assign(extracted, { videoHashHex, pubB64, captureId, captureTime, source, captureTsrHex: captureTsrHex ?? undefined });

  // 4. Machine payload (Window C — identified by length).
  const byLen = new Map(ranges.map((r) => [r[1] - r[0], r]));
  const dummy: ReportSigInputs = {
    captureId: captureId!,
    videoHashHex: videoHashHex!,
    digestHex,
    tsrDigestHex: digestHex,
    sigB64: "A".repeat(86),
    pubB64: pubB64!,
    captureTimeIso: captureTime!,
    reportTimeIso: captureTime!,
  };
  const lenA = deriveWindowA(canonicalPayload(dummy)).length;
  const lenB = deriveWindowB(dummy).length;
  const lenC = deriveWindowC(dummy, "").length;
  const rangeA = byLen.get(lenA);
  const rangeB = byLen.get(lenB);
  const rangeC = byLen.get(lenC);
  if (!rangeA || !rangeB || !rangeC) {
    checks.push({ id: "windows-shape", label: "Window sizes", pass: false, detail: "Reserved window sizes don't match this format version." });
    return fail();
  }

  const winCText = new TextDecoder("latin1").decode(bytes.subarray(rangeC[0], rangeC[1]));
  const payloadMatch = /^WAI-SIG-PAYLOAD\/1\n(\{.*\})\nTSR:([0-9A-Fa-f]*) *\n$/.exec(winCText);
  let payload: Record<string, string> | null = null;
  try {
    payload = payloadMatch ? JSON.parse(payloadMatch[1]) : null;
  } catch {
    payload = null;
  }
  checks.push({ id: "payload", label: "Machine payload parses", pass: !!payload });
  if (!payload || !payloadMatch) return fail();
  const reportTsrHex = payloadMatch[2].toLowerCase();
  extracted.reportTsrHex = reportTsrHex;
  extracted.reportTime = payload.rt;
  const tsrDigestHex = bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", hexToBytes(reportTsrHex) as BufferSource))
  );

  // 5. Payload consistency with the signed fields + computed digests.
  const consistent =
    payload.cid === captureId &&
    payload.vh === hexToB64url(videoHashHex!) &&
    payload.pub === pubB64 &&
    payload.ct === captureTime &&
    payload.dg === hexToB64url(digestHex) &&
    payload.th === hexToB64url(tsrDigestHex);
  checks.push({
    id: "consistency",
    label: "Payload matches signed fields and recomputed digests",
    pass: consistent,
    detail: consistent ? undefined : "The machine payload disagrees with the document contents — the file was modified.",
  });

  // 6. ECDSA signature over digest‖SHA-256(report token) — covers every
  // byte outside the windows AND the embedded timestamp token.
  let sigOk = false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      fromB64url(payload.pub) as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    sigOk = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromB64url(payload.sig) as BufferSource,
      signatureMessage(digestHex, tsrDigestHex) as BufferSource
    );
  } catch {
    sigOk = false;
  }
  checks.push({
    id: "signature",
    label: "ECDSA P-256 signature over the document and its timestamp token",
    pass: sigOk,
    detail: sigOk ? undefined : "Signature verification failed — the document does not match its signature.",
  });

  // 7. Published-key comparison (advisory: proves WHO signed, not integrity).
  if (publishedPubB64) {
    checks.push({
      id: "known-key",
      label: "Signed by the published Walkaround Inspector key",
      pass: payload.pub === publishedPubB64,
      advisory: true,
      detail: payload.pub === publishedPubB64 ? undefined : "Signed by a different key than the one this service publishes.",
    });
  }

  // 8. Report RFC 3161 token binds the digest at a point in time.
  const reportTst = reportTsrHex ? parseTimeStampResp(hexToBytes(reportTsrHex)) : null;
  extracted.reportTst = reportTst?.tstInfo ?? null;
  const reportTokenOk =
    !!reportTst && (reportTst.status === 0 || reportTst.status === 1) && reportTst.tstInfo?.hashedMessageHex === digestHex;
  checks.push({
    id: "report-token",
    label: "Report timestamp token matches the document digest",
    pass: reportTokenOk,
    detail: reportTst?.tstInfo?.genTime ? `Token time: ${reportTst.tstInfo.genTime}` : "Token missing or imprint mismatch.",
  });

  // 9. Capture token binds the VIDEO hash, at or before the report time.
  const captureTst = captureTsrHex ? parseTimeStampResp(hexToBytes(captureTsrHex)) : null;
  extracted.captureTst = captureTst?.tstInfo ?? null;
  const captureImprintOk =
    !!captureTst && (captureTst.status === 0 || captureTst.status === 1) && captureTst.tstInfo?.hashedMessageHex === videoHashHex;
  const ordered =
    !!captureTst?.tstInfo?.genTime &&
    !!reportTst?.tstInfo?.genTime &&
    isoSeconds(captureTst.tstInfo.genTime) <= isoSeconds(reportTst.tstInfo.genTime);
  checks.push({
    id: "capture-token",
    label: "Capture timestamp token matches the video fingerprint",
    pass: captureImprintOk,
    detail: captureTst?.tstInfo?.genTime ? `Token time: ${captureTst.tstInfo.genTime}` : "Token missing or imprint mismatch.",
  });
  checks.push({
    id: "time-order",
    label: "Capture token predates the report token",
    pass: ordered,
  });

  // 10. Re-derive all three windows and compare byte-for-byte.
  let windowsOk = false;
  try {
    const inputs: ReportSigInputs = {
      captureId: payload.cid,
      videoHashHex: videoHashHex!,
      digestHex,
      tsrDigestHex,
      sigB64: payload.sig,
      pubB64: payload.pub,
      captureTimeIso: payload.ct,
      reportTimeIso: payload.rt,
    };
    windowsOk =
      equalBytes(deriveWindowA(canonicalPayload(inputs)), bytes.subarray(rangeA[0], rangeA[1])) &&
      equalBytes(deriveWindowB(inputs), bytes.subarray(rangeB[0], rangeB[1])) &&
      equalBytes(deriveWindowC(inputs, payloadMatch[2]), bytes.subarray(rangeC[0], rangeC[1]));
  } catch {
    windowsOk = false;
  }
  checks.push({
    id: "windows",
    label: "QR code and printed signature panel match the cryptographic values",
    pass: windowsOk,
    detail: windowsOk ? undefined : "The printed/scannable panel does not match the signed values.",
  });

  const valid = checks.every((c) => c.advisory || c.pass);
  return { valid, checks, extracted };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
