// Canonical byte formats shared by the report signer and the verifier.
//
// The signed PDF reserves three fixed-length "windows" whose bytes depend on
// the signature itself (and so can't be covered by it directly). Both sides
// derive window contents from the same functions here: the generator fills
// the windows with derived bytes; the verifier re-derives and memcmps. Every
// field has a fixed width, so derived output length is constant — the
// invariant the whole scheme rests on.

import qrcodegen from "qrcode-generator";

/** Bump on any change to window layouts or the payload format. */
export const SIG_FORMAT_VERSION = 1;

/** Pinned QR version: 85×85 modules — capacity (byte mode, ECC M) far above
 * the ~430-char payload. Changing this changes Window A's length. */
export const QR_TYPE_NUMBER = 17;
export const QR_MODULES = 17 + 4 * QR_TYPE_NUMBER; // 85
export const QR_ECC: "M" = "M";

/** Fixed field widths (bytes/chars). */
export const SIG_B64_LEN = 86; // raw P-256 r‖s (64 bytes) → b64url
export const PUB_B64_LEN = 87; // uncompressed point (65 bytes) → b64url
export const HASH_B64_LEN = 43; // 32 bytes → b64url
export const HASH_HEX_LEN = 64;
export const ISO_SECONDS_LEN = 20; // "2026-08-06T00:45:37Z"
export const UUID_LEN = 36;
/** Hex capacity reserved for the report's RFC 3161 token (~8 KB DER). */
export const TSR_HEX_CAP = 16384;

export const SENTINEL_A = "WAI-WIN-A";
export const SENTINEL_B = "WAI-WIN-B";
export const SENTINEL_C = "WAI-WIN-C";

export interface ReportSigInputs {
  captureId: string; // UUID, 36 chars
  videoHashHex: string; // 64 hex
  digestHex: string; // 64 hex — SHA-256 of the "outside" bytes
  /** SHA-256 of the report's RFC 3161 token bytes, 64 hex. The ECDSA
   * signature is computed over digest‖tsrDigest (64 raw bytes), binding the
   * token — which lives inside a window — to the signature. */
  tsrDigestHex: string;
  sigB64: string; // 86 chars
  pubB64: string; // 87 chars
  captureTimeIso: string; // 20 chars, seconds precision, Z
  reportTimeIso: string; // 20 chars, seconds precision, Z
}

export function toB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const base64 = (typeof btoa === "function" ? btoa(bin) : Buffer.from(bytes).toString("base64"));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const bin = typeof atob === "function" ? atob(padded) : Buffer.from(padded, "base64").toString("binary");
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function hexToB64url(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return toB64url(bytes);
}

/** Normalize an ISO timestamp to fixed 20-char seconds precision UTC. */
export function isoSeconds(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Unparseable timestamp: ${iso}`);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function assertLen(name: string, value: string, expected: number): void {
  if (value.length !== expected) {
    throw new Error(`${name} must be ${expected} chars, got ${value.length}`);
  }
}

function validate(i: ReportSigInputs): void {
  assertLen("captureId", i.captureId, UUID_LEN);
  assertLen("videoHashHex", i.videoHashHex, HASH_HEX_LEN);
  assertLen("digestHex", i.digestHex, HASH_HEX_LEN);
  assertLen("tsrDigestHex", i.tsrDigestHex, HASH_HEX_LEN);
  assertLen("sigB64", i.sigB64, SIG_B64_LEN);
  assertLen("pubB64", i.pubB64, PUB_B64_LEN);
  assertLen("captureTimeIso", i.captureTimeIso, ISO_SECONDS_LEN);
  assertLen("reportTimeIso", i.reportTimeIso, ISO_SECONDS_LEN);
}

/** The 64-byte message the ECDSA signature is computed over. */
export function signatureMessage(digestHex: string, tsrDigestHex: string): Uint8Array {
  const out = new Uint8Array(64);
  for (let i = 0; i < 32; i++) out[i] = parseInt(digestHex.slice(i * 2, i * 2 + 2), 16);
  for (let i = 0; i < 32; i++) out[32 + i] = parseInt(tsrDigestHex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Canonical QR/payload JSON — fixed key order, fixed-width values, no
 * whitespace. Because every value has fixed width, the result has constant
 * length. */
export function canonicalPayload(i: ReportSigInputs): string {
  validate(i);
  return (
    `{"v":${SIG_FORMAT_VERSION},"t":"wai1"` +
    `,"cid":"${i.captureId}"` +
    `,"vh":"${hexToB64url(i.videoHashHex)}"` +
    `,"dg":"${hexToB64url(i.digestHex)}"` +
    `,"th":"${hexToB64url(i.tsrDigestHex)}"` +
    `,"sig":"${i.sigB64}"` +
    `,"pub":"${i.pubB64}"` +
    `,"ct":"${i.captureTimeIso}"` +
    `,"rt":"${i.reportTimeIso}"}`
  );
}

/** Window A: raw grayscale pixel bytes of the QR (1 byte per module,
 * 0x00 dark / 0xff light). Length is QR_MODULES² regardless of payload. */
export function deriveWindowA(payload: string): Uint8Array {
  const qr = qrcodegen(QR_TYPE_NUMBER, QR_ECC);
  qr.addData(payload, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  if (n !== QR_MODULES) throw new Error(`QR module count ${n} != ${QR_MODULES}`);
  const out = new Uint8Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      out[r * n + c] = qr.isDark(r, c) ? 0x00 : 0xff;
    }
  }
  return out;
}

/** Window B: the last page's dynamic text content stream — signature (two
 * fixed lines), report digest, report timestamp. All fields fixed width. */
export function deriveWindowB(i: ReportSigInputs): Uint8Array {
  validate(i);
  const text =
    `BT\n/WAIF 8 Tf\n11 TL\n56 210 Td\n` +
    `(${i.sigB64.slice(0, 43)}) Tj\nT*\n` +
    `(${i.sigB64.slice(43)}) Tj\nT*\n` +
    `(${i.digestHex}) Tj\nT*\n` +
    `(${i.reportTimeIso}) Tj\nET\n`;
  return new TextEncoder().encode(text);
}

/** Window C: machine-readable payload block — the canonical JSON plus the
 * report's RFC 3161 token as hex, space-padded to TSR_HEX_CAP. */
export function deriveWindowC(i: ReportSigInputs, reportTsrHex: string): Uint8Array {
  validate(i);
  if (reportTsrHex.length > TSR_HEX_CAP) {
    throw new Error(`Report TSR too large: ${reportTsrHex.length} hex chars > ${TSR_HEX_CAP}`);
  }
  const text =
    `WAI-SIG-PAYLOAD/1\n${canonicalPayload(i)}\nTSR:` +
    reportTsrHex.padEnd(TSR_HEX_CAP, " ") +
    `\n`;
  return new TextEncoder().encode(text);
}

/** Dummy inputs with correct field widths — used to size the placeholder
 * windows at layout time (derived lengths are input-independent). */
export function dummyInputs(): ReportSigInputs {
  return {
    captureId: "00000000-0000-4000-8000-000000000000",
    videoHashHex: "0".repeat(HASH_HEX_LEN),
    digestHex: "0".repeat(HASH_HEX_LEN),
    tsrDigestHex: "0".repeat(HASH_HEX_LEN),
    sigB64: "A".repeat(SIG_B64_LEN),
    pubB64: "A".repeat(PUB_B64_LEN),
    captureTimeIso: "2026-01-01T00:00:00Z",
    reportTimeIso: "2026-01-01T00:00:00Z",
  };
}

/** Fixed-width window-offsets record embedded (signed) in /WAIVerify:
 * six 10-digit numbers "s1 e1 s2 e2 s3 e3". */
export const WINDOWS_FIELD_LEN = 6 * 10 + 5;

export function encodeWindows(ranges: Array<[number, number]>): string {
  const flat = ranges.flat();
  if (flat.length !== 6) throw new Error("Expected exactly 3 windows");
  const text = flat.map((n) => String(n).padStart(10, "0")).join(" ");
  if (text.length !== WINDOWS_FIELD_LEN) throw new Error("Windows field length mismatch");
  return text;
}

export function decodeWindows(text: string): Array<[number, number]> | null {
  const m = /^(\d{10}) (\d{10}) (\d{10}) (\d{10}) (\d{10}) (\d{10})$/.exec(text);
  if (!m) return null;
  const n = m.slice(1).map(Number);
  const ranges: Array<[number, number]> = [
    [n[0], n[1]],
    [n[2], n[3]],
    [n[4], n[5]],
  ];
  let prev = 0;
  for (const [s, e] of ranges) {
    if (!(s >= prev && e > s)) return null;
    prev = e;
  }
  return ranges;
}
