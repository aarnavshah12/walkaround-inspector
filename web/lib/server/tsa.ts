// RFC 3161 timestamping of the capture hash. The TimeStampReq is a small,
// fixed-shape DER structure, so it's encoded by hand rather than pulling in
// an ASN.1 dependency:
//
//   TimeStampReq ::= SEQUENCE {
//     version        INTEGER 1,
//     messageImprint SEQUENCE {
//       hashAlgorithm  AlgorithmIdentifier (sha256 OID + NULL params),
//       hashedMessage  OCTET STRING (32 bytes) },
//     nonce          INTEGER,
//     certReq        BOOLEAN TRUE }
//
// The response token (.tsr) is stored verbatim; deep parsing/verification is
// the Phase 6 verifier's job. Here we only check the PKIStatus is
// granted (0) or grantedWithMods (1).

import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { DATA_DIR, TSA_TIMEOUT_MS, TSA_URL } from "./config";
import { isValidCaptureId } from "./store";
import { parseTimeStampResp } from "../der";

const TOKENS_DIR = path.join(DATA_DIR, "captures");

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

/** Positive INTEGER, minimal DER: strip leading zero bytes, then pad one
 * back only if the high bit would read as a sign bit. */
function derInteger(value: Buffer): Buffer {
  let v = value;
  while (v.length > 1 && v[0] === 0x00) v = v.subarray(1);
  const needsPad = v.length === 0 || v[0] >= 0x80;
  return tlv(0x02, needsPad ? Buffer.concat([Buffer.from([0]), v]) : v);
}

// OID 2.16.840.1.101.3.4.2.1 (sha256)
const SHA256_OID = Buffer.from([
  0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
]);
const DER_NULL = Buffer.from([0x05, 0x00]);

export function buildTimeStampReq(hashHex: string): Buffer {
  const hash = Buffer.from(hashHex, "hex");
  if (hash.length !== 32) throw new Error("Expected a 32-byte SHA-256 hash");
  const algorithmId = tlv(0x30, Buffer.concat([SHA256_OID, DER_NULL]));
  const messageImprint = tlv(0x30, Buffer.concat([algorithmId, tlv(0x04, hash)]));
  const version = derInteger(Buffer.from([0x01]));
  const nonce = derInteger(randomBytes(8));
  const certReq = Buffer.from([0x01, 0x01, 0xff]); // BOOLEAN TRUE
  return tlv(0x30, Buffer.concat([version, messageImprint, nonce, certReq]));
}

/** PKIStatus of a TimeStampResp via the shared DER module, or null if the
 * bytes don't look like a TimeStampResp. */
export function parsePkiStatus(resp: Buffer): number | null {
  return parseTimeStampResp(new Uint8Array(resp))?.status ?? null;
}

export function tokenPath(captureId: string): string {
  if (!isValidCaptureId(captureId)) throw new Error("Invalid capture id");
  return path.join(TOKENS_DIR, `${captureId}.tsr`);
}

export interface TsaResult {
  ok: boolean;
  error?: string;
}

export interface TokenResult {
  ok: boolean;
  token?: Buffer;
  error?: string;
}

/** Fetch a granted RFC 3161 token for a SHA-256 hex digest. Never throws —
 * failures come back as { ok: false }. Used both for capture hashes and
 * (Phase 6) for signed-report digests. */
export async function fetchTimestampToken(hashHex: string): Promise<TokenResult> {
  try {
    const req = buildTimeStampReq(hashHex);
    const res = await fetch(TSA_URL, {
      method: "POST",
      headers: { "content-type": "application/timestamp-query" },
      body: new Uint8Array(req),
      signal: AbortSignal.timeout(TSA_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `TSA HTTP ${res.status}` };
    const body = Buffer.from(await res.arrayBuffer());
    const status = parsePkiStatus(body);
    if (status !== 0 && status !== 1) {
      return { ok: false, error: `TSA PKIStatus ${status ?? "unparseable"}` };
    }
    return { ok: true, token: body };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Request a timestamp token for the capture's hash and persist the raw
 * TimeStampResp next to the capture record. */
export async function requestTimestamp(
  captureId: string,
  hashHex: string
): Promise<TsaResult> {
  const result = await fetchTimestampToken(hashHex);
  if (!result.ok || !result.token) return { ok: false, error: result.error };
  try {
    await fs.mkdir(TOKENS_DIR, { recursive: true });
    await fs.writeFile(tokenPath(captureId), result.token);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
