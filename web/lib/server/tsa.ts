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

/** Positive INTEGER encoding (leading zero when the high bit is set). */
function derInteger(value: Buffer): Buffer {
  const needsPad = value.length === 0 || value[0] >= 0x80;
  return tlv(0x02, needsPad ? Buffer.concat([Buffer.from([0]), value]) : value);
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

/** Minimal DER walk: TimeStampResp ::= SEQUENCE { status PKIStatusInfo, ... }
 * where PKIStatusInfo ::= SEQUENCE { status INTEGER, ... }. Returns the
 * PKIStatus value, or null if the bytes don't look like a TimeStampResp. */
export function parsePkiStatus(resp: Buffer): number | null {
  const readHeader = (
    buf: Buffer,
    offset: number
  ): { tag: number; length: number; contentStart: number } | null => {
    if (offset + 2 > buf.length) return null;
    const tag = buf[offset];
    let length = buf[offset + 1];
    let contentStart = offset + 2;
    if (length & 0x80) {
      const numBytes = length & 0x7f;
      if (numBytes === 0 || numBytes > 4 || contentStart + numBytes > buf.length) return null;
      length = 0;
      for (let i = 0; i < numBytes; i++) length = length * 256 + buf[contentStart + i];
      contentStart += numBytes;
    }
    return { tag, length, contentStart };
  };

  const outer = readHeader(resp, 0);
  if (!outer || outer.tag !== 0x30) return null;
  const statusInfo = readHeader(resp, outer.contentStart);
  if (!statusInfo || statusInfo.tag !== 0x30) return null;
  const statusInt = readHeader(resp, statusInfo.contentStart);
  if (!statusInt || statusInt.tag !== 0x02 || statusInt.length < 1) return null;
  return resp[statusInt.contentStart];
}

export function tokenPath(captureId: string): string {
  if (!isValidCaptureId(captureId)) throw new Error("Invalid capture id");
  return path.join(TOKENS_DIR, `${captureId}.tsr`);
}

export interface TsaResult {
  ok: boolean;
  error?: string;
}

/** Request a timestamp token for the capture's hash and persist the raw
 * TimeStampResp next to the capture record. Never throws — failures come
 * back as { ok: false } so the capture POST stays fast and unconditional. */
export async function requestTimestamp(
  captureId: string,
  hashHex: string
): Promise<TsaResult> {
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
    await fs.mkdir(TOKENS_DIR, { recursive: true });
    await fs.writeFile(tokenPath(captureId), body);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
