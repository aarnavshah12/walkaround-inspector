// Signed-report generation: layout → locate windows → sign everything
// outside them → RFC 3161 timestamp the digest → fill the windows with
// derived bytes. See lib/sig-format.ts for the byte contract the verifier
// re-derives against.

import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { DATA_DIR } from "./config";
import { readCapture, updateCapture } from "./store";
import { findingsPath } from "./analysis";
import { fetchTimestampToken, tokenPath } from "./tsa";
import { getSignerInfo, signBytes } from "./signer";
import { layoutReportPdf } from "./pdf";
import { parseTimeStampResp, toHex } from "../der";
import type { FindingsReport } from "../types";
import {
  SENTINEL_A,
  SENTINEL_B,
  SENTINEL_C,
  canonicalPayload,
  deriveWindowA,
  deriveWindowB,
  deriveWindowC,
  dummyInputs,
  encodeWindows,
  isoSeconds,
  toB64url,
  type ReportSigInputs,
} from "../sig-format";

export class TsaUnavailableError extends Error {}

export function reportPath(captureId: string): string {
  return path.join(DATA_DIR, "captures", captureId, "report.pdf");
}

function locateSentinel(bytes: Uint8Array, sentinel: string): number {
  const needle = new TextEncoder().encode(sentinel);
  let found = -1;
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    if (found !== -1) throw new Error(`Sentinel ${sentinel} occurs more than once`);
    found = i;
  }
  if (found === -1) throw new Error(`Sentinel ${sentinel} not found`);
  return found;
}

/** Concatenate everything outside the (sorted, disjoint) windows. */
function outsideBytes(bytes: Uint8Array, ranges: Array<[number, number]>): Uint8Array {
  const total = bytes.length - ranges.reduce((s, [a, b]) => s + (b - a), 0);
  const out = new Uint8Array(total);
  let src = 0;
  let dst = 0;
  for (const [start, end] of ranges) {
    out.set(bytes.subarray(src, start), dst);
    dst += start - src;
    src = end;
  }
  out.set(bytes.subarray(src), dst);
  return out;
}

const inFlight = new Map<string, Promise<string>>();

/** Generate (or return the in-flight generation of) the signed report.
 * Returns the path to report.pdf. Preconditions are the route's job. */
export function generateSignedReport(captureId: string): Promise<string> {
  const existing = inFlight.get(captureId);
  if (existing) return existing;
  const task = generate(captureId).finally(() => inFlight.delete(captureId));
  inFlight.set(captureId, task);
  return task;
}

async function generate(captureId: string): Promise<string> {
  const capture = await readCapture(captureId);
  if (!capture) throw new Error("Capture not found");
  const report = JSON.parse(await fs.readFile(findingsPath(captureId), "utf8")) as FindingsReport;
  const captureTsr = await fs.readFile(tokenPath(captureId)).catch(() => null);

  const signer = await getSignerInfo();
  if (!signer.available) throw new Error(signer.reason);

  const cropsDir = path.join(DATA_DIR, "captures", captureId, "crops");
  const { bytes, captureTimeIso } = await layoutReportPdf(
    capture,
    report,
    cropsDir,
    captureTsr ? new Uint8Array(captureTsr) : null,
    signer.publicKeyB64
  );

  // Locate the three windows (each sentinel exactly once) and record their
  // ranges into the signed /WAIWindows field.
  const dummy = dummyInputs();
  const lens = {
    a: deriveWindowA(canonicalPayload(dummy)).length,
    b: deriveWindowB(dummy).length,
    c: deriveWindowC(dummy, "").length,
  };
  const winA: [number, number] = [locateSentinel(bytes, SENTINEL_A), 0];
  const winB: [number, number] = [locateSentinel(bytes, SENTINEL_B), 0];
  const winC: [number, number] = [locateSentinel(bytes, SENTINEL_C), 0];
  winA[1] = winA[0] + lens.a;
  winB[1] = winB[0] + lens.b;
  winC[1] = winC[0] + lens.c;
  const ranges = [winA, winB, winC].sort((x, y) => x[0] - y[0]);

  const latin1 = new TextDecoder("latin1").decode(bytes);
  const fieldPattern = "/WAIWindows (";
  const fieldIndex = latin1.indexOf(fieldPattern);
  if (fieldIndex === -1 || latin1.indexOf(fieldPattern, fieldIndex + 1) !== -1) {
    throw new Error("Expected exactly one /WAIWindows field");
  }
  const encoded = new TextEncoder().encode(encodeWindows(ranges));
  bytes.set(encoded, fieldIndex + fieldPattern.length);

  // Sign everything outside the windows; timestamp the digest.
  const outside = outsideBytes(bytes, ranges);
  const digestHex = createHash("sha256").update(outside).digest("hex");
  const sigB64 = toB64url(await signBytes(outside));

  let token = await fetchTimestampToken(digestHex);
  if (!token.ok) token = await fetchTimestampToken(digestHex);
  if (!token.ok || !token.token) {
    throw new TsaUnavailableError(token.error ?? "timestamp authority unreachable");
  }
  const tokenBytes = new Uint8Array(token.token);
  const tstInfo = parseTimeStampResp(tokenBytes)?.tstInfo;
  const reportTimeIso = isoSeconds(tstInfo?.genTime ?? new Date().toISOString());

  const inputs: ReportSigInputs = {
    captureId,
    videoHashHex: capture.hash,
    digestHex,
    sigB64,
    pubB64: signer.publicKeyB64,
    captureTimeIso,
    reportTimeIso,
  };
  const fills: Array<[Uint8Array, [number, number]]> = [
    [deriveWindowA(canonicalPayload(inputs)), winA],
    [deriveWindowB(inputs), winB],
    [deriveWindowC(inputs, toHex(tokenBytes, 0, tokenBytes.length)), winC],
  ];
  for (const [content, [start, end]] of fills) {
    if (content.length !== end - start) {
      throw new Error(`Derived window length ${content.length} != reserved ${end - start}`);
    }
    bytes.set(content, start);
  }

  const target = reportPath(captureId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, target);

  await updateCapture(captureId, (r) => ({
    ...r,
    report: { status: "ready", generatedAt: new Date().toISOString(), digest: digestHex },
  }));
  return target;
}
